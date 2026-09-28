package daemon

import (
	"net"
	"os"
	"testing"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

func TestServerListenKeepsActiveSocket(t *testing.T) {
	stateHome, err := os.MkdirTemp("/tmp", "bc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(stateHome) })
	t.Setenv("XDG_STATE_HOME", stateHome)

	first := NewServer()
	if err := first.Listen(); err != nil {
		t.Fatal(err)
	}
	defer first.Shutdown()

	second := NewServer()
	if err := second.Listen(); err == nil {
		second.Shutdown()
		t.Fatal("第二个守护进程不应替换正在使用的 socket")
	}

	conn, err := net.DialTimeout("unix", protocol.SocketPath(), time.Second)
	if err != nil {
		t.Fatalf("第一个守护进程的 socket 应继续可用: %v", err)
	}
	_ = conn.Close()
}

func TestServerListenChecksExistingSocket(t *testing.T) {
	t.Run("旧守护进程的 socket 不被替换", func(t *testing.T) {
		stateHome, err := os.MkdirTemp("/tmp", "bc-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(stateHome) })
		t.Setenv("XDG_STATE_HOME", stateHome)
		if err := os.MkdirAll(protocol.StateDir(), 0o700); err != nil {
			t.Fatal(err)
		}

		listener, err := net.Listen("unix", protocol.SocketPath())
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()

		server := NewServer()
		if err := server.Listen(); err == nil {
			server.Shutdown()
			t.Fatal("不应替换旧守护进程的 socket")
		}
		conn, err := net.DialTimeout("unix", protocol.SocketPath(), time.Second)
		if err != nil {
			t.Fatalf("旧守护进程的 socket 应继续可用: %v", err)
		}
		_ = conn.Close()
	})
}
