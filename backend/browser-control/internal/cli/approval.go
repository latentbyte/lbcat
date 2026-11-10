package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/protocol"
)

// windowGroup lets the approval ping replace the earlier missing-window ping
func windowGroup(target string) string { return "browser-control-agent-window-" + target }

func approvalSocket(id string) (string, error) {
	if decoded, err := hex.DecodeString(id); err != nil || len(decoded) != 8 || hex.EncodeToString(decoded) != id {
		return "", fmt.Errorf("invalid approval request ID %q", id)
	}
	return filepath.Join(filepath.Dir(protocol.SocketPath()), "agent-window-ask-"+id+".sock"), nil
}

// AwaitWindowApproval sends a click-to-allow notification and blocks until the human clicks
// it or the timeout passes; the click runs `agent-window approve`, which connects to a
// per-request socket
func AwaitWindowApproval(target, browserName string, timeout time.Duration) error {
	nonce := make([]byte, 8)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	id := hex.EncodeToString(nonce)
	path, err := approvalSocket(id)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return fmt.Errorf("listening for approval: %w", err)
	}
	defer listener.Close()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	approve := shellJoin(executable, "agent-window", "approve", id)
	if err := runNotify("Agent browser window", "An agent wants to reopen its "+browserName+" agent window. Click to allow.",
		"--on-click", approve, "--group", windowGroup(target)); err != nil {
		return err
	}
	// close the listener on timeout or signal so the socket file is removed
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	conn, err := listener.Accept()
	if err == nil {
		return conn.Close()
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return &CommandError{Code: "AGENT_WINDOW_APPROVAL_TIMEOUT", Message: fmt.Sprintf(
			"nobody approved reopening the agent window within %s (approval needs a notification click, which requires terminal-notifier)", timeout)}
	}
	if ctx.Err() != nil {
		return fmt.Errorf("approval wait interrupted")
	}
	return fmt.Errorf("waiting for approval: %w", err)
}

// ApproveWindow releases a waiting AwaitWindowApproval; notification clicks run it
func ApproveWindow(id string) error {
	path, err := approvalSocket(id)
	if err != nil {
		return err
	}
	conn, err := net.DialTimeout("unix", path, time.Second)
	if err != nil {
		_ = runNotify("Agent browser window", "That agent window request expired; ask the agent to retry.")
		return fmt.Errorf("approval request %s is no longer waiting", id)
	}
	return conn.Close()
}
