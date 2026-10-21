package daemon

import (
	"context"
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

func TestServerServeStopsWithOpenConnections(t *testing.T) {
	t.Run("收到停止信号时关闭活跃连接并清理 socket 与 PID 文件", func(t *testing.T) {
		stateHome, err := os.MkdirTemp("/tmp", "bc-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(stateHome) })
		t.Setenv("XDG_STATE_HOME", stateHome)

		server := NewServer()
		if err := server.Listen(); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		served := make(chan struct{})
		go func() {
			_ = server.Serve(ctx)
			server.Shutdown()
			close(served)
		}()

		// one registered peer and one stuck before its handshake
		peer, err := net.DialTimeout("unix", protocol.SocketPath(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer peer.Close()
		if err := protocol.WriteJSON(peer, &protocol.Handshake{ID: "hs", Type: protocol.MsgHandshake, Role: protocol.RoleCLI}); err != nil {
			t.Fatal(err)
		}
		if _, err := protocol.ReadFrame(peer); err != nil {
			t.Fatal(err)
		}
		silent, err := net.DialTimeout("unix", protocol.SocketPath(), time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer silent.Close()

		cancel()
		select {
		case <-served:
		case <-time.After(2 * time.Second):
			t.Fatal("活跃连接阻塞了守护进程退出")
		}
		if _, err := os.Stat(protocol.PIDPath()); !os.IsNotExist(err) {
			t.Fatalf("PID 文件应被删除: %v", err)
		}
		if _, err := protocol.ReadFrame(peer); err == nil {
			t.Fatal("已注册连接应被关闭")
		}

		next := NewServer()
		if err := next.Listen(); err != nil {
			t.Fatalf("退出后应释放锁供新守护进程启动: %v", err)
		}
		next.Shutdown()
	})
}
