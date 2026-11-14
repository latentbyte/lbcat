package raise

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"

	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
)

// Aerospace focuses the window through the AeroSpace window manager, which also switches to its workspace
type Aerospace struct{ Path string }

// osWindow is one window as AeroSpace lists it
type osWindow struct {
	ID    int    `json:"window-id"`
	App   string `json:"app-name"`
	Title string `json:"window-title"`
}

func (Aerospace) Name() string { return "aerospace" }

func (a Aerospace) Locate(ctx context.Context, tab model.Tab, tabs []model.Tab) (func(context.Context) error, error) {
	output, err := exec.CommandContext(ctx, a.Path, "list-windows", "--all", "--json").Output()
	if err != nil {
		return nil, fmt.Errorf("listing windows: %w", err)
	}
	var windows []osWindow
	if err := json.Unmarshal(output, &windows); err != nil {
		return nil, fmt.Errorf("reading window list: %w", err)
	}
	window, ok := matchWindow(tab, tabs, windows)
	if !ok {
		return nil, ErrNoWindow
	}
	return func(ctx context.Context) error {
		if output, err := exec.CommandContext(ctx, a.Path, "focus", "--window-id", strconv.Itoa(window.ID)).CombinedOutput(); err != nil {
			return fmt.Errorf("focusing window %d: %w: %s", window.ID, err, strings.TrimSpace(string(output)))
		}
		return nil
	}, nil
}

// matchWindow finds the OS window holding tab before the browser switches to it. The browser app's only window wins
// outright; otherwise a window's title follows its active tab, so the one window whose title contains the title of
// the active tab in tab's window, unless another window of the same app shows a tab with that title too
func matchWindow(tab model.Tab, tabs []model.Tab, windows []osWindow) (osWindow, bool) {
	var appWindows []osWindow
	for _, window := range windows {
		if window.App == tab.AppName {
			appWindows = append(appWindows, window)
		}
	}
	if len(appWindows) == 1 {
		return appWindows[0], true
	}
	sameWindow := func(other model.Tab) bool { return other.BrowserID == tab.BrowserID && other.WindowID == tab.WindowID }
	shown := ""
	for _, other := range tabs {
		if other.Active && sameWindow(other) {
			shown = other.Title
		}
	}
	if shown == "" {
		return osWindow{}, false
	}
	for _, other := range tabs {
		if other.Active && !sameWindow(other) && other.AppName == tab.AppName && other.Title == shown {
			return osWindow{}, false
		}
	}
	var match osWindow
	matches := 0
	for _, window := range appWindows {
		if strings.Contains(window.Title, shown) {
			match = window
			matches++
		}
	}
	return match, matches == 1
}
