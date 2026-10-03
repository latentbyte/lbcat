package model

import (
	"encoding/json"
	"testing"
)

func TestSharingStateJSONRoundTrip(t *testing.T) {
	t.Parallel()
	for _, state := range []string{
		`{"camera":true,"microphone":true,"screen":"Window"}`,
		`{"camera":false,"microphone":false}`,
	} {
		t.Run(state, func(t *testing.T) {
			var event Event
			if err := json.Unmarshal([]byte(`{"type":"tab-updated","tab":{"sharingState":`+state+`}}`), &event); err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(event)
			if err != nil {
				t.Fatal(err)
			}
			var result struct {
				Tab struct {
					SharingState json.RawMessage `json:"sharingState"`
				} `json:"tab"`
			}
			if err := json.Unmarshal(data, &result); err != nil {
				t.Fatal(err)
			}
			if string(result.Tab.SharingState) != state {
				t.Fatalf("sharingState = %s, want %s", result.Tab.SharingState, state)
			}
		})
	}
}

func TestTabJSONStability(t *testing.T) {
	t.Parallel()

	tab := Tab{
		BrowserID:   BrowserID("chrome-01"),
		BrowserName: "chrome",
		AppName:     "Google Chrome",
		ID:          123,
		WindowID:    7,
		Index:       2,
		Title:       "Example",
		URL:         "https://example.com/",
		Active:      true,
		Incognito:   false,
		Audible:     true,
	}

	got, err := json.Marshal(tab)
	if err != nil {
		t.Fatalf("Marshal(Tab) error = %v", err)
	}

	want := `{"browserId":"chrome-01","browserName":"chrome","appName":"Google Chrome","id":123,"windowId":7,"index":2,"title":"Example","url":"https://example.com/","active":true,"incognito":false,"audible":true}`
	if string(got) != want {
		t.Fatalf("Marshal(Tab) = %s, want %s", got, want)
	}
}

func TestEventJSONStability(t *testing.T) {
	t.Parallel()

	evt := Event{
		Type:      EventTypeTabFocused,
		BrowserID: BrowserID("chrome-01"),
		TabID: &TabID{
			Browser:  BrowserID("chrome-01"),
			WindowID: 7,
			TabID:    123,
		},
	}

	got, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("Marshal(Event) error = %v", err)
	}

	want := `{"type":"tab-focused","browserId":"chrome-01","tabId":{"browser":"chrome-01","windowId":7,"tabId":123}}`
	if string(got) != want {
		t.Fatalf("Marshal(Event) = %s, want %s", got, want)
	}
}

func TestBrowserEventJSONStability(t *testing.T) {
	t.Parallel()

	evt := Event{
		Type:        EventTypeBrowserConnected,
		BrowserID:   BrowserID("chrome-01"),
		BrowserName: "chrome",
		AppName:     "Google Chrome",
	}

	got, err := json.Marshal(evt)
	if err != nil {
		t.Fatalf("Marshal(Event) error = %v", err)
	}

	want := `{"type":"browser-connected","browserId":"chrome-01","browserName":"chrome","appName":"Google Chrome"}`
	if string(got) != want {
		t.Fatalf("Marshal(Event) = %s, want %s", got, want)
	}
}
