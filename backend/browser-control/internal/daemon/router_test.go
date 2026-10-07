package daemon

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

// pipePair creates a connected pair of net.Conn for testing.
func pipePair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	a, b := net.Pipe()
	t.Cleanup(func() {
		a.Close()
		b.Close()
	})
	return a, b
}

// readEnvelopeAsync reads an envelope in a goroutine, returning via channel.
func readEnvelopeAsync(conn net.Conn) <-chan *protocol.Envelope {
	ch := make(chan *protocol.Envelope, 1)
	go func() {
		env, err := protocol.ReadEnvelope(conn)
		if err != nil {
			return
		}
		ch <- env
	}()
	return ch
}

func waitEnvelope(t *testing.T, ch <-chan *protocol.Envelope) *protocol.Envelope {
	t.Helper()
	select {
	case env := <-ch:
		return env
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for envelope")
		return nil
	}
}

func TestRouterRequestResponse(t *testing.T) {
	reg := NewRegistry()
	router := NewRouter(reg)

	// create a CLI connection
	cliLocal, cliRemote := pipePair(t)
	cliConn := reg.Add(cliLocal, &protocol.Handshake{
		ID:   "h1",
		Type: protocol.MsgHandshake,
		Role: protocol.RoleCLI,
		PID:  1000,
	})

	// create a browser connection
	browserLocal, browserRemote := pipePair(t)
	browserConn := reg.Add(browserLocal, &protocol.Handshake{
		ID:      "h2",
		Type:    protocol.MsgHandshake,
		Role:    protocol.RoleBrowser,
		Browser: "chrome",
	})

	// start reading on browser side before routing (net.Pipe is synchronous)
	browserCh := readEnvelopeAsync(browserRemote)

	// CLI sends a request targeting the browser
	req := &protocol.Envelope{
		ID:      "msg-001",
		Type:    protocol.MsgRequest,
		Target:  browserConn.ID,
		Payload: json.RawMessage(`{"cmd":"tabs.list"}`),
	}

	if err := router.Route(cliConn, req); err != nil {
		t.Fatalf("Route request: %v", err)
	}

	// browser side should receive the request
	got := waitEnvelope(t, browserCh)
	if got.ID != "msg-001" {
		t.Errorf("browser got ID %q, want msg-001", got.ID)
	}

	// start reading on CLI side before routing response
	cliCh := readEnvelopeAsync(cliRemote)

	// browser sends response
	resp := &protocol.Envelope{
		ID:      "msg-001", // same ID
		Type:    protocol.MsgResponse,
		Payload: json.RawMessage(`{"data":[{"id":1,"title":"Tab 1"}]}`),
	}
	if err := router.Route(browserConn, resp); err != nil {
		t.Fatalf("Route response: %v", err)
	}

	// CLI side should receive the response
	gotResp := waitEnvelope(t, cliCh)
	if gotResp.ID != "msg-001" {
		t.Errorf("cli got ID %q, want msg-001", gotResp.ID)
	}
	if gotResp.Source != browserConn.ID {
		t.Errorf("cli got Source %q, want %q", gotResp.Source, browserConn.ID)
	}
	if string(gotResp.Payload) != string(resp.Payload) {
		t.Errorf("cli payload mismatch: %s", gotResp.Payload)
	}
}

func TestRouterEventBroadcast(t *testing.T) {
	reg := NewRegistry()
	router := NewRouter(reg)

	// two CLI connections
	cli1Local, cli1Remote := pipePair(t)
	reg.Add(cli1Local, &protocol.Handshake{
		ID: "h1", Type: protocol.MsgHandshake, Role: protocol.RoleCLI, PID: 1,
	})

	cli2Local, cli2Remote := pipePair(t)
	reg.Add(cli2Local, &protocol.Handshake{
		ID: "h2", Type: protocol.MsgHandshake, Role: protocol.RoleCLI, PID: 2,
	})

	// browser connection
	browserLocal, _ := pipePair(t)
	browserConn := reg.Add(browserLocal, &protocol.Handshake{
		ID: "h3", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "firefox",
	})

	// start reading on both CLI sides
	cli1Ch := readEnvelopeAsync(cli1Remote)
	cli2Ch := readEnvelopeAsync(cli2Remote)

	// browser sends an event
	evt := &protocol.Envelope{
		ID:      "evt-001",
		Type:    protocol.MsgEvent,
		Payload: json.RawMessage(`{"cmd":"tabs.event","data":{"event":"onCreated"}}`),
	}
	if err := router.Route(browserConn, evt); err != nil {
		t.Fatalf("Route event: %v", err)
	}

	// both CLIs should receive it
	got1 := waitEnvelope(t, cli1Ch)
	if got1.ID != "evt-001" {
		t.Errorf("cli1 got ID %q, want evt-001", got1.ID)
	}
	if got1.Source != browserConn.ID {
		t.Errorf("cli1 got Source %q, want %q", got1.Source, browserConn.ID)
	}
	got2 := waitEnvelope(t, cli2Ch)
	if got2.ID != "evt-001" {
		t.Errorf("cli2 got ID %q, want evt-001", got2.ID)
	}
	if got2.Source != browserConn.ID {
		t.Errorf("cli2 got Source %q, want %q", got2.Source, browserConn.ID)
	}
}

func TestAppNameForBrowserUsesMacAppName(t *testing.T) {
	t.Parallel()

	tests := []struct {
		browser string
		want    string
	}{
		{browser: "zen", want: "Zen"},
		{browser: "comet", want: "Comet"},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.browser, func(t *testing.T) {
			t.Parallel()
			if got := appNameForBrowser(tt.browser); got != tt.want {
				t.Fatalf("appNameForBrowser(%s) = %q, want %q", tt.browser, got, tt.want)
			}
		})
	}
}

func TestRouterBrowserLifecycleBroadcast(t *testing.T) {
	reg := NewRegistry()
	router := NewRouter(reg)

	cliLocal, cliRemote := pipePair(t)
	reg.Add(cliLocal, &protocol.Handshake{ID: "h1", Type: protocol.MsgHandshake, Role: protocol.RoleCLI, PID: 1})

	browserLocal, _ := pipePair(t)
	browserConn := reg.Add(browserLocal, &protocol.Handshake{
		ID: "h2", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "chrome",
	})

	cliCh := readEnvelopeAsync(cliRemote)
	if err := router.BroadcastBrowserLifecycle(browserConn, "browser-connected"); err != nil {
		t.Fatalf("BroadcastBrowserLifecycle() error = %v", err)
	}

	got := waitEnvelope(t, cliCh)
	if got.Type != protocol.MsgEvent {
		t.Fatalf("event Type = %q, want %q", got.Type, protocol.MsgEvent)
	}
	if got.Source != "daemon" {
		t.Fatalf("event Source = %q, want daemon", got.Source)
	}

	var payload struct {
		Cmd  string `json:"cmd"`
		Data struct {
			Type        string `json:"type"`
			BrowserID   string `json:"browserId"`
			BrowserName string `json:"browserName"`
			AppName     string `json:"appName"`
		} `json:"data"`
	}
	if err := json.Unmarshal(got.Payload, &payload); err != nil {
		t.Fatalf("Unmarshal(payload) error = %v", err)
	}
	if payload.Cmd != "browser.event" {
		t.Fatalf("Cmd = %q, want browser.event", payload.Cmd)
	}
	if payload.Data.Type != "browser-connected" || payload.Data.BrowserID != browserConn.ID || payload.Data.BrowserName != "chrome" || payload.Data.AppName != "Google Chrome" {
		t.Fatalf("unexpected payload data: %#v", payload.Data)
	}
}

func TestRegistryPeerIDs(t *testing.T) {
	reg := NewRegistry()

	a, _ := pipePair(t)
	b, _ := pipePair(t)
	c, _ := pipePair(t)

	c1 := reg.Add(a, &protocol.Handshake{ID: "1", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "chrome"})
	reg.Add(b, &protocol.Handshake{ID: "2", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "firefox"})
	reg.Add(c, &protocol.Handshake{ID: "3", Type: protocol.MsgHandshake, Role: protocol.RoleCLI, PID: 99})

	peers := reg.PeerIDs(c1.ID)
	if len(peers) != 2 {
		t.Fatalf("expected 2 peers, got %d: %v", len(peers), peers)
	}

	// remove one
	reg.Remove(c1.ID)
	if _, ok := reg.Get(c1.ID); ok {
		t.Error("connection should be removed")
	}
}

func TestRouterUnknownTarget(t *testing.T) {
	reg := NewRegistry()
	router := NewRouter(reg)

	local, remote := pipePair(t)
	conn := reg.Add(local, &protocol.Handshake{
		ID: "h1", Type: protocol.MsgHandshake, Role: protocol.RoleCLI, PID: 1,
	})

	// start reading on CLI side
	cliCh := readEnvelopeAsync(remote)

	// request to non-existent target
	req := &protocol.Envelope{
		ID:     "msg-err",
		Type:   protocol.MsgRequest,
		Target: "chrome-99",
	}
	err := router.Route(conn, req)
	if err != nil {
		t.Fatalf("Route should not return error (sends error to client): %v", err)
	}

	// CLI should receive an error response
	got := waitEnvelope(t, cliCh)
	if got.Type != protocol.MsgResponse {
		t.Errorf("expected response type, got %s", got.Type)
	}

	var payload struct {
		Cmd   string `json:"cmd"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	json.Unmarshal(got.Payload, &payload)
	if payload.Error.Code != "CONN_NOT_FOUND" {
		t.Errorf("expected CONN_NOT_FOUND error, got %q", payload.Error.Code)
	}
}

func TestRouterForwardFailure(t *testing.T) {
	reg := NewRegistry()
	router := NewRouter(reg)

	cliLocal, cliRemote := pipePair(t)
	cliConn := reg.Add(cliLocal, &protocol.Handshake{
		ID: "h1", Type: protocol.MsgHandshake, Role: protocol.RoleCLI, PID: 1,
	})

	browserLocal, browserRemote := pipePair(t)
	browserConn := reg.Add(browserLocal, &protocol.Handshake{
		ID: "h2", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "chrome",
	})
	_ = browserConn
	_ = browserRemote.Close() // force write failure when routing to browser

	cliCh := readEnvelopeAsync(cliRemote)

	req := &protocol.Envelope{
		ID:      "msg-forward-fail",
		Type:    protocol.MsgRequest,
		Target:  browserConn.ID,
		Payload: json.RawMessage(`{"cmd":"tabs.list"}`),
	}
	if err := router.Route(cliConn, req); err != nil {
		t.Fatalf("Route should return nil and send error envelope: %v", err)
	}

	got := waitEnvelope(t, cliCh)
	if got.Type != protocol.MsgResponse {
		t.Fatalf("expected response type, got %s", got.Type)
	}
	var payload struct {
		Cmd   string `json:"cmd"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(got.Payload, &payload)
	if payload.Error.Code != "FORWARD_FAILED" {
		t.Errorf("expected FORWARD_FAILED error, got %q", payload.Error.Code)
	}
}

func TestRouterClearPendingOnTargetDisconnect(t *testing.T) {
	reg := NewRegistry()
	router := NewRouter(reg)

	cliLocal, cliRemote := pipePair(t)
	cliConn := reg.Add(cliLocal, &protocol.Handshake{
		ID: "h1", Type: protocol.MsgHandshake, Role: protocol.RoleCLI, PID: 1,
	})

	browserLocal, browserRemote := pipePair(t)
	browserConn := reg.Add(browserLocal, &protocol.Handshake{
		ID: "h2", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "chrome",
	})

	// consume routed request so net.Pipe write doesn't block
	browserCh := readEnvelopeAsync(browserRemote)

	req := &protocol.Envelope{
		ID:      "msg-disconnect",
		Type:    protocol.MsgRequest,
		Target:  browserConn.ID,
		Payload: json.RawMessage(`{"cmd":"tabs.list"}`),
	}
	if err := router.Route(cliConn, req); err != nil {
		t.Fatalf("Route request: %v", err)
	}
	_ = waitEnvelope(t, browserCh)

	cliCh := readEnvelopeAsync(cliRemote)
	router.ClearPending(browserConn.ID)

	got := waitEnvelope(t, cliCh)
	var payload struct {
		Cmd   string `json:"cmd"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(got.Payload, &payload)
	if payload.Error.Code != "TARGET_DISCONNECTED" {
		t.Errorf("expected TARGET_DISCONNECTED error, got %q", payload.Error.Code)
	}
}

func TestRouterDaemonPing(t *testing.T) {
	reg := NewRegistry()
	router := NewRouter(reg)

	local, remote := pipePair(t)
	conn := reg.Add(local, &protocol.Handshake{
		ID: "h1", Type: protocol.MsgHandshake, Role: protocol.RoleCLI, PID: 1,
	})

	cliCh := readEnvelopeAsync(remote)

	req := &protocol.Envelope{
		ID:      "ping-001",
		Type:    protocol.MsgRequest,
		Target:  "daemon",
		Payload: json.RawMessage(`{"cmd":"ping"}`),
	}
	if err := router.Route(conn, req); err != nil {
		t.Fatalf("Route ping: %v", err)
	}

	got := waitEnvelope(t, cliCh)
	if got.ID != "ping-001" {
		t.Errorf("expected ID ping-001, got %q", got.ID)
	}
	if got.Type != protocol.MsgResponse {
		t.Errorf("expected response type, got %s", got.Type)
	}

	var resp struct {
		Cmd  string `json:"cmd"`
		Data struct {
			PID int `json:"pid"`
		} `json:"data"`
	}
	json.Unmarshal(got.Payload, &resp)
	if resp.Cmd != "pong" {
		t.Errorf("expected cmd=pong, got %q", resp.Cmd)
	}
	if resp.Data.PID == 0 {
		t.Error("expected non-zero PID in pong response")
	}
}

func TestRouterDaemonStatus(t *testing.T) {
	reg := NewRegistry()
	router := NewRouter(reg)

	// add a browser and a CLI
	browserLocal, _ := pipePair(t)
	reg.Add(browserLocal, &protocol.Handshake{
		ID: "h1", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "chrome",
	})

	cliLocal, cliRemote := pipePair(t)
	cliConn := reg.Add(cliLocal, &protocol.Handshake{
		ID: "h2", Type: protocol.MsgHandshake, Role: protocol.RoleCLI, PID: 42,
	})

	cliCh := readEnvelopeAsync(cliRemote)

	req := &protocol.Envelope{
		ID:      "status-001",
		Type:    protocol.MsgRequest,
		Target:  "daemon",
		Payload: json.RawMessage(`{"cmd":"status"}`),
	}
	if err := router.Route(cliConn, req); err != nil {
		t.Fatalf("Route status: %v", err)
	}

	got := waitEnvelope(t, cliCh)

	var resp struct {
		Cmd  string `json:"cmd"`
		Data struct {
			PID          int             `json:"pid"`
			Capabilities []string        `json:"capabilities"`
			Socket       string          `json:"socket"`
			Connections  json.RawMessage `json:"connections"`
		} `json:"data"`
	}
	json.Unmarshal(got.Payload, &resp)
	if resp.Cmd != "status" {
		t.Errorf("expected cmd=status, got %q", resp.Cmd)
	}
	if resp.Data.PID == 0 {
		t.Error("expected non-zero PID")
	}

	var conns []struct {
		ID   string `json:"id"`
		Role string `json:"role"`
	}
	json.Unmarshal(resp.Data.Connections, &conns)
	if len(resp.Data.Capabilities) != 1 || resp.Data.Capabilities[0] != "switcher-tabs" {
		t.Fatalf("capabilities = %#v", resp.Data.Capabilities)
	}
	if len(conns) < 2 {
		t.Errorf("expected at least 2 connections, got %d", len(conns))
	}
}

func TestRouterSwitcherSubscription(t *testing.T) {
	for _, test := range []struct {
		name         string
		response     string
		cleanup      string
		otherBrowser bool
		wrongSource  bool
		pending      bool
		want         bool
	}{
		{name: "仅成功订阅的客户端接收普通标签事件", response: `{"cmd":"switcher.tabs.subscribe","data":{"events":["onCreated"]}}`, want: true},
		{name: "等待订阅响应不能授权", pending: true},
		{name: "失败订阅不能授权", response: `{"cmd":"switcher.tabs.subscribe","error":{"code":"DENIED"}}`},
		{name: "畸形响应不能授权", response: `{"cmd":"switcher.tabs.subscribe"}`},
		{name: "其他命令响应不能授权", response: `{"cmd":"tabs.subscribe","data":{}}`},
		{name: "客户端断开清除订阅", response: `{"cmd":"switcher.tabs.subscribe","data":{}}`, cleanup: "cli"},
		{name: "浏览器断开清除订阅", response: `{"cmd":"switcher.tabs.subscribe","data":{}}`, cleanup: "browser"},
		{name: "订阅只授权指定浏览器", response: `{"cmd":"switcher.tabs.subscribe","data":{}}`, otherBrowser: true},
		{name: "其他来源不能冒充成功响应", response: `{"cmd":"switcher.tabs.subscribe","data":{}}`, wrongSource: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			reg := NewRegistry()
			router := NewRouter(reg)
			cliLocal, cliRemote := pipePair(t)
			subscriber := reg.Add(cliLocal, &protocol.Handshake{Role: protocol.RoleCLI})
			agentLocal, agentRemote := pipePair(t)
			agent := reg.Add(agentLocal, &protocol.Handshake{Role: protocol.RoleCLI})
			browserLocal, browserRemote := pipePair(t)
			browser := reg.Add(browserLocal, &protocol.Handshake{Role: protocol.RoleBrowser, Browser: "firefox"})
			otherLocal, _ := pipePair(t)
			other := reg.Add(otherLocal, &protocol.Handshake{Role: protocol.RoleBrowser, Browser: "chrome"})
			for _, conn := range []*Conn{subscriber, agent, browser, other} {
				t.Cleanup(func() { _ = conn.Close() })
			}
			browserRead := readEnvelopeAsync(browserRemote)
			if err := router.Route(subscriber, &protocol.Envelope{ID: "subscribe", Type: protocol.MsgRequest, Target: browser.ID, Payload: json.RawMessage(`{"cmd":"switcher.tabs.subscribe"}`)}); err != nil {
				t.Fatal(err)
			}
			waitEnvelope(t, browserRead)
			responseSource := browser
			if test.wrongSource {
				responseSource = other
			} else if !test.pending {
				responseRead := readEnvelopeAsync(cliRemote)
				if err := router.Route(responseSource, &protocol.Envelope{ID: "subscribe", Type: protocol.MsgResponse, Payload: json.RawMessage(test.response)}); err != nil {
					t.Fatal(err)
				}
				waitEnvelope(t, responseRead)
			}
			if test.wrongSource {
				// 正确浏览器尚未应答，冒充响应也不能转发或授权
				if err := router.Route(responseSource, &protocol.Envelope{ID: "subscribe", Type: protocol.MsgResponse, Payload: json.RawMessage(test.response)}); err != nil {
					t.Fatal(err)
				}
			}
			if test.cleanup == "cli" {
				router.ClearPending(subscriber.ID)
			}
			if test.cleanup == "browser" {
				router.ClearPending(browser.ID)
			}
			eventSource := browser
			if test.otherBrowser {
				eventSource = other
			}
			subscriberRead := readEnvelopeAsync(cliRemote)
			agentRead := readEnvelopeAsync(agentRemote)
			if err := router.Route(eventSource, &protocol.Envelope{ID: "switcher-event", Type: protocol.MsgEvent, Payload: json.RawMessage(`{"cmd":"switcher.tabs.event","data":{"event":"onCreated"}}`)}); err != nil {
				t.Fatal(err)
			}
			if test.want {
				if got := waitEnvelope(t, subscriberRead); got.ID != "switcher-event" {
					t.Fatalf("event = %#v", got)
				}
			} else {
				select {
				case got := <-subscriberRead:
					t.Fatalf("unauthorized event = %#v", got)
				case <-time.After(40 * time.Millisecond):
				}
			}
			select {
			case got := <-agentRead:
				t.Fatalf("agent received ordinary tab event = %#v", got)
			case <-time.After(40 * time.Millisecond):
			}
		})
	}
}
