package main

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/protocol"
)

func TestMatchBrowserNameComet(t *testing.T) {
	t.Parallel()

	got := matchBrowserName("/Applications/Comet.app/Contents/MacOS/Comet")
	if got != "comet" {
		t.Fatalf("matchBrowserName(Comet) = %q, want comet", got)
	}
}

func TestNativeHostProcess(t *testing.T) {
	if os.Getenv("BROWSER_CONTROL_SHIM_TEST_PROCESS") != "1" {
		return
	}
	var args []string
	if err := json.Unmarshal([]byte(os.Getenv("BROWSER_CONTROL_SHIM_TEST_ARGS")), &args); err != nil {
		t.Fatal(err)
	}
	os.Args = append([]string{"lbcat-shim"}, args...)
	main()
}

func TestNativeHostArgumentMetadata(t *testing.T) {
	for _, test := range []struct {
		name   string
		args   []string
		wantID string
	}{
		{"Firefox读取第二个参数的扩展ID", []string{"/synthetic/native-host.json", "addon@example.invalid"}, "addon@example.invalid"},
		{"Chrome来源不覆盖清单版本", []string{"chrome-extension://synthetic/"}, "chrome-extension://synthetic/"},
		{"Chrome窗口句柄不作为扩展ID", []string{"chrome-extension://synthetic/", "--parent-window=123"}, "chrome-extension://synthetic/"},
		{"无参数保留环境配置", nil, "env-addon@example.invalid"},
		{"只有Firefox清单路径时保留环境配置", []string{"/synthetic/native-host.json"}, "env-addon@example.invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			state, err := os.MkdirTemp("/tmp", "shim-qa-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(state) })
			t.Setenv("XDG_STATE_HOME", state)
			if err := os.MkdirAll(protocol.StateDir(), 0o700); err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("unix", protocol.SocketPath())
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			handshake := make(chan protocol.Handshake, 1)
			failures := make(chan error, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					failures <- err
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
				data, err := protocol.ReadFrame(conn)
				if err != nil {
					failures <- err
					return
				}
				var hs protocol.Handshake
				if err := json.Unmarshal(data, &hs); err != nil {
					failures <- err
					return
				}
				handshake <- hs
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			encoded, err := json.Marshal(test.args)
			if err != nil {
				t.Fatal(err)
			}
			child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestNativeHostProcess$")
			child.Env = append(os.Environ(), "BROWSER_CONTROL_SHIM_TEST_PROCESS=1", "BROWSER_CONTROL_SHIM_TEST_ARGS="+string(encoded),
				"BROWSER_CONTROL_BROWSER=firefox", "BROWSER_CONTROL_EXTENSION_ID=env-addon@example.invalid", "BROWSER_CONTROL_MANIFEST_VERSION=3", "PATH="+filepath.Join(state, "no-executables"))
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { cancel(); _ = child.Wait() }()
			select {
			case hs := <-handshake:
				if hs.ExtensionID != test.wantID {
					t.Errorf("extension ID = %q, want %q", hs.ExtensionID, test.wantID)
				}
				if hs.ManifestVersion != 3 {
					t.Errorf("manifest version = %d, want configured 3", hs.ManifestVersion)
				}
			case err := <-failures:
				t.Fatal(err)
			case <-ctx.Done():
				t.Fatal("native handshake timed out")
			}
		})
	}
}
