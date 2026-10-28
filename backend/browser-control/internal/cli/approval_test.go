package cli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// stubNotify installs a notify.sh that records each invocation's arguments, one line per call
func stubNotify(t *testing.T, script string) (string, string) {
	t.Helper()
	state, err := os.MkdirTemp("/tmp", "bc-approval-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(state) })
	t.Setenv("XDG_STATE_HOME", state)
	if err := os.MkdirAll(filepath.Join(state, "browser-control"), 0o700); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(state, "notifications")
	if script == "" {
		script = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BC_TEST_NOTIFY_FILE\"\n"
	}
	if err := os.WriteFile(filepath.Join(state, "notify.sh"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", state)
	t.Setenv("BC_TEST_NOTIFY_FILE", output)
	return state, output
}

// approvalID reads the request ID from the --on-click command once the notification is sent
func approvalID(t *testing.T, output string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, _ := os.ReadFile(output)
		if _, command, ok := strings.Cut(string(data), "--on-click "); ok {
			words := strings.Fields(command)
			if len(words) >= 4 {
				return strings.Trim(words[3], "'")
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("approval notification not sent")
	return ""
}

func TestAwaitWindowApproval(t *testing.T) {
	t.Run("点击通知后等待结束并清理请求套接字", func(t *testing.T) {
		state, output := stubNotify(t, "")
		done := make(chan error, 1)
		go func() { done <- AwaitWindowApproval("zen-01", "zen", 5*time.Second) }()
		id := approvalID(t, output)
		if err := ApproveWindow(id); err != nil {
			t.Fatal(err)
		}
		if err := <-done; err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(output)
		if !strings.Contains(string(data), "--group browser-control-agent-window-zen-01") ||
			!strings.Contains(string(data), "'agent-window' 'approve'") || !strings.Contains(string(data), "its zen agent window") {
			t.Fatalf("notification = %q", data)
		}
		if matches, _ := filepath.Glob(filepath.Join(state, "browser-control", "agent-window-ask-*")); len(matches) != 0 {
			t.Fatalf("leftover sockets = %v", matches)
		}
	})

	t.Run("超时未批准时返回结构化错误", func(t *testing.T) {
		state, _ := stubNotify(t, "")
		err := AwaitWindowApproval("zen-01", "zen", 50*time.Millisecond)
		var commandError *CommandError
		if !errors.As(err, &commandError) || commandError.Code != "AGENT_WINDOW_APPROVAL_TIMEOUT" {
			t.Fatalf("error = %v", err)
		}
		if matches, _ := filepath.Glob(filepath.Join(state, "browser-control", "agent-window-ask-*")); len(matches) != 0 {
			t.Fatalf("leftover sockets = %v", matches)
		}
	})

	t.Run("通知发送失败时不等待", func(t *testing.T) {
		stubNotify(t, "#!/bin/sh\nexit 3\n")
		start := time.Now()
		if err := AwaitWindowApproval("zen-01", "zen", 5*time.Second); err == nil {
			t.Fatal("expected notification error")
		}
		if time.Since(start) > 2*time.Second {
			t.Fatal("waited despite failed notification")
		}
	})
}

func TestApproveWindow(t *testing.T) {
	t.Run("请求已结束时报错并通知过期", func(t *testing.T) {
		_, output := stubNotify(t, "")
		if err := ApproveWindow("0123456789abcdef"); err == nil {
			t.Fatal("expected expired request error")
		}
		data, _ := os.ReadFile(output)
		if !strings.Contains(string(data), "expired") {
			t.Fatalf("notification = %q", data)
		}
	})

	t.Run("拒绝非法请求 ID", func(t *testing.T) {
		stubNotify(t, "")
		for _, id := range []string{"", "../x", "0123456789ABCDEF", "abc"} {
			if err := ApproveWindow(id); err == nil {
				t.Fatalf("accepted %q", id)
			}
		}
	})
}
