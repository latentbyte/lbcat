package daemon

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/protocol"
)

type eventWriteConn struct {
	net.Conn
	started chan struct{}
	once    sync.Once
}

func (c *eventWriteConn) Write(data []byte) (int, error) {
	c.once.Do(func() { close(c.started) })
	return c.Conn.Write(data)
}

func TestRouterConcurrentClients(t *testing.T) {
	t.Run("停止读取事件的客户端不会阻塞其他客户端的响应", func(t *testing.T) {
		reg := NewRegistry()
		router := NewRouter(reg)
		slowLocal, _ := pipePair(t)
		slow := reg.Add(slowLocal, &protocol.Handshake{Role: protocol.RoleCLI})
		t.Cleanup(func() { _ = slow.Close() })
		goodLocal, goodRemote := pipePair(t)
		good := reg.Add(goodLocal, &protocol.Handshake{Role: protocol.RoleCLI})
		t.Cleanup(func() { _ = good.Close() })
		browserLocal, _ := pipePair(t)
		browser := reg.Add(browserLocal, &protocol.Handshake{Role: protocol.RoleBrowser, Browser: "chrome"})
		t.Cleanup(func() { _ = browser.Close() })
		router.pending.Store("reply", pendingRequest{originID: good.ID, targetID: browser.ID})
		response := make(chan *protocol.Envelope, 1)
		go func() {
			for {
				env, err := protocol.ReadEnvelope(goodRemote)
				if err != nil {
					return
				}
				if env.Type == protocol.MsgResponse {
					response <- env
					return
				}
			}
		}()
		routed := make(chan error, 1)
		go func() {
			if err := router.Route(browser, &protocol.Envelope{ID: "event", Type: protocol.MsgEvent, Payload: json.RawMessage(`{}`)}); err != nil {
				routed <- err
				return
			}
			routed <- router.Route(browser, &protocol.Envelope{ID: "reply", Type: protocol.MsgResponse, Payload: json.RawMessage(`{"data":"healthy"}`)})
		}()
		select {
		case env := <-response:
			if env.ID != "reply" || string(env.Payload) != `{"data":"healthy"}` {
				t.Fatalf("wrong response: %+v", env)
			}
		case <-time.After(500 * time.Millisecond):
			t.Fatal("slow event consumer blocked another client's response")
		}
		if err := <-routed; err != nil {
			t.Fatalf("routing failed: %v", err)
		}
	})

	t.Run("并发客户端按请求标识接收逆序响应", func(t *testing.T) {
		reg := NewRegistry()
		router := NewRouter(reg)
		browserLocal, browserRemote := pipePair(t)
		browser := reg.Add(browserLocal, &protocol.Handshake{Role: protocol.RoleBrowser, Browser: "chrome"})
		t.Cleanup(func() { _ = browser.Close() })
		const clients = 20
		received := make(chan []*protocol.Envelope, 1)
		go func() {
			requests := make([]*protocol.Envelope, 0, clients)
			for range clients {
				env, err := protocol.ReadEnvelope(browserRemote)
				if err != nil {
					return
				}
				requests = append(requests, env)
			}
			received <- requests
		}()
		responses := make([]<-chan *protocol.Envelope, clients)
		errors := make(chan error, clients)
		var requests sync.WaitGroup
		for i := range clients {
			local, remote := pipePair(t)
			client := reg.Add(local, &protocol.Handshake{Role: protocol.RoleCLI})
			t.Cleanup(func() { _ = client.Close() })
			responses[i] = readEnvelopeAsync(remote)
			requests.Add(1)
			go func() {
				defer requests.Done()
				errors <- router.Route(client, &protocol.Envelope{
					ID: fmt.Sprintf("request-%d", i), Type: protocol.MsgRequest, Target: browser.ID,
					Payload: json.RawMessage(fmt.Sprintf(`{"tabId":%d}`, i)),
				})
			}()
		}
		requests.Wait()
		for range clients {
			if err := <-errors; err != nil {
				t.Fatalf("request routing: %v", err)
			}
		}
		var forwarded []*protocol.Envelope
		select {
		case forwarded = <-received:
		case <-time.After(2 * time.Second):
			t.Fatal("browser did not receive all concurrent requests")
		}
		for i := len(forwarded) - 1; i >= 0; i-- {
			request := forwarded[i]
			if err := router.Route(browser, &protocol.Envelope{ID: request.ID, Type: protocol.MsgResponse, Payload: request.Payload}); err != nil {
				t.Fatalf("response routing: %v", err)
			}
		}
		for i, response := range responses {
			env := waitEnvelope(t, response)
			if env.ID != fmt.Sprintf("request-%d", i) || string(env.Payload) != fmt.Sprintf(`{"tabId":%d}`, i) || env.Source != browser.ID {
				t.Fatalf("client %d received another client's response: %+v", i, env)
			}
		}
	})
}

func TestConnBoundedWrites(t *testing.T) {
	t.Run("停止读取的连接在写入超时后关闭", func(t *testing.T) {
		local, _ := pipePair(t)
		conn := NewRegistry().Add(local, &protocol.Handshake{Role: protocol.RoleCLI})
		t.Cleanup(func() { _ = conn.Close() })
		done := make(chan error, 1)
		go func() {
			done <- conn.WriteEnvelope(&protocol.Envelope{ID: "blocked", Type: protocol.MsgResponse, Payload: json.RawMessage(`{}`)})
		}()
		select {
		case err := <-done:
			if err == nil || !conn.closed.Load() {
				t.Fatalf("stalled write should fail and close connection: %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("stalled write has no bounded timeout")
		}
	})

	t.Run("事件队列满时关闭连接并停止写入协程", func(t *testing.T) {
		local, _ := pipePair(t)
		conn := NewRegistry().Add(local, &protocol.Handshake{Role: protocol.RoleCLI})
		t.Cleanup(func() { _ = conn.Close() })
		var err error
		for range eventQueueSize + 2 {
			err = conn.QueueEvent(&protocol.Envelope{ID: "event", Type: protocol.MsgEvent, Payload: json.RawMessage(`{}`)})
			if err != nil {
				break
			}
		}
		if err == nil || !conn.closed.Load() {
			t.Fatalf("full queue should fail and close connection: %v", err)
		}
		select {
		case <-conn.eventDone:
		case <-time.After(time.Second):
			t.Fatal("event writer did not stop after queue overflow")
		}
	})

	for _, blocked := range []bool{false, true} {
		t.Run(fmt.Sprintf("关闭连接时停止事件写入协程_阻塞=%t", blocked), func(t *testing.T) {
			local, remote := pipePair(t)
			tracked := &eventWriteConn{Conn: local, started: make(chan struct{})}
			conn := NewRegistry().Add(tracked, &protocol.Handshake{Role: protocol.RoleCLI})
			t.Cleanup(func() { _ = conn.Close() })
			var received <-chan *protocol.Envelope
			if !blocked {
				received = readEnvelopeAsync(remote)
			}
			if err := conn.QueueEvent(&protocol.Envelope{ID: "event", Type: protocol.MsgEvent, Payload: json.RawMessage(`{}`)}); err != nil {
				t.Fatal(err)
			}
			if !blocked {
				waitEnvelope(t, received)
			} else {
				select {
				case <-tracked.started:
				case <-time.After(time.Second):
					t.Fatal("event writer did not begin blocked write")
				}
			}
			if err := conn.Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case <-conn.eventDone:
			case <-time.After(time.Second):
				t.Fatal("event writer did not stop after connection closed")
			}
		})
	}
}
