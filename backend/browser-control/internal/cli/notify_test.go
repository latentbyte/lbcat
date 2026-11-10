package cli

import (
	"encoding/json"
	"errors"
	"github.com/latentbyte/lbcat/backend/browser-control/internal/protocol"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestMissingWindowNotification(t *testing.T) {
	t.Run("同一浏览器的一次阻塞仅通知一次且恢复后重新通知", func(t *testing.T) {
		state := t.TempDir()
		t.Setenv("XDG_STATE_HOME", state)
		executable := filepath.Join(state, "notify.sh")
		output := filepath.Join(state, "notifications")
		if err := os.WriteFile(executable, []byte("#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$BC_TEST_NOTIFY_FILE\"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", state)
		t.Setenv("BC_TEST_NOTIFY_FILE", output)
		var wg sync.WaitGroup
		for range 8 {
			wg.Add(1)
			go func() { defer wg.Done(); notifyMissingWindow("zen-01") }()
		}
		wg.Wait()
		data, err := os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Count(string(data), "\n") != 1 {
			t.Fatalf("notifications = %q", data)
		}
		notifyMissingWindow("chrome-01")
		clearMissingWindow("zen-01")
		notifyMissingWindow("zen-01")
		data, err = os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Count(string(data), "\n") != 3 {
			t.Fatalf("notifications = %q", data)
		}
	})
}

func TestMissingWindowPreflightNotification(t *testing.T) {
	t.Run("窗口缺失时先通知且保留原始结构化错误", func(t *testing.T) {
		state := t.TempDir()
		t.Setenv("XDG_STATE_HOME", state)
		output := filepath.Join(state, "notifications")
		if err := os.WriteFile(filepath.Join(state, "notify.sh"), []byte("#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$BC_TEST_NOTIFY_FILE\"\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", state)
		t.Setenv("BC_TEST_NOTIFY_FILE", output)
		local, remote := net.Pipe()
		defer local.Close()
		defer remote.Close()
		client := &Client{conn: local, NotifyMissingWindow: true}
		received := make(chan string, 1)
		go func() {
			request, err := protocol.ReadEnvelope(remote)
			if err != nil {
				return
			}
			var command ExtCommand
			_ = json.Unmarshal(request.Payload, &command)
			received <- command.Cmd
			_ = protocol.WriteEnvelope(remote, &protocol.Envelope{ID: request.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(`{"cmd":"error","error":{"code":"AGENT_WINDOW_MISSING","message":"designate an agent window"}}`)})
		}()
		_, err := client.Request("zen-01", ExtCommand{Cmd: "tabs.get", Args: map[string]any{"tabId": 42}})
		var commandError *CommandError
		if !errors.As(err, &commandError) || commandError.Code != "AGENT_WINDOW_MISSING" {
			t.Fatalf("error = %v", err)
		}
		if got := <-received; got != "agentWindow.status" {
			t.Fatalf("first command = %s", got)
		}
		data, err := os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Count(string(data), "\n") != 1 {
			t.Fatalf("notifications = %q", data)
		}
	})
}

func TestNotificationFailurePreservesBrowserError(t *testing.T) {
	t.Run("通知执行失败不替换窗口缺失错误", func(t *testing.T) {
		state := t.TempDir()
		t.Setenv("XDG_STATE_HOME", state)
		if err := os.WriteFile(filepath.Join(state, "notify.sh"), []byte("#!/bin/sh\nexit 3\n"), 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", state)
		stderr, err := os.CreateTemp(state, "stderr-")
		if err != nil {
			t.Fatal(err)
		}
		defer stderr.Close()
		oldStderr := os.Stderr
		os.Stderr = stderr
		defer func() { os.Stderr = oldStderr }()
		local, remote := net.Pipe()
		defer local.Close()
		defer remote.Close()
		client := &Client{conn: local, NotifyMissingWindow: true}
		go func() {
			request, err := protocol.ReadEnvelope(remote)
			if err != nil {
				return
			}
			_ = protocol.WriteEnvelope(remote, &protocol.Envelope{ID: request.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(`{"error":{"code":"AGENT_WINDOW_MISSING","message":"missing window"}}`)})
		}()
		_, err = client.Request("zen-01", ExtCommand{Cmd: "tabs.get"})
		var commandError *CommandError
		if !errors.As(err, &commandError) || commandError.Code != "AGENT_WINDOW_MISSING" {
			t.Fatalf("error = %v", err)
		}
		data, err := os.ReadFile(stderr.Name())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), "notification failed") {
			t.Fatalf("stderr = %q", data)
		}
	})
}

func TestNotifyWithoutNotifyScript(t *testing.T) {
	// stubTool installs a recording executable as the only thing on PATH, with no notify.sh under HOME
	stubTool := func(t *testing.T, name string) string {
		t.Helper()
		dir := t.TempDir()
		output := filepath.Join(dir, "calls")
		if name != "" {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BC_TEST_NOTIFY_FILE\"\n"), 0o700); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv("PATH", dir)
		t.Setenv("HOME", dir)
		t.Setenv("BC_TEST_NOTIFY_FILE", output)
		return output
	}

	t.Run("没有notify.sh时改用terminal-notifier并转换点击与分组参数", func(t *testing.T) {
		output := stubTool(t, "terminal-notifier")
		if err := runNotify("Title", "Body", "--on-click", "echo hi", "--group", "g1"); err != nil {
			t.Fatal(err)
		}
		data, _ := os.ReadFile(output)
		if strings.TrimSpace(string(data)) != "-title Title -message Body -execute echo hi -group g1" {
			t.Fatalf("terminal-notifier args = %q", data)
		}
	})

	t.Run("两者都没有时报错并说明需要安装terminal-notifier", func(t *testing.T) {
		stubTool(t, "")
		err := runNotify("Title", "Body")
		if err == nil || !strings.Contains(err.Error(), "terminal-notifier") {
			t.Fatalf("error = %v", err)
		}
	})
}
