package browsercontrol

import (
	"context"

	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
)

// Client is the stable public Browser Control API
type Client interface {
	ListTabs(ctx context.Context, opts ListTabsOptions) ([]model.Tab, error)
	FocusTab(ctx context.Context, req FocusTabRequest) (FocusTabResult, error)
	Subscribe(ctx context.Context, opts SubscribeOptions) (<-chan model.Event, error)
	Status(ctx context.Context) (Status, error)
	Close() error
}

// ListTabsOptions controls tab listing
type ListTabsOptions struct {
	BrowserID   model.BrowserID `json:"browserId,omitempty"`
	AllBrowsers bool            `json:"allBrowsers,omitempty"`
}

// FocusTabRequest identifies the tab to focus
type FocusTabRequest struct {
	BrowserID model.BrowserID `json:"browserId"`
	TabID     int64           `json:"tabId"`
	WindowID  int             `json:"windowId,omitempty"`
}

// FocusTabResult reports the focused tab
type FocusTabResult struct {
	BrowserID model.BrowserID `json:"browserId"`
	TabID     int64           `json:"tabId"`
	WindowID  int             `json:"windowId,omitempty"`
}

// SubscribeOptions controls event subscription
type SubscribeOptions struct {
	Events []model.EventType `json:"events,omitempty"`
}

// Status reports daemon and browser connection state
type Status struct {
	PID      int             `json:"pid"`
	Socket   string          `json:"socket"`
	Browsers []BrowserStatus `json:"browsers"`
}

// BrowserStatus reports one connected browser
type BrowserStatus struct {
	ID      model.BrowserID `json:"id"`
	Name    string          `json:"name"`
	AppName string          `json:"appName"`
}
