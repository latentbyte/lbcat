package cmd

import (
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

var tabsCmd = &cobra.Command{
	Use:   "tabs",
	Short: "Manage browser tabs",
}

var tabsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List open tabs",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd: "tabs.list",
			Args: map[string]any{
				"query": map[string]any{},
			},
		})
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		// parse and display as table
		var result struct {
			Data []struct {
				ID     int    `json:"id"`
				Title  string `json:"title"`
				URL    string `json:"url"`
				Active bool   `json:"active"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			// fallback to raw JSON
			fmt.Println(string(resp))
			return nil
		}

		for _, tab := range result.Data {
			marker := " "
			if tab.Active {
				marker = "*"
			}
			title := tab.Title
			if len(title) > 60 {
				title = title[:57] + "..."
			}
			fmt.Printf(" %s %5d  %-60s  %s\n", marker, tab.ID, title, tab.URL)
		}
		return nil
	},
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

		c, err := cli.Connect()
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
	Short: "Focus an existing tab",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid tab ID: %w", err)
		}
		windowID, _ := cmd.Flags().GetInt("window")

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		focusArgs := map[string]any{"tabId": tabID}
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
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Println(string(resp))
			return nil
		}

		if result.Data.WindowID > 0 {
			fmt.Printf("focused tab %d in window %d\n", result.Data.TabID, result.Data.WindowID)
			return nil
		}
		fmt.Printf("focused tab %d\n", result.Data.TabID)
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

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd: "tabs.create",
			Args: map[string]any{
				"url":    url,
				"active": active,
			},
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
		fmt.Printf("created tab %d: %s\n", t.ID, t.URL)
		return nil
	},
}

var tabsWatchCmd = &cobra.Command{
	Use:   "watch",
	Short: "Stream tab events in real-time",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := cli.Connect()
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

func init() {
	tabsFocusCmd.Flags().Int("window", 0, "browser window ID to focus after activating the tab")
	tabsCreateCmd.Flags().Bool("active", true, "bring new tab to foreground")

	tabsCmd.AddCommand(tabsListCmd, tabsGetCmd, tabsFocusCmd, tabsCreateCmd, tabsWatchCmd)
	rootCmd.AddCommand(tabsCmd)
}
