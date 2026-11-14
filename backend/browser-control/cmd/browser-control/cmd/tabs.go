package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/cli"
	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol"
	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
	"github.com/spf13/cobra"
)

var tabsCmd = &cobra.Command{
	Use:   "tabs",
	Short: "Manage browser tabs",
}

var tabsListCmd = newTabsListCmd(false)

func newTabsListCmd(human bool) *cobra.Command {
	command := &cobra.Command{
		Use:   "list",
		Short: "List open tabs",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			allBrowsers, _ := cmd.Flags().GetBool("all-browsers")
			ctx := context.Background()
			opts := browsercontrol.ListTabsOptions{
				BrowserID:   browserIDFromFlag(),
				AllBrowsers: allBrowsers,
			}
			var client browsercontrol.Client
			var err error
			responseCommand := "tabs.list"
			if human {
				client, err = browsercontrol.NewSwitcher(ctx)
				responseCommand = "switcher.tabs.list"
			} else {
				client, err = browsercontrol.New(ctx)
				opts.SessionID = sessionFromFlag()
				opts.PersonalTabID = flagPersonalTab
				opts.NotifyMissingWindow = true
			}
			if err != nil {
				return err
			}
			defer client.Close()

			tabs, err := client.ListTabs(ctx, opts)
			if err != nil {
				return err
			}

			if flagJSON {
				data, err := json.Marshal(map[string]any{"cmd": responseCommand, "data": tabs})
				if err != nil {
					return err
				}
				_, err = fmt.Fprintln(cmd.OutOrStdout(), string(data))
				return err
			}

			for _, tab := range tabs {
				marker := " "
				if tab.Active {
					marker = "*"
				}
				title := tab.Title
				titleRunes := []rune(title)
				if len(titleRunes) > 60 {
					title = string(titleRunes[:57]) + "..."
				}
				if _, err := fmt.Fprintf(cmd.OutOrStdout(), " %s %-12s %5d  %-60s  %s\n", marker, tab.BrowserID, tab.ID, title, tab.URL); err != nil {
					return err
				}
			}
			return nil
		},
	}
	if human {
		command.Short = "List tabs across all browser windows without an agent session"
	}
	command.Flags().Bool("all-browsers", false, "list tabs from all connected browsers")
	return command
}

var tabsGetCmd = &cobra.Command{
	Use:   "get <tab-id>",
	Short: "Get details for a single tab",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid tab ID: %w", err)
		}

		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd:  "tabs.get",
			Args: map[string]any{"tabId": tabID},
		})
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		var result struct {
			Data struct {
				ID     int    `json:"id"`
				Title  string `json:"title"`
				URL    string `json:"url"`
				Active bool   `json:"active"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Println(string(resp))
			return nil
		}

		t := result.Data
		marker := " "
		if t.Active {
			marker = "*"
		}
		fmt.Printf(" %s %5d  %s\n         %s\n", marker, t.ID, t.Title, t.URL)
		return nil
	},
}

var tabsFocusCmd = &cobra.Command{
	Use:   "focus <tab-id>",
	Short: "Select a tab in the agent window (--foreground also focuses the window)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid tab ID: %w", err)
		}
		foreground, _ := cmd.Flags().GetBool("foreground")
		windowID, _ := cmd.Flags().GetInt("window")

		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		focusArgs := map[string]any{"tabId": tabID, "allowFocus": foreground}
		if windowID > 0 {
			focusArgs["windowId"] = windowID
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd:  "tabs.focus",
			Args: focusArgs,
		})
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		var result struct {
			Data struct {
				TabID    int `json:"tabId"`
				WindowID int `json:"windowId"`
			} `json:"data"`
		}
		out := cmd.OutOrStdout()
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Fprintln(out, string(resp))
			return nil
		}

		if !foreground {
			fmt.Fprintf(out, "selected tab %d in agent window %d (window not focused)\n", result.Data.TabID, result.Data.WindowID)
			return nil
		}
		if result.Data.WindowID > 0 {
			fmt.Fprintf(out, "focused tab %d in window %d\n", result.Data.TabID, result.Data.WindowID)
			return nil
		}
		fmt.Fprintf(out, "focused tab %d\n", result.Data.TabID)
		return nil
	},
}

// parseTabIDs validates every ID before any tab is touched
func parseTabIDs(args []string) ([]int, error) {
	tabIDs := make([]int, 0, len(args))
	for _, arg := range args {
		tabID, err := strconv.Atoi(arg)
		if err != nil || tabID < 0 {
			return nil, fmt.Errorf("invalid tab ID %q", arg)
		}
		tabIDs = append(tabIDs, tabID)
	}
	return tabIDs, nil
}

var tabsCloseCmd = &cobra.Command{
	Use:   "close <tab-id>...",
	Short: "Close agent-window tabs owned by this task",
	Long:  "Close agent-window work tabs owned by this task (or unowned). Personal tabs, other tasks' tabs, and the agent window marker are refused; use `human tabs close` for those.",
	Args:  cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabIDs, err := parseTabIDs(args)
		if err != nil {
			return err
		}

		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		for _, tabID := range tabIDs {
			resp, err := c.Request(target, cli.ExtCommand{Cmd: "tabs.close", Args: map[string]any{"tabId": tabID}})
			if err != nil {
				return fmt.Errorf("closing tab %d: %w", tabID, err)
			}
			if flagJSON {
				_, err = fmt.Fprintln(cmd.OutOrStdout(), string(resp))
			} else {
				_, err = fmt.Fprintf(cmd.OutOrStdout(), "closed tab %d\n", tabID)
			}
			if err != nil {
				return err
			}
		}
		return nil
	},
}

var tabsCreateCmd = &cobra.Command{
	Use:   "create <url>",
	Short: "Open a new tab",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		url := args[0]
		active, _ := cmd.Flags().GetBool("active")

		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		request, timeout, err := waitArgs(cmd, map[string]any{"url": url, "active": active, "allowFocus": active})
		if err != nil {
			return err
		}
		request["timeoutMs"] = int(timeout / time.Millisecond)
		resp, err := c.RequestWithTimeout(target, cli.ExtCommand{Cmd: "tabs.create", Args: request},
			timeout+pageRequestMargin)
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		var result struct {
			Data struct {
				ID     int    `json:"id"`
				Title  string `json:"title"`
				URL    string `json:"url"`
				Active bool   `json:"active"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Println(string(resp))
			return nil
		}

		t := result.Data
		fmt.Printf("created tab %d: %s\n", t.ID, t.URL)
		return nil
	},
}

var tabsWatchCmd = &cobra.Command{
	Use:   "watch",
	Short: "Stream tab events in real-time",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		// subscribe to tab events
		_, err = c.Request(target, cli.ExtCommand{
			Cmd: "tabs.subscribe",
			Args: map[string]any{
				"events": []string{"onCreated", "onRemoved", "onUpdated", "onActivated"},
			},
		})
		if err != nil {
			return err
		}

		fmt.Fprintln(cmd.ErrOrStderr(), "watching tab events (ctrl+c to stop)...")

		// read events until interrupted
		for {
			env, err := c.ReadEvent()
			if err != nil {
				return err
			}
			if flagJSON {
				fmt.Println(string(env.Payload))
			} else {
				fmt.Println(string(env.Payload))
			}
		}
	},
}

// tabsLinkCmd prints a link the human can click to bring the tab forward, for agents pointing at a tab in chat
var tabsLinkCmd = &cobra.Command{
	Use:   "link <tab-id>",
	Short: "Print a link that focuses the tab and raises its window when the human opens it",
	Long: `Print a link such as http://127.0.0.1:47823/tab/zen-01/116 that the human can click in chat to bring the tab
forward, across browsers, windows, and workspaces. The daemon answers it: it focuses the tab, raises its window, and
closes the browser tab the link opened in. "human tabs focus" also takes the link.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		if tabID <= 0 {
			return fmt.Errorf("tab ID must be a positive integer")
		}
		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()
		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(cmd.OutOrStdout(), browsercontrol.TabLink(model.BrowserID(target), int64(tabID)))
		return err
	},
}

func init() {
	tabsFocusCmd.Flags().Int("window", 0, "browser window ID to focus after activating the tab")
	tabsCreateCmd.Flags().Bool("active", false, "activate new tab within agent window")
	tabsFocusCmd.Flags().Bool("foreground", false, "also focus the browser window (without it, only selects the tab inside the agent window)")

	tabsCmd.AddCommand(tabsListCmd, tabsGetCmd, tabsFocusCmd, tabsCreateCmd, tabsCloseCmd, tabsWatchCmd, tabsLinkCmd)
	rootCmd.AddCommand(tabsCmd)
}
