package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/daemon"
	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
)

func startTabListBrowsers(t *testing.T, count int, response json.RawMessage) <-chan pageCommandRequest {
	t.Helper()
	stateDir, err := os.MkdirTemp("/tmp", "bc-human-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(stateDir) })
	t.Setenv("XDG_STATE_HOME", stateDir)
	server := daemon.NewServer()
	server.IdleTimeout = 0
	if err := server.Listen(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = server.Serve(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("test daemon did not stop")
		}
		server.Shutdown()
	})
	requests := make(chan pageCommandRequest, 8)
	for i := 0; i < count; i++ {
		browser, err := net.Dial("unix", protocol.SocketPath())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = browser.Close() })
		if err := protocol.WriteJSON(browser, &protocol.Handshake{Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "zen"}); err != nil {
			t.Fatal(err)
		}
		if _, err := protocol.ReadFrame(browser); err != nil {
			t.Fatal(err)
		}
		go func() {
			for {
				env, err := protocol.ReadEnvelope(browser)
				if err != nil {
					return
				}
				var request pageCommandRequest
				if err := json.Unmarshal(env.Payload, &request); err != nil {
					t.Error(err)
					return
				}
				requests <- request
				payload := response
				if request.Cmd == "agentWindow.status" {
					payload = json.RawMessage(`{"cmd":"error","error":{"code":"AGENT_WINDOW_MISSING","message":"Open or designate the agent window"}}`)
				}
				if err := protocol.WriteEnvelope(browser, &protocol.Envelope{ID: env.ID, Type: protocol.MsgResponse, Payload: payload}); err != nil {
					return
				}
			}
		}()
	}
	return requests
}

func TestHumanTabsList(t *testing.T) {
	for _, test := range []struct {
		name         string
		browser      string
		count        int
		all          bool
		json         bool
		wantError    string
		wantBrowsers int
	}{
		{name: "无需代理窗口即可列出多个窗口的标签", count: 1, json: true, wantBrowsers: 1},
		{name: "文本列表包含标签信息", count: 1, wantBrowsers: 1},
		{name: "显式选择浏览器", count: 2, browser: "zen-02", json: true, wantBrowsers: 1},
		{name: "汇总所有浏览器", count: 2, all: true, json: true, wantBrowsers: 2},
		{name: "浏览器选择优先于汇总选项", count: 2, browser: "zen-02", all: true, json: true, wantBrowsers: 1},
		{name: "多个浏览器未指定目标时拒绝", count: 2, wantError: "multiple browsers connected"},
		{name: "未连接浏览器时报告错误", count: 0, wantError: "no browsers connected"},
	} {
		t.Run(test.name, func(t *testing.T) {
			command, _, err := rootCmd.Find([]string{"human", "tabs", "list"})
			if err != nil || command.RunE == nil || command.CommandPath() != "browser-control human tabs list" {
				t.Fatalf("human tabs list command missing: %v", err)
			}
			oldBrowser, oldJSON, oldSession, oldPersonal := flagBrowser, flagJSON, flagSession, flagPersonalTab
			flagBrowser, flagJSON, flagSession, flagPersonalTab = test.browser, test.json, "task-human", 42
			t.Cleanup(func() {
				flagBrowser, flagJSON, flagSession, flagPersonalTab = oldBrowser, oldJSON, oldSession, oldPersonal
				_ = command.Flags().Set("all-browsers", "false")
				command.SetOut(nil)
			})
			t.Setenv("BROWSER_CONTROL_SESSION", "task-env")
			if test.all {
				if err := command.Flags().Set("all-browsers", "true"); err != nil {
					t.Fatal(err)
				}
			}
			requests := startTabListBrowsers(t, test.count, json.RawMessage(`{"data":[{"id":42,"windowId":7,"title":"Example one","url":"https://example.com/one","active":true},{"id":43,"windowId":9,"title":"Example two","url":"https://example.com/two"}]}`))
			var output bytes.Buffer
			command.SetOut(&output)
			err = command.RunE(command, nil)
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) || output.Len() != 0 || len(requests) != 0 {
					t.Fatalf("error = %v, output = %q, requests = %d", err, output.String(), len(requests))
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(requests) != test.wantBrowsers {
				t.Fatalf("requests = %d, want %d", len(requests), test.wantBrowsers)
			}
			for range test.wantBrowsers {
				request := <-requests
				if request.Cmd != "switcher.tabs.list" {
					t.Fatalf("command = %q", request.Cmd)
				}
				var args map[string]any
				if err := json.Unmarshal(request.Args, &args); err != nil {
					t.Fatal(err)
				}
				for _, field := range []string{"sessionId", "personalTabId", "allowFocus"} {
					if _, exists := args[field]; exists {
						t.Fatalf("human request includes %s", field)
					}
				}
			}
			if !test.json {
				if !strings.Contains(output.String(), "Example one") || !strings.Contains(output.String(), "https://example.com/two") {
					t.Fatalf("text output = %q", output.String())
				}
				return
			}
			var decoded struct {
				Cmd  string      `json:"cmd"`
				Data []model.Tab `json:"data"`
			}
			if err := json.Unmarshal(output.Bytes(), &decoded); err != nil {
				t.Fatal(err)
			}
			if decoded.Cmd != "switcher.tabs.list" || len(decoded.Data) != test.wantBrowsers*2 {
				t.Fatalf("output = %s", output.String())
			}
			if decoded.Data[0].WindowID != 7 || decoded.Data[1].WindowID != 9 {
				t.Fatalf("window metadata = %#v", decoded.Data)
			}
			if test.browser != "" && string(decoded.Data[0].BrowserID) != test.browser {
				t.Fatalf("selected browser = %s", decoded.Data[0].BrowserID)
			}
			if test.wantBrowsers == 2 && decoded.Data[0].BrowserID == decoded.Data[2].BrowserID {
				t.Fatalf("browser identities not distinct: %#v", decoded.Data)
			}
		})
	}
}

func TestTabsListUnicode(t *testing.T) {
	for _, test := range []struct {
		name  string
		title string
		want  string
	}{
		{name: "保留六十个中文字符", title: strings.Repeat("猫", 60), want: strings.Repeat("猫", 60)},
		{name: "保留边界处的完整表情", title: strings.Repeat("a", 56) + "😀end", want: strings.Repeat("a", 56) + "😀end"},
		{name: "按字符截断中文长标题", title: strings.Repeat("猫", 61), want: strings.Repeat("猫", 57) + "..."},
		{name: "按字符截断表情长标题", title: strings.Repeat("😀", 61), want: strings.Repeat("😀", 57) + "..."},
		{name: "保持英文长标题截断规则", title: strings.Repeat("a", 61), want: strings.Repeat("a", 57) + "..."},
	} {
		t.Run(test.name, func(t *testing.T) {
			response, err := json.Marshal(map[string]any{"data": []model.Tab{{ID: 42, Title: test.title, URL: "https://example.com"}}})
			if err != nil {
				t.Fatal(err)
			}
			startTabListBrowsers(t, 1, response)
			command := newTabsListCmd(true)
			var output bytes.Buffer
			command.SetOut(&output)
			if err := command.RunE(command, nil); err != nil {
				t.Fatal(err)
			}
			want := fmt.Sprintf("   %-12s %5d  %-60s  https://example.com\n", "zen-01", 42, test.want)
			if !utf8.Valid(output.Bytes()) || output.String() != want {
				t.Fatalf("text output = %q, want %q", output.String(), want)
			}
		})
	}
}

func TestHumanTabsListErrors(t *testing.T) {
	t.Run("拒绝多余的位置参数", func(t *testing.T) {
		command, _, err := rootCmd.Find([]string{"human", "tabs", "list"})
		if err != nil || command.Args == nil {
			t.Fatal("human tabs list argument validation missing")
		}
		if err := command.Args(command, []string{"unexpected"}); err == nil {
			t.Fatal("extra argument accepted")
		}
	})
	t.Run("扩展不支持切换器时返回原始错误", func(t *testing.T) {
		command, _, err := rootCmd.Find([]string{"human", "tabs", "list"})
		if err != nil || command.RunE == nil {
			t.Fatal("human tabs list command missing")
		}
		startTabListBrowsers(t, 1, json.RawMessage(`{"error":{"code":"UNKNOWN_COMMAND","message":"unsupported switcher command"}}`))
		if err := command.RunE(command, nil); err == nil || !strings.Contains(err.Error(), "UNKNOWN_COMMAND") {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("旧守护进程缺少能力时不发送标签请求", func(t *testing.T) {
		command, _, err := rootCmd.Find([]string{"human", "tabs", "list"})
		if err != nil || command.RunE == nil {
			t.Fatal("human tabs list command missing")
		}
		result := startPageCommandDaemon(t, map[string]json.RawMessage{"status": json.RawMessage(`{"data":{"pid":12}}`)})
		if err := command.RunE(command, nil); err == nil || !strings.Contains(err.Error(), "upgrade browser-control daemon") {
			t.Fatalf("error = %v", err)
		}
		requests := waitPageCommandRequests(t, result)
		if len(requests) != 1 || requests[0].Cmd != "status" {
			t.Fatalf("requests = %#v", requests)
		}
	})
	t.Run("普通列表仍要求代理窗口", func(t *testing.T) {
		requests := startTabListBrowsers(t, 1, json.RawMessage(`{"data":[]}`))
		binDir := t.TempDir()
		if err := os.WriteFile(filepath.Join(binDir, "notify.sh"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", binDir)
		if err := tabsListCmd.RunE(tabsListCmd, nil); err == nil || !strings.Contains(err.Error(), "AGENT_WINDOW_MISSING") {
			t.Fatalf("error = %v", err)
		}
		if len(requests) != 1 || (<-requests).Cmd != "agentWindow.status" {
			t.Fatal("ordinary list did not enforce agent window")
		}
	})
}

func TestHumanTabsClose(t *testing.T) {
	command, _, err := rootCmd.Find([]string{"human", "tabs", "close"})
	if err != nil || command.RunE == nil || command.CommandPath() != "browser-control human tabs close" {
		t.Fatalf("human tabs close command missing: %v", err)
	}
	oldSession, oldPersonal := flagSession, flagPersonalTab
	flagSession, flagPersonalTab = "task-human", 42
	t.Cleanup(func() {
		flagSession, flagPersonalTab = oldSession, oldPersonal
		command.SetOut(nil)
	})
	requests := startTabListBrowsers(t, 1, json.RawMessage(`{"cmd":"switcher.tabs.close","data":{"tabId":42,"closed":true}}`))
	var output bytes.Buffer
	command.SetOut(&output)
	if err := command.RunE(command, []string{"42", "43"}); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 {
		t.Fatalf("requests = %d", len(requests))
	}
	for _, want := range []float64{42, 43} {
		request := <-requests
		var args map[string]any
		if err := json.Unmarshal(request.Args, &args); err != nil {
			t.Fatal(err)
		}
		if request.Cmd != "switcher.tabs.close" || args["tabId"] != want {
			t.Fatalf("request = %s %#v", request.Cmd, args)
		}
		for _, field := range []string{"sessionId", "personalTabId"} {
			if _, exists := args[field]; exists {
				t.Fatalf("human request includes %s", field)
			}
		}
	}
	if output.String() != "closed tab 42\nclosed tab 43\n" {
		t.Fatalf("output = %q", output.String())
	}
}

func TestHumanTabsFocus(t *testing.T) {
	command, _, err := rootCmd.Find([]string{"human", "tabs", "focus"})
	if err != nil || command.RunE == nil || command.CommandPath() != "browser-control human tabs focus" {
		t.Fatalf("human tabs focus command missing: %v", err)
	}
	oldBrowser, oldSession := flagBrowser, flagSession
	flagBrowser, flagSession = "zen-02", "task-human"
	t.Cleanup(func() {
		flagBrowser, flagSession = oldBrowser, oldSession
		command.SetOut(nil)
	})
	requests := startTabListBrowsers(t, 2, json.RawMessage(`{"cmd":"switcher.tabs.focus","data":{"tabId":42,"windowId":3}}`))
	var output bytes.Buffer
	command.SetOut(&output)
	if err := command.RunE(command, []string{"42"}); err != nil {
		t.Fatal(err)
	}
	request := <-requests
	var args map[string]any
	if err := json.Unmarshal(request.Args, &args); err != nil {
		t.Fatal(err)
	}
	if request.Cmd != "switcher.tabs.focus" || args["tabId"] != float64(42) {
		t.Fatalf("request = %s %#v", request.Cmd, args)
	}
	for _, field := range []string{"sessionId", "allowFocus"} {
		if _, exists := args[field]; exists {
			t.Fatalf("human request includes %s", field)
		}
	}
	if output.String() != "focused tab 42 in window 3\n" {
		t.Fatalf("output = %q", output.String())
	}
}
