package cli

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

type notifyingConn struct {
	net.Conn
	started chan struct{}
	once    sync.Once
}

func (c *notifyingConn) Write(data []byte) (int, error) {
	c.once.Do(func() { close(c.started) })
	return c.Conn.Write(data)
}

func TestRequestContextStopsWaitingWhenCanceled(t *testing.T) {
	clientConn, daemonConn := net.Pipe()
	defer clientConn.Close()
	defer daemonConn.Close()
	client := &Client{conn: clientConn}
	requestReceived := make(chan struct{})
	go func() {
		_, _ = protocol.ReadEnvelope(daemonConn)
		close(requestReceived)
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := client.RequestContext(ctx, "zen-01", ExtCommand{Cmd: "tabs.list"})
		done <- err
	}()

	select {
	case <-requestReceived:
	case <-time.After(time.Second):
		t.Fatal("request was not sent")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("RequestContext error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("request ignored cancellation")
	}
}

func TestRequestContextStopsBlockedWriteWhenCanceled(t *testing.T) {
	clientConn, daemonConn := net.Pipe()
	defer clientConn.Close()
	defer daemonConn.Close()
	conn := &notifyingConn{Conn: clientConn, started: make(chan struct{})}
	client := &Client{conn: conn}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := client.RequestContext(ctx, "zen-01", ExtCommand{Cmd: "tabs.list"})
		done <- err
	}()
	select {
	case <-conn.started:
	case <-time.After(time.Second):
		t.Fatal("request write did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("RequestContext error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("request write ignored cancellation")
	}
}
