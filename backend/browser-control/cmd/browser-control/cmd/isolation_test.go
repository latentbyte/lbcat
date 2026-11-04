package cmd

import (
	"bytes"
	"encoding/json"
	"github.com/spf13/cobra"
	"io"
	"strconv"
	"strings"
	"testing"
)

func TestAgentDefaults(t *testing.T) {
	t.Run("新标签默认保持后台", func(t *testing.T) {
		active, err := tabsCreateCmd.Flags().GetBool("active")
		if err != nil || active {
			t.Fatalf("active = %v, error = %v", active, err)
		}
	})
	t.Run("前台操作必须显式授权", func(t *testing.T) {
		foreground, err := tabsFocusCmd.Flags().GetBool("foreground")
		if err != nil || foreground {
			t.Fatalf("foreground = %v, error = %v", foreground, err)
		}
		screenshotForeground, err := pageScreenshotCmd.Flags().GetBool("foreground")
		if err != nil || screenshotForeground {
			t.Fatalf("foreground = %v, error = %v", screenshotForeground, err)
		}
	})
	t.Run("配置会话可从环境读取", func(t *testing.T) {
		old := flagSession
		flagSession = ""
		defer func() { flagSession = old }()
		t.Setenv("BROWSER_CONTROL_SESSION", "task-env")
		if got := sessionFromFlag(); got != "task-env" {
			t.Fatalf("session = %q", got)
		}
		flagSession = "task-explicit"
		if got := sessionFromFlag(); got != "task-explicit" {
			t.Fatalf("session = %q", got)
		}
	})
}

func TestAgentCommandPayloads(t *testing.T) {
	for _, test := range []struct {
		name           string
		commandName    string
		args           []string
		expectedRemote string
		session        string
		flags          map[string]string
	}{
		{name: "创建窗口保持管理命令独立", commandName: "create", expectedRemote: "agentWindow.create"},
		{name: "指定窗口发送精确ID", commandName: "designate", args: []string{"17"}, expectedRemote: "agentWindow.designate"},
		{name: "开始会话输出可用于后续命令的ID", commandName: "begin", expectedRemote: "sessions.open"},
		{name: "认领标签发送任务ID", commandName: "claim", args: []string{"42"}, expectedRemote: "sessions.claim", session: "task-123"},
		{name: "结束会话发送任务ID", commandName: "end", args: []string{"task-123"}, expectedRemote: "sessions.close"},
		{name: "结束会话可关闭任务标签", commandName: "end", args: []string{"task-123"}, flags: map[string]string{"close-tabs": "true"}, expectedRemote: "sessions.close"},
	} {
		t.Run(test.name, func(t *testing.T) {
			oldSession := flagSession
			flagSession = test.session
			t.Cleanup(func() { flagSession = oldSession })
			responses := map[string]json.RawMessage{test.expectedRemote: json.RawMessage(`{"data":{"sessionId":"task-new","windowId":17}}`)}
			result := startPageCommandDaemon(t, responses)
			command := newAgentWindowCmd()
			if strings.HasPrefix(test.expectedRemote, "sessions.") {
				command = newSessionCmd()
			}
			child, _, err := command.Find([]string{test.commandName})
			if err != nil {
				t.Fatal(err)
			}
			child.SetOut(io.Discard)
			for name, value := range test.flags {
				if err := child.Flags().Set(name, value); err != nil {
					t.Fatal(err)
				}
			}
			if err := child.RunE(child, test.args); err != nil {
				t.Fatal(err)
			}
			requests := waitPageCommandRequests(t, result)
			if len(requests) != 1 || requests[0].Cmd != test.expectedRemote {
				t.Fatalf("requests = %#v", requests)
			}
			var sentArgs map[string]any
			if err := json.Unmarshal(requests[0].Args, &sentArgs); err != nil && len(requests[0].Args) != 0 {
				t.Fatal(err)
			}
			if test.expectedRemote == "sessions.claim" && sentArgs["sessionId"] != "task-123" {
				t.Fatalf("args = %#v", requests[0].Args)
			}
			if test.commandName == "end" && (sentArgs["closeTabs"] == true) != (test.flags["close-tabs"] == "true") {
				t.Fatalf("args = %#v", requests[0].Args)
			}
			if test.commandName == "designate" && sentArgs["windowId"] != float64(17) {
				t.Fatalf("args = %#v", requests[0].Args)
			}
		})
	}
}

func TestScopedPageCommandPayload(t *testing.T) {
	t.Run("页面命令发送会话与个人标签精确授权", func(t *testing.T) {
		oldSession, oldPersonal := flagSession, flagPersonalTab
		flagSession, flagPersonalTab = "task-123", 42
		defer func() { flagSession, flagPersonalTab = oldSession, oldPersonal }()
		result := startPageCommandDaemon(t, map[string]json.RawMessage{"page.content": json.RawMessage(`{"data":""}`)})
		if err := pageContentCmd.RunE(pageContentCmd, []string{"42"}); err != nil {
			t.Fatal(err)
		}
		requests := waitPageCommandRequests(t, result)
		if len(requests) != 2 || requests[0].Cmd != "agentWindow.status" || requests[1].Cmd != "page.content" {
			t.Fatalf("requests = %#v", requests)
		}
		var sentArgs map[string]any
		if err := json.Unmarshal(requests[1].Args, &sentArgs); err != nil {
			t.Fatal(err)
		}
		if sentArgs["sessionId"] != "task-123" || sentArgs["personalTabId"] != float64(42) {
			t.Fatalf("requests = %#v", requests)
		}
	})
}

func TestTabCommandsReturnExtensionErrors(t *testing.T) {
	for _, test := range []struct {
		name    string
		command *cobra.Command
		args    []string
		remote  string
	}{
		{"创建被拒绝时不报告创建成功", tabsCreateCmd, []string{"about:blank"}, "tabs.create"},
		{"读取被拒绝时不输出空标签", tabsGetCmd, []string{"42"}, "tabs.get"},
		{"聚焦被拒绝时不报告聚焦成功", tabsFocusCmd, []string{"42"}, "tabs.focus"},
		{"关闭被拒绝时不报告关闭成功", tabsCloseCmd, []string{"42"}, "tabs.close"},
		{"重新加载被拒绝时返回错误", pageReloadCmd, []string{"42"}, "page.reload"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.command == tabsFocusCmd {
				if err := test.command.Flags().Set("foreground", "true"); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = test.command.Flags().Set("foreground", "false") })
			}
			result := startPageCommandDaemon(t, map[string]json.RawMessage{test.remote: json.RawMessage(`{"cmd":"error","error":{"code":"DENIED","message":"denied"}}`)})
			err := test.command.RunE(test.command, test.args)
			if err == nil || !strings.Contains(err.Error(), "DENIED") {
				t.Fatalf("error = %v", err)
			}
			waitPageCommandRequests(t, result)
		})
	}
}

func TestTabsClose(t *testing.T) {
	t.Run("按顺序关闭多个任务标签并发送会话", func(t *testing.T) {
		oldSession := flagSession
		flagSession = "task-123"
		t.Cleanup(func() { flagSession = oldSession })
		result := startPageCommandDaemon(t, map[string]json.RawMessage{"tabs.close": json.RawMessage(`{"cmd":"tabs.close","data":{"closed":true}}`)})
		var output bytes.Buffer
		tabsCloseCmd.SetOut(&output)
		t.Cleanup(func() { tabsCloseCmd.SetOut(nil) })
		if err := tabsCloseCmd.RunE(tabsCloseCmd, []string{"42", "43"}); err != nil {
			t.Fatal(err)
		}
		var closes []pageCommandRequest
		for _, request := range waitPageCommandRequests(t, result) {
			if request.Cmd == "tabs.close" {
				closes = append(closes, request)
			}
		}
		if len(closes) != 2 {
			t.Fatalf("close requests = %#v", closes)
		}
		for i, want := range []float64{42, 43} {
			var args map[string]any
			if err := json.Unmarshal(closes[i].Args, &args); err != nil {
				t.Fatal(err)
			}
			if args["tabId"] != want || args["sessionId"] != "task-123" {
				t.Fatalf("args = %#v", args)
			}
		}
		if output.String() != "closed tab 42\nclosed tab 43\n" {
			t.Fatalf("output = %q", output.String())
		}
	})
	t.Run("无效标签 ID 在连接前拒绝", func(t *testing.T) {
		if err := tabsCloseCmd.RunE(tabsCloseCmd, []string{"42", "nope"}); err == nil || !strings.Contains(err.Error(), "invalid tab ID") {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestTabCreateForegroundPermission(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "后台创建不授权聚焦", true: "明确激活新标签时发送聚焦授权"}[active], func(t *testing.T) {
			if err := tabsCreateCmd.Flags().Set("active", strconv.FormatBool(active)); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = tabsCreateCmd.Flags().Set("active", "false") })
			result := startPageCommandDaemon(t, map[string]json.RawMessage{"tabs.create": json.RawMessage(`{"data":{"id":42}}`)})
			if err := tabsCreateCmd.RunE(tabsCreateCmd, []string{"about:blank"}); err != nil {
				t.Fatal(err)
			}
			requests := waitPageCommandRequests(t, result)
			if len(requests) != 2 || requests[0].Cmd != "agentWindow.status" || requests[1].Cmd != "tabs.create" {
				t.Fatalf("requests = %#v", requests)
			}
			var args map[string]any
			if err := json.Unmarshal(requests[1].Args, &args); err != nil {
				t.Fatal(err)
			}
			if args["active"] != active || args["allowFocus"] != active {
				t.Fatalf("args = %#v", args)
			}
		})
	}
}

func TestSessionList(t *testing.T) {
	t.Run("列出任务会话供操作者暂停", func(t *testing.T) {
		result := startPageCommandDaemon(t, map[string]json.RawMessage{"sessions.list": json.RawMessage(`{"data":[{"sessionId":"task-123","expiresAt":42,"paused":false,"tabIds":[17],"tabs":[{"id":17,"origin":"https://voice.google.com"}]}]}`)})
		command, _, err := newSessionCmd().Find([]string{"list"})
		if err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		command.SetOut(&output)
		if command.RunE == nil {
			t.Fatal("session list command missing")
		}
		if err := command.RunE(command, nil); err != nil {
			t.Fatal(err)
		}
		requests := waitPageCommandRequests(t, result)
		if len(requests) != 1 || requests[0].Cmd != "sessions.list" {
			t.Fatalf("requests = %#v", requests)
		}
		if !strings.Contains(output.String(), `"tabs":[{"id":17,"origin":"https://voice.google.com"}]`) {
			t.Fatalf("output = %s", output.String())
		}
	})
}

func TestTabsFocusSelectsWithoutForeground(t *testing.T) {
	for _, test := range []struct {
		name       string
		foreground bool
		response   string
		output     string
	}{
		{"未授权前台时只在代理窗口内选中标签", false, `{"cmd":"tabs.focus","data":{"tabId":42,"windowId":7,"windowFocused":false}}`, "selected tab 42 in agent window 7 (window not focused)\n"},
		{"授权前台时聚焦窗口", true, `{"cmd":"tabs.focus","data":{"tabId":42,"windowId":7}}`, "focused tab 42 in window 7\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := tabsFocusCmd.Flags().Set("foreground", strconv.FormatBool(test.foreground)); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = tabsFocusCmd.Flags().Set("foreground", "false") })
			result := startPageCommandDaemon(t, map[string]json.RawMessage{"tabs.focus": json.RawMessage(test.response)})
			var output bytes.Buffer
			tabsFocusCmd.SetOut(&output)
			t.Cleanup(func() { tabsFocusCmd.SetOut(nil) })
			if err := tabsFocusCmd.RunE(tabsFocusCmd, []string{"42"}); err != nil {
				t.Fatal(err)
			}
			var focus *pageCommandRequest
			for _, request := range waitPageCommandRequests(t, result) {
				if request.Cmd == "tabs.focus" {
					focus = &request
				}
			}
			if focus == nil {
				t.Fatal("tabs.focus not sent")
			}
			var sentArgs map[string]any
			if err := json.Unmarshal(focus.Args, &sentArgs); err != nil {
				t.Fatal(err)
			}
			if sentArgs["allowFocus"] != test.foreground {
				t.Fatalf("args = %#v", sentArgs)
			}
			if output.String() != test.output {
				t.Fatalf("output = %q", output.String())
			}
		})
	}
}
