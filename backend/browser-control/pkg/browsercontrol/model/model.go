package model

// BrowserID identifies a connected browser instance
type BrowserID string

// TabID identifies a browser tab within a browser and window
type TabID struct {
	Browser  BrowserID `json:"browser"`
	WindowID int       `json:"windowId"`
	TabID    int64     `json:"tabId"`
}

// Tab is the stable public browser tab model
type Tab struct {
	BrowserID    BrowserID     `json:"browserId"`
	BrowserName  string        `json:"browserName"`
	AppName      string        `json:"appName"`
	ID           int64         `json:"id"`
	WindowID     int           `json:"windowId"`
	Index        int           `json:"index"`
	Title        string        `json:"title"`
	URL          string        `json:"url"`
	Status       string        `json:"status,omitempty"` // loading or complete
	Active       bool          `json:"active"`
	Incognito    bool          `json:"incognito"`
	Audible      bool          `json:"audible"`
	FavIconURL   string        `json:"favIconUrl,omitempty"` // http(s) or data: URL; empty when unknown
	SharingState *SharingState `json:"sharingState,omitempty"`
}

// SharingState reports browser-provided capture status; nil means unavailable
type SharingState struct {
	Camera     bool   `json:"camera"`
	Microphone bool   `json:"microphone"`
	Screen     string `json:"screen,omitempty"`
}

// EventType identifies a public Browser Control event kind
type EventType string

const (
	EventTypeTabFocused          EventType = "tab-focused"
	EventTypeTabRemoved          EventType = "tab-removed"
	EventTypeTabUpdated          EventType = "tab-updated"
	EventTypeTabCreated          EventType = "tab-created"
	EventTypeBrowserConnected    EventType = "browser-connected"
	EventTypeBrowserDisconnected EventType = "browser-disconnected"
)

// EventSource reports what caused a tab-focused event, so a consumer can tell a
// user's own switch from a focus the browser-control client asked for.
type EventSource string

const (
	// EventSourceUser is the default: the user switched tabs in the browser UI.
	EventSourceUser EventSource = "user"
	// EventSourceSwitcher marks a focus a human-operated switcher issued, which
	// is still a human choice.
	EventSourceSwitcher EventSource = "switcher"
	// EventSourceAgent marks a focus an agent command issued.
	EventSourceAgent EventSource = "agent"
)

// Event is the stable public event envelope. Source is set on tab-focused only.
type Event struct {
	Type        EventType   `json:"type"`
	Source      EventSource `json:"source,omitempty"`
	BrowserID   BrowserID   `json:"browserId,omitempty"`
	BrowserName string      `json:"browserName,omitempty"`
	AppName     string      `json:"appName,omitempty"`
	Tab         *Tab        `json:"tab,omitempty"`
	TabID       *TabID      `json:"tabId,omitempty"`
}
