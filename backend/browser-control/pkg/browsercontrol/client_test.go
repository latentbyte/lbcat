package browsercontrol

import (
	"context"
	"encoding/json"
	"errors"
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

func newSubscriptionTestBrowser(t *testing.T) (Client, func(model.EventType)) {
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
			writeMu.Lock()
			_ = protocol.WriteEnvelope(browser, &protocol.Envelope{ID: env.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(`{"data":{}}`)})
			writeMu.Unlock()
		}
	}()
	client, err := New(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client, func(typ model.EventType) {
		payload, err := json.Marshal(map[string]any{"cmd": "tabs.event", "data": model.Event{Type: typ}})
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
	}, []model.EventType{model.EventTypeTabFocused})
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
	evt, ok := decodeEventEnvelope(&protocol.Envelope{Type: protocol.MsgEvent, Source: "daemon", Payload: raw}, []model.EventType{model.EventTypeBrowserConnected})
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
	evt, ok := decodeEventEnvelope(&protocol.Envelope{Type: protocol.MsgEvent, Source: "firefox-01", Payload: raw}, nil)
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
