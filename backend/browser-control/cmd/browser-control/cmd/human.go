package cmd

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/raise"
	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol"
	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
	"github.com/spf13/cobra"
)

func newHumanCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "human",
		Short: "Human-operated browser commands across all windows",
		Long:  "Human-operated browser commands across all windows. Lists tab metadata without an agent window or task session; does not grant page access or authenticate a human.",
	}
	tabs := &cobra.Command{Use: "tabs", Short: "Inspect, focus, and close tabs across all windows"}
	tabs.AddCommand(newTabsListCmd(true), newHumanTabsFocusCmd(), newHumanTabsCloseCmd())
	command.AddCommand(tabs)
	return command
}

// windowRaisers lists the OS window raisers human tabs focus tries; tests replace it
var windowRaisers = raise.Default

// newHumanTabsFocusCmd brings a tab and its window to the front, eg from a notification or tab link click
func newHumanTabsFocusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "focus <tab-id|tab-link>",
		Short: "Focus a tab in any window and raise that window",
		Long: `Focus a tab in any window and raise that window. Takes a tab ID, or a link from "tabs link" such as
lbcat://tab/zen-01/116, which names its own browser. After the browser focuses the tab, the OS window is raised
through the first raiser that finds it: AeroSpace (switching workspace), then macOS "open -a".`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := context.Background()
			client, err := browsercontrol.NewSwitcher(ctx)
			if err != nil {
				return err
			}
			defer client.Close()
			status, err := client.Status(ctx)
			if err != nil {
				return err
			}
			ids := make([]string, 0, len(status.Browsers))
			for _, browser := range status.Browsers {
				ids = append(ids, string(browser.ID))
			}
			browserID, tabID, err := focusTarget(ctx, client, args[0], ids)
			if err != nil {
				return err
			}
			focused, err := client.FocusTab(ctx, browsercontrol.FocusTabRequest{BrowserID: browserID, TabID: tabID})
			if err != nil {
				return fmt.Errorf("focusing tab %d: %w", tabID, err)
			}
			if _, err := fmt.Fprintf(cmd.OutOrStdout(), "focused tab %d in window %d\n", focused.TabID, focused.WindowID); err != nil {
				return err
			}
			return raiseTabWindow(ctx, client, browserID, focused.TabID)
		},
	}
}

// focusTarget reads a tab ID or tab link. A link whose browser ID went stale (the extension reconnected) falls back
// to the connected browser of the same name that has the tab
func focusTarget(ctx context.Context, client browsercontrol.Client, arg string, connected []string) (model.BrowserID, int64, error) {
	if !strings.HasPrefix(arg, browsercontrol.LinkScheme+":") {
		tabID, err := parseTabArg(arg)
		if err != nil {
			return "", 0, err
		}
		target, err := resolveBrowser(connected)
		return model.BrowserID(target), int64(tabID), err
	}
	browserID, tabID, err := browsercontrol.ParseTabLink(arg)
	if err != nil {
		return "", 0, err
	}
	if slices.Contains(connected, string(browserID)) {
		return browserID, tabID, nil
	}
	name := browsercontrol.BrowserNameFromID(string(browserID))
	var holders []string
	for _, id := range connected {
		if browsercontrol.BrowserNameFromID(id) != name {
			continue
		}
		tabs, err := client.ListTabs(ctx, browsercontrol.ListTabsOptions{BrowserID: model.BrowserID(id)})
		if err != nil {
			return "", 0, fmt.Errorf("listing %s tabs: %w", id, err)
		}
		if slices.ContainsFunc(tabs, func(tab model.Tab) bool { return tab.ID == tabID }) {
			holders = append(holders, id)
		}
	}
	switch len(holders) {
	case 0:
		return "", 0, fmt.Errorf("tab %d not found: %s is no longer connected and no connected %s browser has that tab", tabID, browserID, name)
	case 1:
		return model.BrowserID(holders[0]), tabID, nil
	default:
		return "", 0, fmt.Errorf("tab %d is in several %s browsers (%s); focus it with --browser", tabID, name, strings.Join(holders, ", "))
	}
}

// raiseTabWindow asks the OS to bring the focused tab's window forward
func raiseTabWindow(ctx context.Context, client browsercontrol.Client, browserID model.BrowserID, tabID int64) error {
	raisers := windowRaisers()
	if len(raisers) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tabs, err := client.ListTabs(ctx, browsercontrol.ListTabsOptions{AllBrowsers: true})
	if err != nil {
		return fmt.Errorf("listing tabs to raise the window: %w", err)
	}
	index := slices.IndexFunc(tabs, func(tab model.Tab) bool { return tab.BrowserID == browserID && tab.ID == tabID })
	if index < 0 {
		return fmt.Errorf("tab %d disappeared before its window was raised", tabID)
	}
	if _, err := raise.Window(ctx, raisers, tabs[index], tabs); err != nil {
		return fmt.Errorf("raising the window of tab %d: %w", tabID, err)
	}
	return nil
}

func newHumanTabsCloseCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "close <tab-id>...",
		Short: "Close tabs in any window (the agent window marker is protected)",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			tabIDs, err := parseTabIDs(args)
			if err != nil {
				return err
			}
			ctx := context.Background()
			client, err := browsercontrol.NewSwitcher(ctx)
			if err != nil {
				return err
			}
			defer client.Close()
			for _, tabID := range tabIDs {
				if err := client.CloseTab(ctx, browsercontrol.CloseTabRequest{BrowserID: browserIDFromFlag(), TabID: int64(tabID)}); err != nil {
					return fmt.Errorf("closing tab %d: %w", tabID, err)
				}
				if _, err := fmt.Fprintf(cmd.OutOrStdout(), "closed tab %d\n", tabID); err != nil {
					return err
				}
			}
			return nil
		},
	}
}

func init() {
	rootCmd.AddCommand(newHumanCmd())
}
