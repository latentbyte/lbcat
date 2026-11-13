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

func (a Aerospace) Raise(ctx context.Context, tab model.Tab, tabs []model.Tab) error {
	output, err := exec.CommandContext(ctx, a.Path, "list-windows", "--all", "--json").Output()
	if err != nil {
		return fmt.Errorf("listing windows: %w", err)
	}
	var windows []osWindow
	if err := json.Unmarshal(output, &windows); err != nil {
		return fmt.Errorf("reading window list: %w", err)
	}
	window, ok := matchWindow(tab, tabs, windows)
	if !ok {
		return ErrNoWindow
	}
	if output, err := exec.CommandContext(ctx, a.Path, "focus", "--window-id", strconv.Itoa(window.ID)).CombinedOutput(); err != nil {
		return fmt.Errorf("focusing window %d: %w: %s", window.ID, err, strings.TrimSpace(string(output)))
	}
	return nil
}

// matchWindow finds the OS window showing tab. The browser app's only window wins outright; otherwise the window
// title follows the active tab, so the one window whose title contains the tab's title, unless another window of
// the same app shows a tab with that title too
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
	if tab.Title == "" {
		return osWindow{}, false
	}
	for _, other := range tabs {
		sameWindow := other.BrowserID == tab.BrowserID && other.WindowID == tab.WindowID
		if other.Active && !sameWindow && other.AppName == tab.AppName && other.Title == tab.Title {
			return osWindow{}, false
		}
	}
	var match osWindow
	matches := 0
	for _, window := range appWindows {
		if strings.Contains(window.Title, tab.Title) {
			match = window
			matches++
		}
	}
	return match, matches == 1
}
