package browsercontrol

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/daemon"
	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
)

func newSubscriptionTestBrowser(t *testing.T, respond ...func(json.RawMessage) json.RawMessage) (Client, func(model.EventType)) {
	t.Helper()
	return newNamespaceTestBrowser(t, New, "tabs.event", respond...)
}

func newNamespaceTestBrowser(t *testing.T, constructor func(context.Context) (Client, error), eventCommand string, respond ...func(json.RawMessage) json.RawMessage) (Client, func(model.EventType)) {
	t.Helper()
	stateDir, err := os.MkdirTemp("", "bc-sub-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(stateDir) })
	t.Setenv("XDG_STATE_HOME", stateDir)
	server := daemon.NewServer()
	server.IdleTimeout = 0
	if err := server.Listen(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = server.Serve(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("test daemon did not stop")
		}
		server.Shutdown()
	})
	browser, err := net.Dial("unix", protocol.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = browser.Close() })
	if err := protocol.WriteJSON(browser, &protocol.Handshake{ID: "test-browser", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "zen"}); err != nil {
		t.Fatal(err)
	}
	if _, err := protocol.ReadFrame(browser); err != nil {
		t.Fatal(err)
	}
	var writeMu sync.Mutex
	go func() {
		for {
			env, err := protocol.ReadEnvelope(browser)
			if err != nil {
				return
			}
			payload := json.RawMessage(`{"data":{}}`)
			var command struct {
				Cmd string `json:"cmd"`
			}
			_ = json.Unmarshal(env.Payload, &command)
			if command.Cmd == "agentWindow.status" {
				payload = json.RawMessage(`{"cmd":"agentWindow.status","data":{"windowId":7,"markerTabId":8}}`)
			} else if len(respond) > 0 {
				payload = respond[0](env.Payload)
			}
			writeMu.Lock()
			_ = protocol.WriteEnvelope(browser, &protocol.Envelope{ID: env.ID, Type: protocol.MsgResponse, Payload: payload})
			writeMu.Unlock()
		}
	}()
	client, err := constructor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client, func(typ model.EventType) {
		payload, err := json.Marshal(map[string]any{"cmd": eventCommand, "data": model.Event{Type: typ}})
		if err != nil {
			t.Fatal(err)
		}
		writeMu.Lock()
		err = protocol.WriteEnvelope(browser, &protocol.Envelope{ID: "test-event", Type: protocol.MsgEvent, Payload: payload})
		writeMu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
	}
}

func waitSubscriptionEvent(t *testing.T, events <-chan model.Event, want model.EventType) {
	t.Helper()
	select {
	case evt, ok := <-events:
		if !ok || evt.Type != want {
			t.Fatalf("subscription event = %#v, open = %v, want %s", evt, ok, want)
		}
	case <-time.After(time.Second):
		t.Fatal("subscription event was not delivered")
	}
}

func waitSubscriptionClosed(t *testing.T, events <-chan model.Event) {
	t.Helper()
	select {
	case _, ok := <-events:
		if ok {
			t.Fatal("subscription remained open")
		}
	case <-time.After(time.Second):
		t.Fatal("subscription did not close")
	}
}

func TestSubscriptionConcurrentRequests(t *testing.T) {
	t.Run("订阅期间状态与聚焦请求不抢占事件读取", func(t *testing.T) {
		client, emit := newSubscriptionTestBrowser(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		events, err := client.Subscribe(ctx, SubscribeOptions{BrowserID: "zen-01", Events: []model.EventType{model.EventTypeTabFocused}})
		if err != nil {
			t.Fatal(err)
		}
		emit(model.EventTypeTabFocused)
		waitSubscriptionEvent(t, events, model.EventTypeTabFocused)
		requestCtx, requestCancel := context.WithTimeout(context.Background(), time.Second)
		defer requestCancel()
		requests := make(chan error, 2)
		go func() {
			_, err := client.Status(requestCtx)
			requests <- err
		}()
		go func() {
			_, err := client.FocusTab(requestCtx, FocusTabRequest{BrowserID: "zen-01", TabID: 12})
			requests <- err
		}()
		for range 2 {
			if err := <-requests; err != nil {
				t.Fatalf("request during subscription: %v", err)
			}
		}
		emit(model.EventTypeTabFocused)
		waitSubscriptionEvent(t, events, model.EventTypeTabFocused)
	})
}

func TestSubscriptionCancelPreservesClient(t *testing.T) {
	t.Run("取消订阅仅关闭自身连接", func(t *testing.T) {
		client, emit := newSubscriptionTestBrowser(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		opts := SubscribeOptions{BrowserID: "zen-01", Events: []model.EventType{model.EventTypeTabFocused}}
		events, err := client.Subscribe(ctx, opts)
		if err != nil {
			t.Fatal(err)
		}
		other, err := client.Subscribe(context.Background(), opts)
		if err != nil {
			t.Fatal(err)
		}
		cancel()
		waitSubscriptionClosed(t, events)
		emit(model.EventTypeTabFocused)
		waitSubscriptionEvent(t, other, model.EventTypeTabFocused)
		if _, err := client.Status(context.Background()); err != nil {
			t.Fatalf("Status after subscription cancellation: %v", err)
		}
	})
}

func TestSubscriptionDiscoveryCancelPreservesClient(t *testing.T) {
	t.Run("取消订阅的浏览器发现不会关闭主连接", func(t *testing.T) {
		stateDir, err := os.MkdirTemp("/tmp", "bc-discovery-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(stateDir) })
		t.Setenv("XDG_STATE_HOME", stateDir)
		if err := os.MkdirAll(protocol.StateDir(), 0o700); err != nil {
			t.Fatal(err)
		}
		listener, err := net.Listen("unix", protocol.SocketPath())
		if err != nil {
			t.Fatal(err)
		}
		statusStarted := make(chan struct{})
		releaseStatus := make(chan struct{})
		var releaseOnce sync.Once
		release := func() { releaseOnce.Do(func() { close(releaseStatus) }) }
		var held atomic.Bool
		var workers sync.WaitGroup
		accepted := make(chan struct{})
		go func() {
			defer close(accepted)
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				workers.Add(1)
				go func() {
					defer workers.Done()
					defer conn.Close()
					if _, err := protocol.ReadFrame(conn); err != nil {
						return
					}
					if err := protocol.WriteJSON(conn, &protocol.HandshakeAck{Type: protocol.MsgHandshakeAck, ConnID: "test-cli"}); err != nil {
						return
					}
					for {
						env, err := protocol.ReadEnvelope(conn)
						if err != nil {
							return
						}
						if held.CompareAndSwap(false, true) {
							close(statusStarted)
							<-releaseStatus
						}
						if err := protocol.WriteEnvelope(conn, &protocol.Envelope{ID: env.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(`{"cmd":"status","data":{"pid":12,"connections":[]}}`)}); err != nil {
							return
						}
					}
				}()
			}
		}()
		t.Cleanup(func() {
			release()
			_ = listener.Close()
			<-accepted
			workers.Wait()
		})
		client, err := New(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = client.Close() })
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan error, 1)
		go func() {
			_, err := client.Subscribe(ctx, SubscribeOptions{Events: []model.EventType{model.EventTypeTabFocused}})
			done <- err
		}()
		select {
		case <-statusStarted:
		case <-time.After(time.Second):
			t.Fatal("subscription did not start browser discovery")
		}
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("Subscribe error = %v, want context.Canceled", err)
			}
		case <-time.After(time.Second):
			t.Fatal("subscription discovery ignored cancellation")
		}
		release()
		requestCtx, requestCancel := context.WithTimeout(context.Background(), time.Second)
		defer requestCancel()
		status, err := client.Status(requestCtx)
		if err != nil {
			t.Fatalf("Status after discovery cancellation: %v", err)
		}
		if status.PID != 12 {
			t.Fatalf("Status PID = %d, want 12", status.PID)
		}
	})
}

func TestSubscriptionSetupFailurePreservesClient(t *testing.T) {
	t.Run("订阅失败释放连接且不影响后续请求", func(t *testing.T) {
		client, _ := newSubscriptionTestBrowser(t)
		_, err := client.Subscribe(context.Background(), SubscribeOptions{BrowserID: "zen-missing", Events: []model.EventType{model.EventTypeTabFocused}})
		var commandErr *CommandError
		if !errors.As(err, &commandErr) || commandErr.Code != "CONN_NOT_FOUND" {
			t.Fatalf("subscription error = %v, want CONN_NOT_FOUND", err)
		}
		connected := client.(*daemonClient)
		connected.mu.Lock()
		count := len(connected.subscriptions)
		connected.mu.Unlock()
		if count != 0 {
			t.Fatalf("failed subscription retained %d connections", count)
		}
		if _, err := client.Status(context.Background()); err != nil {
			t.Fatalf("Status after subscription failure: %v", err)
		}
	})
}

func TestMultipleSubscriptionsAndClientClose(t *testing.T) {
	t.Run("多个订阅独立接收且客户端关闭释放所有订阅", func(t *testing.T) {
		client, emit := newSubscriptionTestBrowser(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		first, err := client.Subscribe(ctx, SubscribeOptions{BrowserID: "zen-01", Events: []model.EventType{model.EventTypeTabFocused}})
		if err != nil {
			t.Fatal(err)
		}
		requestCtx, requestCancel := context.WithTimeout(context.Background(), time.Second)
		defer requestCancel()
		second, err := client.Subscribe(requestCtx, SubscribeOptions{BrowserID: "zen-01", Events: []model.EventType{model.EventTypeTabRemoved}})
		if err != nil {
			t.Fatal(err)
		}
		emit(model.EventTypeTabFocused)
		emit(model.EventTypeTabRemoved)
		waitSubscriptionEvent(t, first, model.EventTypeTabFocused)
		waitSubscriptionEvent(t, second, model.EventTypeTabRemoved)
		if err := client.Close(); err != nil {
			t.Fatal(err)
		}
		waitSubscriptionClosed(t, first)
		waitSubscriptionClosed(t, second)
		if _, err := client.Subscribe(context.Background(), SubscribeOptions{Events: []model.EventType{model.EventTypeBrowserConnected}}); err == nil {
			t.Fatal("closed client accepted subscription")
		}
	})
}

func TestCollectBrowserTabsKeepsHealthyBrowsers(t *testing.T) {
	t.Parallel()
	targets := []BrowserStatus{
		{ID: "zen-01", Name: "zen", AppName: "Zen"},
		{ID: "chrome-01", Name: "chrome", AppName: "Google Chrome"},
	}
	tabs, err := collectBrowserTabs(context.Background(), targets, func(_ context.Context, target BrowserStatus) ([]model.Tab, error) {
		if target.ID == "zen-01" {
			return nil, errors.New("browser unavailable")
		}
		return []model.Tab{{ID: 12, Title: "Example"}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tabs) != 1 || tabs[0].BrowserID != "chrome-01" {
		t.Fatalf("tabs = %#v, want healthy Chrome tab", tabs)
	}
}

func TestCollectBrowserTabsReportsAllFailures(t *testing.T) {
	t.Parallel()
	targets := []BrowserStatus{{ID: "zen-01"}, {ID: "chrome-01"}}
	_, err := collectBrowserTabs(context.Background(), targets, func(_ context.Context, _ BrowserStatus) ([]model.Tab, error) {
		return nil, errors.New("browser unavailable")
	})
	if err == nil {
		t.Fatal("expected an error when every browser fails")
	}
}

func TestBrowserEventNames(t *testing.T) {
	t.Parallel()

	got := browserEventNames([]model.EventType{model.EventTypeTabFocused, model.EventTypeTabRemoved, model.EventTypeTabFocused})
	want := []string{"onActivated", "onRemoved"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("browserEventNames() = %#v, want %#v", got, want)
	}
}

func TestEventTypeGroups(t *testing.T) {
	t.Parallel()

	if !wantsTabEvents([]model.EventType{model.EventTypeTabFocused}) {
		t.Fatal("wantsTabEvents(tab-focused) = false")
	}
	if wantsTabEvents([]model.EventType{model.EventTypeBrowserConnected}) {
		t.Fatal("wantsTabEvents(browser-connected) = true")
	}
	if !wantsLifecycleEvents([]model.EventType{model.EventTypeBrowserDisconnected}) {
		t.Fatal("wantsLifecycleEvents(browser-disconnected) = false")
	}
}

func TestDecodeEventEnvelopeFillsSourceBrowser(t *testing.T) {
	t.Parallel()

	payload := map[string]any{
		"cmd": "tabs.event",
		"data": map[string]any{
			"type":      "tab-focused",
			"browserId": "",
			"tab": map[string]any{
				"browserId":    "",
				"browserName":  "firefox",
				"appName":      "Firefox",
				"id":           123,
				"windowId":     7,
				"index":        2,
				"title":        "Example",
				"url":          "https://example.com/",
				"active":       true,
				"incognito":    false,
				"audible":      false,
				"sharingState": map[string]any{"camera": true, "microphone": false, "screen": "Window"},
			},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Marshal(payload) error = %v", err)
	}

	evt, ok := decodeEventEnvelope(&protocol.Envelope{
		Type:    protocol.MsgEvent,
		Source:  "zen-01",
		Payload: raw,
	}, []model.EventType{model.EventTypeTabFocused}, "tabs.event")
	if !ok {
		t.Fatal("decodeEventEnvelope() ok = false")
	}

	if evt.BrowserID != "zen-01" {
		t.Fatalf("BrowserID = %q, want zen-01", evt.BrowserID)
	}
	if evt.Tab == nil || evt.Tab.BrowserID != "zen-01" {
		t.Fatalf("Tab BrowserID = %#v, want zen-01", evt.Tab)
	}
	if evt.Tab.BrowserName != "zen" || evt.Tab.AppName != "Zen" {
		t.Fatalf("Tab browser fields = %#v, want zen/Zen", evt.Tab)
	}
	if evt.Tab.SharingState == nil || !evt.Tab.SharingState.Camera || evt.Tab.SharingState.Microphone || evt.Tab.SharingState.Screen != "Window" {
		t.Fatalf("sharing state lost in event decoding: %#v", evt.Tab.SharingState)
	}
	if evt.TabID == nil || evt.TabID.Browser != "zen-01" || evt.TabID.TabID != 123 {
		t.Fatalf("TabID = %#v, want zen-01/123", evt.TabID)
	}
}

func TestFillTabBrowserOverridesExtensionIdentity(t *testing.T) {
	t.Parallel()

	tab := model.Tab{BrowserID: "", BrowserName: "firefox", AppName: "Firefox"}
	fillTabBrowser(&tab, BrowserStatus{ID: "zen-01", Name: "zen", AppName: "Zen"})

	if tab.BrowserID != "zen-01" || tab.BrowserName != "zen" || tab.AppName != "Zen" {
		t.Fatalf("tab = %#v, want zen-01/zen/Zen", tab)
	}
}

func TestDecodeBrowserLifecycleEventEnvelope(t *testing.T) {
	t.Parallel()

	raw := json.RawMessage(`{"cmd":"browser.event","data":{"type":"browser-connected","browserId":"chrome-01","browserName":"chrome","appName":"Google Chrome"}}`)
	evt, ok := decodeEventEnvelope(&protocol.Envelope{Type: protocol.MsgEvent, Source: "daemon", Payload: raw}, []model.EventType{model.EventTypeBrowserConnected}, "tabs.event")
	if !ok {
		t.Fatal("decodeEventEnvelope() ok = false")
	}
	if evt.Type != model.EventTypeBrowserConnected {
		t.Fatalf("Type = %q, want %q", evt.Type, model.EventTypeBrowserConnected)
	}
	if evt.BrowserID != "chrome-01" || evt.BrowserName != "chrome" || evt.AppName != "Google Chrome" {
		t.Fatalf("browser fields = %#v, want chrome-01/chrome/Google Chrome", evt)
	}
}

func TestDecodeLegacyEventEnvelope(t *testing.T) {
	t.Parallel()

	raw := json.RawMessage(`{"cmd":"tabs.event","data":{"event":"onRemoved","tabId":123}}`)
	evt, ok := decodeEventEnvelope(&protocol.Envelope{Type: protocol.MsgEvent, Source: "firefox-01", Payload: raw}, nil, "tabs.event")
	if !ok {
		t.Fatal("decodeEventEnvelope() ok = false")
	}
	if evt.Type != model.EventTypeTabRemoved {
		t.Fatalf("Type = %q, want %q", evt.Type, model.EventTypeTabRemoved)
	}
	if evt.TabID == nil || evt.TabID.Browser != "firefox-01" || evt.TabID.TabID != 123 {
		t.Fatalf("TabID = %#v, want firefox-01/123", evt.TabID)
	}
}

func TestSDKScope(t *testing.T) {
	for _, operation := range []string{"tabs.list", "tabs.focus", "tabs.subscribe"} {
		t.Run("SDK将会话授权传递给"+operation, func(t *testing.T) {
			requests := make(chan map[string]any, 1)
			client, _ := newSubscriptionTestBrowser(t, func(raw json.RawMessage) json.RawMessage {
				var request struct {
					Cmd  string         `json:"cmd"`
					Args map[string]any `json:"args"`
				}
				if err := json.Unmarshal(raw, &request); err != nil {
					return json.RawMessage(`{"error":{"code":"BAD_REQUEST"}}`)
				}
				if request.Cmd != operation {
					t.Errorf("default SDK command = %q, want %q", request.Cmd, operation)
				}
				requests <- request.Args
				if request.Cmd == "tabs.list" {
					return json.RawMessage(`{"data":[]}`)
				}
				return json.RawMessage(`{"data":{}}`)
			})
			ctx := context.Background()
			switch operation {
			case "tabs.list":
				if _, err := client.ListTabs(ctx, ListTabsOptions{BrowserID: "zen-01", SessionID: "task-sdk", PersonalTabID: 42}); err != nil {
					t.Fatal(err)
				}
			case "tabs.focus":
				if _, err := client.FocusTab(ctx, FocusTabRequest{BrowserID: "zen-01", TabID: 42, SessionID: "task-sdk", PersonalTabID: 42, AllowFocus: true}); err != nil {
					t.Fatal(err)
				}
			case "tabs.subscribe":
				if _, err := client.Subscribe(ctx, SubscribeOptions{BrowserID: "zen-01", SessionID: "task-sdk"}); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case args := <-requests:
				if args["sessionId"] != "task-sdk" {
					t.Fatalf("args = %#v", args)
				}
				if operation != "tabs.subscribe" && args["personalTabId"] != float64(42) {
					t.Fatalf("args = %#v", args)
				}
				if operation == "tabs.focus" && args["allowFocus"] != true {
					t.Fatalf("args = %#v", args)
				}
			case <-time.After(time.Second):
				t.Fatal("request not delivered")
			}
		})
	}
}

func TestSwitcherSDK(t *testing.T) {
	for _, operation := range []string{"list", "focus", "subscribe"} {
		t.Run("人工切换器使用专用命令"+operation, func(t *testing.T) {
			requests := make(chan string, 4)
			client, emit := newNamespaceTestBrowser(t, NewSwitcher, "switcher.tabs.event", func(raw json.RawMessage) json.RawMessage {
				var request struct {
					Cmd  string         `json:"cmd"`
					Args map[string]any `json:"args"`
				}
				if err := json.Unmarshal(raw, &request); err != nil {
					t.Error(err)
				}
				requests <- request.Cmd
				for _, field := range []string{"sessionId", "personalTabId", "allowFocus"} {
					if _, exists := request.Args[field]; exists {
						t.Errorf("switcher sent agent authorization field %s", field)
					}
				}
				if request.Cmd == "switcher.tabs.list" {
					return json.RawMessage(`{"cmd":"switcher.tabs.list","data":[{"id":42,"windowId":7}]}`)
				}
				if request.Cmd == "switcher.tabs.subscribe" {
					return json.RawMessage(`{"cmd":"switcher.tabs.subscribe","data":{"events":["onUpdated"]}}`)
				}
				return json.RawMessage(`{"cmd":"switcher.tabs.focus","data":{"tabId":42,"windowId":7}}`)
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch operation {
			case "list":
				tabs, err := client.ListTabs(ctx, ListTabsOptions{BrowserID: "zen-01"})
				if err != nil || len(tabs) != 1 || tabs[0].BrowserID != "zen-01" {
					t.Fatalf("tabs = %#v, err = %v", tabs, err)
				}
			case "focus":
				focused, err := client.FocusTab(ctx, FocusTabRequest{BrowserID: "zen-01", TabID: 42})
				if err != nil || focused.TabID != 42 {
					t.Fatalf("focused = %#v, err = %v", focused, err)
				}
			case "subscribe":
				events, err := client.Subscribe(ctx, SubscribeOptions{BrowserID: "zen-01"})
				if err != nil {
					t.Fatal(err)
				}
				emit(model.EventTypeTabUpdated)
				waitSubscriptionEvent(t, events, model.EventTypeTabUpdated)
				cancel()
				waitSubscriptionClosed(t, events)
			}
			select {
			case command := <-requests:
				if command != "switcher.tabs."+operation {
					t.Fatalf("command = %q", command)
				}
			case <-time.After(time.Second):
				t.Fatal("command not sent")
			}
		})
	}
	t.Run("人工切换器拒绝已取消的连接", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := NewSwitcher(ctx); !errors.Is(err, context.Canceled) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestDecodeEventNamespaces(t *testing.T) {
	for _, namespace := range []string{"tabs.event", "switcher.tabs.event"} {
		for _, command := range []string{"tabs.event", "switcher.tabs.event", "browser.event"} {
			t.Run("事件命名空间隔离"+namespace+"/"+command, func(t *testing.T) {
				event := model.Event{Type: model.EventTypeTabCreated}
				if command == "browser.event" {
					event.Type = model.EventTypeBrowserConnected
				}
				raw, err := json.Marshal(map[string]any{"cmd": command, "data": event})
				if err != nil {
					t.Fatal(err)
				}
				_, ok := decodeEventEnvelope(&protocol.Envelope{Type: protocol.MsgEvent, Source: "zen-01", Payload: raw}, nil, namespace)
				if want := command == namespace || command == "browser.event"; ok != want {
					t.Fatalf("decoded = %v, want %v", ok, want)
				}
			})
		}
	}
}

func TestSwitcherDaemonCapability(t *testing.T) {
	for _, test := range []struct {
		name        string
		constructor func(context.Context) (Client, error)
		response    string
		wantError   bool
		wantStatus  bool
	}{
		{name: "旧守护进程缺少隔离能力时拒绝连接", constructor: NewSwitcher, response: `{"cmd":"status","data":{"pid":12}}`, wantError: true, wantStatus: true},
		{name: "其他能力不能代替切换器隔离", constructor: NewSwitcher, response: `{"cmd":"status","data":{"capabilities":["agent-tabs"]}}`, wantError: true, wantStatus: true},
		{name: "支持切换器隔离的守护进程允许连接", constructor: NewSwitcher, response: `{"cmd":"status","data":{"capabilities":["switcher-tabs"]}}`, wantStatus: true},
		{name: "状态查询失败时关闭连接", constructor: NewSwitcher, response: `{"cmd":"error","error":{"code":"UNSUPPORTED"}}`, wantError: true, wantStatus: true},
		{name: "默认代理连接保持旧守护进程兼容", constructor: New, response: `{"cmd":"status","data":{}}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			stateDir, err := os.MkdirTemp("", "bc-cap-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.RemoveAll(stateDir) })
			t.Setenv("XDG_STATE_HOME", stateDir)
			if err := os.MkdirAll(protocol.StateDir(), 0o700); err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("unix", protocol.SocketPath())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = listener.Close() })
			done := make(chan error, 1)
			var requests atomic.Int32
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					done <- err
					return
				}
				defer conn.Close()
				if _, err := protocol.ReadFrame(conn); err != nil {
					done <- err
					return
				}
				if err := protocol.WriteJSON(conn, &protocol.HandshakeAck{Type: protocol.MsgHandshakeAck, ConnID: "capability-client"}); err != nil {
					done <- err
					return
				}
				for {
					env, err := protocol.ReadEnvelope(conn)
					if err != nil {
						done <- err
						return
					}
					requests.Add(1)
					var command struct {
						Cmd string `json:"cmd"`
					}
					if err := json.Unmarshal(env.Payload, &command); err != nil {
						done <- err
						return
					}
					if env.Target != "daemon" || command.Cmd != "status" {
						done <- errors.New("unexpected command before capability verification")
						return
					}
					if err := protocol.WriteEnvelope(conn, &protocol.Envelope{ID: env.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(test.response)}); err != nil {
						done <- err
						return
					}
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			client, err := test.constructor(ctx)
			if client != nil && !test.wantError && test.wantStatus {
				status, statusErr := client.Status(ctx)
				if statusErr != nil || !reflect.DeepEqual(status.Capabilities, []string{"switcher-tabs"}) {
					t.Errorf("status = %#v, error = %v", status, statusErr)
				}
			}
			if client != nil {
				_ = client.Close()
			}
			if (err != nil) != test.wantError {
				t.Errorf("constructor error = %v, want error = %v", err, test.wantError)
			}
			if test.wantError && client != nil {
				t.Error("incompatible daemon returned a usable client")
			}
			select {
			case err := <-done:
				if !errors.Is(err, io.EOF) {
					t.Fatalf("connection was not cleanly closed: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("constructor did not close connection")
			}
			if got := requests.Load() > 0; got != test.wantStatus {
				t.Fatalf("status check = %v, want %v", got, test.wantStatus)
			}
		})
	}
}

func TestAllBrowserSubscriptionFollowsNewBrowsers(t *testing.T) {
	t.Run("全浏览器订阅自动订阅后连接的浏览器", func(t *testing.T) {
		client, _ := newSubscriptionTestBrowser(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		events, err := client.Subscribe(ctx, SubscribeOptions{AllBrowsers: true, Events: []model.EventType{model.EventTypeTabFocused}})
		if err != nil {
			t.Fatal(err)
		}

		late, err := net.Dial("unix", protocol.SocketPath())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = late.Close() })
		if err := protocol.WriteJSON(late, &protocol.Handshake{ID: "late-browser", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: "zen"}); err != nil {
			t.Fatal(err)
		}
		if _, err := protocol.ReadFrame(late); err != nil {
			t.Fatal(err)
		}
		_ = late.SetReadDeadline(time.Now().Add(time.Second))
		for subscribed := false; !subscribed; {
			env, err := protocol.ReadEnvelope(late)
			if err != nil {
				t.Fatalf("late browser was not subscribed: %v", err)
			}
			var command struct {
				Cmd string `json:"cmd"`
			}
			_ = json.Unmarshal(env.Payload, &command)
			reply := json.RawMessage(`{"data":{}}`)
			switch command.Cmd {
			case "agentWindow.status":
				reply = json.RawMessage(`{"cmd":"agentWindow.status","data":{"windowId":7,"markerTabId":8}}`)
			case "tabs.subscribe":
				subscribed = true
			default:
				t.Fatalf("late browser command = %s, want tabs.subscribe", env.Payload)
			}
			if err := protocol.WriteEnvelope(late, &protocol.Envelope{ID: env.ID, Type: protocol.MsgResponse, Payload: reply}); err != nil {
				t.Fatal(err)
			}
		}

		payload, err := json.Marshal(map[string]any{"cmd": "tabs.event", "data": model.Event{Type: model.EventTypeTabFocused}})
		if err != nil {
			t.Fatal(err)
		}
		if err := protocol.WriteEnvelope(late, &protocol.Envelope{ID: "late-event", Type: protocol.MsgEvent, Payload: payload}); err != nil {
			t.Fatal(err)
		}
		// lifecycle events stay filtered when the caller did not ask for them
		waitSubscriptionEvent(t, events, model.EventTypeTabFocused)
	})
}

// connectFakeBrowser registers another browser that answers tab subscriptions
// with subscribeReply and returns a function that sends it a tab event
func connectFakeBrowser(t *testing.T, name string, subscribeReply json.RawMessage) func(model.EventType) {
	t.Helper()
	conn, err := net.Dial("unix", protocol.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if err := protocol.WriteJSON(conn, &protocol.Handshake{ID: name + "-browser", Type: protocol.MsgHandshake, Role: protocol.RoleBrowser, Browser: name}); err != nil {
		t.Fatal(err)
	}
	if _, err := protocol.ReadFrame(conn); err != nil {
		t.Fatal(err)
	}
	var writeMu sync.Mutex
	go func() {
		for {
			env, err := protocol.ReadEnvelope(conn)
			if err != nil {
				return
			}
			var command struct {
				Cmd string `json:"cmd"`
			}
			_ = json.Unmarshal(env.Payload, &command)
			reply := json.RawMessage(`{"data":{}}`)
			switch command.Cmd {
			case "agentWindow.status":
				reply = json.RawMessage(`{"cmd":"agentWindow.status","data":{"windowId":7,"markerTabId":8}}`)
			case "tabs.subscribe":
				reply = subscribeReply
			}
			writeMu.Lock()
			_ = protocol.WriteEnvelope(conn, &protocol.Envelope{ID: env.ID, Type: protocol.MsgResponse, Payload: reply})
			writeMu.Unlock()
		}
	}()
	return func(typ model.EventType) {
		payload, err := json.Marshal(map[string]any{"cmd": "tabs.event", "data": model.Event{Type: typ}})
		if err != nil {
			t.Fatal(err)
		}
		writeMu.Lock()
		err = protocol.WriteEnvelope(conn, &protocol.Envelope{ID: name + "-event", Type: protocol.MsgEvent, Payload: payload})
		writeMu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
	}
}

var unknownSubscribeReply = json.RawMessage(`{"cmd":"tabs.subscribe","error":{"code":"UNKNOWN_COMMAND","message":"unknown command: tabs.subscribe"}}`)

func rejectTabSubscribe(payload json.RawMessage) json.RawMessage {
	var command struct {
		Cmd string `json:"cmd"`
	}
	_ = json.Unmarshal(payload, &command)
	if command.Cmd == "tabs.subscribe" {
		return unknownSubscribeReply
	}
	return json.RawMessage(`{"data":{}}`)
}

func TestAllBrowserSubscriptionSkipsRejectingBrowser(t *testing.T) {
	t.Run("一个浏览器不支持订阅时其他浏览器仍然推送事件", func(t *testing.T) {
		client, _ := newSubscriptionTestBrowser(t, rejectTabSubscribe)
		sendGood := connectFakeBrowser(t, "chrome", json.RawMessage(`{"data":{}}`))
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		events, err := client.Subscribe(ctx, SubscribeOptions{AllBrowsers: true, Events: []model.EventType{model.EventTypeTabFocused}})
		if err != nil {
			t.Fatalf("Subscribe with one rejecting browser: %v", err)
		}
		sendGood(model.EventTypeTabFocused)
		waitSubscriptionEvent(t, events, model.EventTypeTabFocused)
	})

	t.Run("所有浏览器拒绝且只订阅标签事件时返回错误", func(t *testing.T) {
		client, _ := newSubscriptionTestBrowser(t, rejectTabSubscribe)
		_, err := client.Subscribe(context.Background(), SubscribeOptions{AllBrowsers: true, Events: []model.EventType{model.EventTypeTabFocused}})
		var commandErr *CommandError
		if !errors.As(err, &commandErr) || commandErr.Code != "UNKNOWN_COMMAND" {
			t.Fatalf("subscription error = %v, want UNKNOWN_COMMAND", err)
		}
	})

	t.Run("所有浏览器拒绝但订阅生命周期事件时保持订阅", func(t *testing.T) {
		client, _ := newSubscriptionTestBrowser(t, rejectTabSubscribe)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		_, err := client.Subscribe(ctx, SubscribeOptions{AllBrowsers: true, Events: []model.EventType{model.EventTypeTabFocused, model.EventTypeBrowserDisconnected}})
		if err != nil {
			t.Fatalf("Subscribe with lifecycle events: %v", err)
		}
	})

	t.Run("指定浏览器拒绝订阅时返回错误", func(t *testing.T) {
		client, _ := newSubscriptionTestBrowser(t, rejectTabSubscribe)
		connectFakeBrowser(t, "chrome", json.RawMessage(`{"data":{}}`))
		_, err := client.Subscribe(context.Background(), SubscribeOptions{BrowserID: "zen", Events: []model.EventType{model.EventTypeTabFocused}})
		var commandErr *CommandError
		if !errors.As(err, &commandErr) || commandErr.Code != "UNKNOWN_COMMAND" {
			t.Fatalf("subscription error = %v, want UNKNOWN_COMMAND", err)
		}
	})
}
