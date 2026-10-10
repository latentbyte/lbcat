package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

type monitorEntry struct {
	Time    float64 `json:"time"`
	Type    string  `json:"type"`
	Level   string  `json:"level"`
	Message string  `json:"message"`
	URL     string  `json:"url"`
}

type monitorBatch struct {
	Dropped int            `json:"dropped"`
	Entries []monitorEntry `json:"entries"`
}

var pageMonitorCmd = &cobra.Command{
	Use:   "monitor",
	Short: "Capture console errors, failed requests, and dialogs on a tab",
	Long: `Start a monitor, use the page, then read what went wrong.
Failed requests (HTTP >= 400 and network errors) persist across navigations. Console errors/warnings, uncaught
errors, unhandled rejections, and dialogs are hooked in the page and re-attached after each navigation; reload after
start to capture load-time output. Monitors live in the extension's background and end when it restarts.`,
}

// runMonitorCommand sends one monitor command and decodes the entry batch unless --json printed the raw response
func runMonitorCommand(cmd *cobra.Command, name string, args map[string]any) (*monitorBatch, error) {
	c, err := connectScoped()
	if err != nil {
		return nil, err
	}
	defer c.Close()
	target, err := resolveBrowser(c.Peers())
	if err != nil {
		return nil, err
	}
	resp, err := c.Request(target, cli.ExtCommand{Cmd: name, Args: args})
	if err != nil {
		return nil, err
	}
	if flagJSON {
		_, err := fmt.Fprintln(cmd.OutOrStdout(), string(resp))
		return nil, err
	}
	var result struct {
		Data monitorBatch `json:"data"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, fmt.Errorf("decoding %s response: %w", name, err)
	}
	return &result.Data, nil
}

func printMonitorBatch(out io.Writer, batch *monitorBatch) error {
	if batch.Dropped > 0 {
		if _, err := fmt.Fprintf(out, "[%d older entries dropped]\n", batch.Dropped); err != nil {
			return err
		}
	}
	for _, entry := range batch.Entries {
		label, message := entry.Type, entry.Message
		switch entry.Type {
		case "console":
			label += "." + entry.Level
		case "navigation":
			message = entry.URL
		case "error":
			if entry.URL != "" {
				message += " (" + entry.URL + ")"
			}
		}
		stamp := time.UnixMilli(int64(entry.Time)).Format("15:04:05.000")
		if _, err := fmt.Fprintf(out, "%s %s %s\n", stamp, label, message); err != nil {
			return err
		}
	}
	return nil
}

var pageMonitorStartCmd = &cobra.Command{
	Use:   "start <tab-id>",
	Short: "Start capturing on a tab (restarting keeps collected entries)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		dialogs, _ := cmd.Flags().GetString("dialogs")
		if dialogs != "pass" && dialogs != "accept" && dialogs != "dismiss" {
			return fmt.Errorf("--dialogs must be pass, accept, or dismiss")
		}
		if _, err := runMonitorCommand(cmd, "page.monitor.start", map[string]any{"tabId": tabID, "dialogs": dialogs}); err != nil || flagJSON {
			return err
		}
		_, err = fmt.Fprintf(cmd.OutOrStdout(), "monitoring tab %d (dialogs: %s)\n", tabID, dialogs)
		return err
	},
}

var pageMonitorReadCmd = &cobra.Command{
	Use:   "read <tab-id>",
	Short: "Print entries captured since the last read",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		request := map[string]any{"tabId": tabID}
		if keep, _ := cmd.Flags().GetBool("keep"); keep {
			request["keep"] = true
		}
		batch, err := runMonitorCommand(cmd, "page.monitor.read", request)
		if err != nil || batch == nil {
			return err
		}
		if len(batch.Entries) == 0 && batch.Dropped == 0 {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), "no new entries")
			return err
		}
		return printMonitorBatch(cmd.OutOrStdout(), batch)
	},
}

var pageMonitorStopCmd = &cobra.Command{
	Use:   "stop <tab-id>",
	Short: "Stop capturing and print entries not yet read",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		batch, err := runMonitorCommand(cmd, "page.monitor.stop", map[string]any{"tabId": tabID})
		if err != nil || batch == nil {
			return err
		}
		if err := printMonitorBatch(cmd.OutOrStdout(), batch); err != nil {
			return err
		}
		_, err = fmt.Fprintf(cmd.OutOrStdout(), "stopped monitoring tab %d\n", tabID)
		return err
	},
}

func init() {
	pageMonitorStartCmd.Flags().String("dialogs", "pass",
		"alert/confirm/prompt handling: pass (show to the user; blocks the page), accept, or dismiss")
	pageMonitorReadCmd.Flags().Bool("keep", false, "leave entries for the next read")
	pageMonitorCmd.AddCommand(pageMonitorStartCmd, pageMonitorReadCmd, pageMonitorStopCmd)
	pageCmd.AddCommand(pageMonitorCmd)
}
