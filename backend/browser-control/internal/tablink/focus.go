// Package tablink opens tab links: it finds the linked tab, has its browser focus it, and asks the OS to raise its
// window. The CLI uses it for `human tabs focus`; the daemon serves it over http for chat apps that only open web links
package tablink

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/raise"
	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol"
	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
)

// Resolve maps a link's browser ID to a connected browser. An ID that went stale (the extension reconnected) falls
// back to the connected browser of the same name that has the tab
func Resolve(ctx context.Context, client browsercontrol.Client, browserID model.BrowserID, tabID int64, connected []string) (model.BrowserID, error) {
	if slices.Contains(connected, string(browserID)) {
		return browserID, nil
	}
	name := browsercontrol.BrowserNameFromID(string(browserID))
	var holders []string
	for _, id := range connected {
		if browsercontrol.BrowserNameFromID(id) != name {
			continue
		}
		tabs, err := client.ListTabs(ctx, browsercontrol.ListTabsOptions{BrowserID: model.BrowserID(id)})
		if err != nil {
			return "", fmt.Errorf("listing %s tabs: %w", id, err)
		}
		if slices.ContainsFunc(tabs, func(tab model.Tab) bool { return tab.ID == tabID }) {
			holders = append(holders, id)
		}
	}
	switch len(holders) {
	case 0:
		return "", fmt.Errorf("tab %d not found: %s is no longer connected and no connected %s browser has that tab", tabID, browserID, name)
	case 1:
		return model.BrowserID(holders[0]), nil
	default:
		return "", fmt.Errorf("tab %d is in several %s browsers (%s); focus it with --browser", tabID, name, strings.Join(holders, ", "))
	}
}

// Connected lists the IDs of the browsers connected to the daemon
func Connected(ctx context.Context, client browsercontrol.Client) ([]string, error) {
	status, err := client.Status(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(status.Browsers))
	for _, browser := range status.Browsers {
		ids = append(ids, string(browser.ID))
	}
	return ids, nil
}

// Focus has the browser focus the tab and raises its OS window through the first raiser that can find it. Raisers
// locate the window before the browser moves anything
func Focus(ctx context.Context, client browsercontrol.Client, browserID model.BrowserID, tabID int64, raisers []raise.Raiser) (browsercontrol.FocusTabResult, error) {
	var focused browsercontrol.FocusTabResult
	var focusErr error
	focus := func() error {
		focused, focusErr = client.FocusTab(ctx, browsercontrol.FocusTabRequest{BrowserID: browserID, TabID: tabID})
		if focusErr != nil {
			focusErr = fmt.Errorf("focusing tab %d: %w", tabID, focusErr)
		}
		return focusErr
	}
	if len(raisers) == 0 {
		return focused, focus()
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	tabs, err := client.ListTabs(ctx, browsercontrol.ListTabsOptions{AllBrowsers: true})
	if err != nil {
		return focused, fmt.Errorf("listing tabs to find the window: %w", err)
	}
	index := slices.IndexFunc(tabs, func(tab model.Tab) bool { return tab.BrowserID == browserID && tab.ID == tabID })
	if index < 0 {
		return focused, fmt.Errorf("tab %d not found in %s", tabID, browserID)
	}
	if _, err := raise.Window(ctx, raisers, tabs[index], tabs, focus); err != nil {
		if focusErr != nil {
			return focused, focusErr
		}
		return focused, fmt.Errorf("raising the window of tab %d: %w", tabID, err)
	}
	return focused, nil
}
