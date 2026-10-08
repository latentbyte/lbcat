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

func TestRequestContextStopsWaitingForQueuedRequest(t *testing.T) {
	for _, test := range []struct {
		name     string
		deadline bool
	}{
		{"排队请求取消时立即返回且不影响正在执行的请求", false},
		{"排队请求超时时立即返回且不影响正在执行的请求", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			clientConn, daemonConn := net.Pipe()
			defer clientConn.Close()
			defer daemonConn.Close()
			client := &Client{conn: clientConn}
			firstDone := make(chan error, 1)
			go func() {
				_, err := client.RequestContext(context.Background(), "daemon", ExtCommand{Cmd: "status"})
				firstDone <- err
			}()
			first, err := protocol.ReadEnvelope(daemonConn)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			want := context.Canceled
			if test.deadline {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 20*time.Millisecond)
				want = context.DeadlineExceeded
			}
			defer cancel()
			queuedDone := make(chan error, 1)
			go func() {
				_, err := client.RequestContext(ctx, "daemon", ExtCommand{Cmd: "status"})
				queuedDone <- err
			}()
			if !test.deadline {
				cancel()
			}
			select {
			case err := <-queuedDone:
				if !errors.Is(err, want) {
					t.Fatalf("queued request error = %v, want %v", err, want)
				}
			case <-time.After(time.Second):
				t.Fatal("queued request ignored context while first request remained pending")
			}
			if err := protocol.WriteEnvelope(daemonConn, &protocol.Envelope{
				ID: first.ID, Type: protocol.MsgResponse, Payload: []byte(`{"data":{}}`),
			}); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-firstDone:
				if err != nil {
					t.Fatalf("first request failed after queued cancellation: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("first request did not receive its response")
			}
		})
	}
}
