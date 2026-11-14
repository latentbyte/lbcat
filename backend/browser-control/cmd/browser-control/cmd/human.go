package cmd

import (
	"context"
	"fmt"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/raise"
	"github.com/latentbyte/lbcat/backend/browser-control/internal/tablink"
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
http://127.0.0.1:47823/tab/zen-01/116 (or lbcat://tab/zen-01/116), which names its own browser. After the browser
focuses the tab, the OS window is raised through the first raiser that finds it: AeroSpace (switching workspace),
then macOS "open -a".`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := context.Background()
			client, err := browsercontrol.NewSwitcher(ctx)
			if err != nil {
				return err
			}
			defer client.Close()
			connected, err := tablink.Connected(ctx, client)
			if err != nil {
				return err
			}
			browserID, tabID, err := focusTarget(ctx, client, args[0], connected)
			if err != nil {
				return err
			}
			focused, err := tablink.Focus(ctx, client, browserID, tabID, windowRaisers())
			if focused.TabID != 0 {
				if _, printErr := fmt.Fprintf(cmd.OutOrStdout(), "focused tab %d in window %d\n", focused.TabID, focused.WindowID); printErr != nil {
					return printErr
				}
			}
			return err
		},
	}
}

// focusTarget reads a tab ID for the selected browser, or a tab link naming its own
func focusTarget(ctx context.Context, client browsercontrol.Client, arg string, connected []string) (model.BrowserID, int64, error) {
	if !browsercontrol.IsTabLink(arg) {
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
	browserID, err = tablink.Resolve(ctx, client, browserID, tabID, connected)
	return browserID, tabID, err
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
