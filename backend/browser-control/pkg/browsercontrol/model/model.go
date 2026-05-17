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
	BrowserID   BrowserID `json:"browserId"`
	BrowserName string    `json:"browserName"`
	AppName     string    `json:"appName"`
	ID          int64     `json:"id"`
	WindowID    int       `json:"windowId"`
	Index       int       `json:"index"`
	Title       string    `json:"title"`
	URL         string    `json:"url"`
	Active      bool      `json:"active"`
	Incognito   bool      `json:"incognito"`
	Audible     bool      `json:"audible"`
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

// Event is the stable public event envelope
type Event struct {
	Type      EventType `json:"type"`
	BrowserID BrowserID `json:"browserId,omitempty"`
	Tab       *Tab      `json:"tab,omitempty"`
	TabID     *TabID    `json:"tabId,omitempty"`
}
