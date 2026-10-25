package cmd

import (
	"context"
	"fmt"

	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
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

// newHumanTabsFocusCmd brings a tab and its window to the front, eg from a notification click
func newHumanTabsFocusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "focus <tab-id>",
		Short: "Focus a tab in any window and raise that window",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			tabID, err := parseTabArg(args[0])
			if err != nil {
				return err
			}
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
			target, err := resolveBrowser(ids)
			if err != nil {
				return err
			}
			focused, err := client.FocusTab(ctx, browsercontrol.FocusTabRequest{BrowserID: model.BrowserID(target), TabID: int64(tabID)})
			if err != nil {
				return fmt.Errorf("focusing tab %d: %w", tabID, err)
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "focused tab %d in window %d\n", focused.TabID, focused.WindowID)
			return err
		},
	}
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
