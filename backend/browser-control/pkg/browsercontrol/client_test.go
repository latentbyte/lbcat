package browsercontrol

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
)

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
				"browserId":   "",
				"browserName": "chrome",
				"appName":     "Google Chrome",
				"id":          123,
				"windowId":    7,
				"index":       2,
				"title":       "Example",
				"url":         "https://example.com/",
				"active":      true,
				"incognito":   false,
				"audible":     false,
			},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("Marshal(payload) error = %v", err)
	}

	evt, ok := decodeEventEnvelope(&protocol.Envelope{
		Type:    protocol.MsgEvent,
		Source:  "chrome-01",
		Payload: raw,
	}, []model.EventType{model.EventTypeTabFocused})
	if !ok {
		t.Fatal("decodeEventEnvelope() ok = false")
	}

	if evt.BrowserID != "chrome-01" {
		t.Fatalf("BrowserID = %q, want chrome-01", evt.BrowserID)
	}
	if evt.Tab == nil || evt.Tab.BrowserID != "chrome-01" {
		t.Fatalf("Tab BrowserID = %#v, want chrome-01", evt.Tab)
	}
	if evt.TabID == nil || evt.TabID.Browser != "chrome-01" || evt.TabID.TabID != 123 {
		t.Fatalf("TabID = %#v, want chrome-01/123", evt.TabID)
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
