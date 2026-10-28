package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSessionOpenArgs(t *testing.T) {
	t.Run("标签参数优先于环境变量", func(t *testing.T) {
		t.Setenv("BROWSER_CONTROL_LABEL", "from env")
		command := newSessionBeginCmd()
		if err := command.Flags().Set("label", "claude: fix login"); err != nil {
			t.Fatal(err)
		}
		args, err := sessionOpenArgs(command)
		if err != nil || args["label"] != "claude: fix login" {
			t.Fatalf("args = %v, error = %v", args, err)
		}
	})
	t.Run("未指定标签时读取环境变量", func(t *testing.T) {
		t.Setenv("BROWSER_CONTROL_LABEL", "codex review")
		args, err := sessionOpenArgs(newSessionBeginCmd())
		if err != nil || args["label"] != "codex review" {
			t.Fatalf("args = %v, error = %v", args, err)
		}
	})
	t.Run("没有标签时不发送字段", func(t *testing.T) {
		t.Setenv("BROWSER_CONTROL_LABEL", "")
		args, err := sessionOpenArgs(newSessionBeginCmd())
		if _, ok := args["label"]; err != nil || ok {
			t.Fatalf("args = %v, error = %v", args, err)
		}
	})
	t.Run("非正租约时长被拒绝", func(t *testing.T) {
		command := newSessionBeginCmd()
		if err := command.Flags().Set("ttl", "0s"); err != nil {
			t.Fatal(err)
		}
		if _, err := sessionOpenArgs(command); err == nil {
			t.Fatal("expected ttl error")
		}
	})
}

func TestSessionBeginOutput(t *testing.T) {
	response := json.RawMessage(`{"ok":true,"data":{"sessionId":"ab12cd34","expiresAt":5}}`)
	t.Run("纯文本输出带浏览器名前缀", func(t *testing.T) {
		got, err := sessionBeginOutput(response, "zen-11", false)
		if err != nil || got != "zen:ab12cd34" {
			t.Fatalf("got %q, %v", got, err)
		}
	})
	t.Run("JSON 输出改写 sessionId 并保留其他字段", func(t *testing.T) {
		got, err := sessionBeginOutput(response, "zen-11", true)
		if err != nil {
			t.Fatal(err)
		}
		var decoded struct {
			OK   bool `json:"ok"`
			Data struct {
				SessionID string  `json:"sessionId"`
				ExpiresAt float64 `json:"expiresAt"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(got), &decoded); err != nil || !decoded.OK ||
			decoded.Data.SessionID != "zen:ab12cd34" || decoded.Data.ExpiresAt != 5 {
			t.Fatalf("got %s, %v", got, err)
		}
	})
	t.Run("缺少 sessionId 时报错", func(t *testing.T) {
		if _, err := sessionBeginOutput(json.RawMessage(`{"data":{}}`), "zen-11", false); err == nil {
			t.Fatal("expected error")
		}
	})
}

func TestAgentWindowCreateAsk(t *testing.T) {
	missing := json.RawMessage(`{"cmd":"error","error":{"code":"AGENT_WINDOW_MISSING","message":"The agent window marker tab was closed"}}`)
	live := json.RawMessage(`{"cmd":"agentWindow.status","data":{"windowId":7,"markerTabId":9}}`)
	created := json.RawMessage(`{"cmd":"agentWindow.create","data":{"windowId":8,"markerTabId":10}}`)
	for _, test := range []struct {
		name         string
		status       json.RawMessage
		approval     error
		wantCommands []string
		wantAsked    bool
		wantOutput   string
		wantError    string
	}{
		{name: "已有代理窗口时直接返回状态且不请求批准", status: live,
			wantCommands: []string{"agentWindow.status"}, wantOutput: `"windowId":7`},
		{name: "窗口缺失时经批准后创建窗口", status: missing, wantAsked: true,
			wantCommands: []string{"agentWindow.status", "agentWindow.create"}, wantOutput: `"windowId":8`},
		{name: "未获批准时不创建窗口", status: missing, approval: errors.New("AGENT_WINDOW_APPROVAL_TIMEOUT"), wantAsked: true,
			wantCommands: []string{"agentWindow.status"}, wantError: "AGENT_WINDOW_APPROVAL_TIMEOUT"},
	} {
		t.Run(test.name, func(t *testing.T) {
			requests := startBrowsers(t, 1, func(command string) json.RawMessage {
				if command == "agentWindow.status" {
					return test.status
				}
				return created
			})
			binDir := t.TempDir()
			if err := os.WriteFile(filepath.Join(binDir, "notify.sh"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", binDir)
			var asked []string
			oldAwait := awaitWindowApproval
			awaitWindowApproval = func(target, browserName string, timeout time.Duration) error {
				asked = append(asked, target, browserName, timeout.String())
				return test.approval
			}
			command, _, err := rootCmd.Find([]string{"agent-window", "create"})
			if err != nil {
				t.Fatal(err)
			}
			oldBrowser := flagBrowser
			flagBrowser = ""
			t.Cleanup(func() {
				awaitWindowApproval, flagBrowser = oldAwait, oldBrowser
				_ = command.Flags().Set("ask", "false")
				command.SetOut(nil)
			})
			if err := command.Flags().Set("ask", "true"); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			command.SetOut(&out)
			err = command.RunE(command, nil)
			if test.wantError != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantError) {
					t.Fatalf("error = %v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			var commands []string
			for range test.wantCommands {
				commands = append(commands, (<-requests).Cmd)
			}
			select {
			case extra := <-requests:
				t.Fatalf("unexpected command %s", extra.Cmd)
			default:
			}
			if strings.Join(commands, ",") != strings.Join(test.wantCommands, ",") {
				t.Fatalf("commands = %v", commands)
			}
			if test.wantAsked != (len(asked) > 0) {
				t.Fatalf("asked = %v", asked)
			}
			if test.wantAsked && strings.Join(asked, ",") != "zen-01,zen,9m0s" {
				t.Fatalf("approval args = %v", asked)
			}
			if !strings.Contains(out.String(), test.wantOutput) {
				t.Fatalf("output = %q", out.String())
			}
		})
	}
}
