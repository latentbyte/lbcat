package browsercontrol

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
)

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
