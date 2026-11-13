package cmd

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

var noteKinds = []string{"info", "needs-human", "done"}

// noteAddArgs builds notes.add arguments from "<tab-id> <text...>".
func noteAddArgs(args []string, kind string) (map[string]any, error) {
	tabID, err := strconv.Atoi(args[0])
	if err != nil || tabID <= 0 {
		return nil, fmt.Errorf("tab ID must be a positive integer")
	}
	valid := false
	for _, item := range noteKinds {
		valid = valid || item == kind
	}
	if !valid {
		return nil, fmt.Errorf("--kind must be one of %s", strings.Join(noteKinds, ", "))
	}
	return map[string]any{"tabId": tabID, "kind": kind, "text": strings.Join(args[1:], " ")}, nil
}

// notifyNoteAdded pings the human for needs-human notes, which block the agent; other kinds wait in the popup
func notifyNoteAdded(kind, text, browserID string, tabID int) {
	if kind == "needs-human" {
		cli.NotifyNeedsHuman(notificationSummary(text), browserID, tabID)
	}
}

// waitForNote polls until a human acknowledges, replies to, or resolves the note.
func waitForNote(get func() (json.RawMessage, error), interval, timeout time.Duration) (json.RawMessage, error) {
	deadline := time.Now().Add(timeout)
	for {
		response, err := get()
		if err != nil {
			return nil, err
		}
		var result struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(response, &result); err != nil {
			return nil, err
		}
		var note struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(result.Data, &note); err != nil {
			return nil, err
		}
		if note.Status != "open" {
			return result.Data, nil
		}
		if !time.Now().Add(interval).Before(deadline) {
			return nil, fmt.Errorf("note still open after %v", timeout)
		}
		time.Sleep(interval)
	}
}

func newNoteCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "note",
		Short: "Leave page notes for the human operator and read their replies",
		Long:  "Page-level notes shown in the LBCat popup for the tab's URL. Humans can acknowledge, reply to, or resolve them.",
	}

	add := &cobra.Command{
		Use: "add <tab-id> <text...>", Short: "Attach a note to a tab's page and print its ID", Args: cobra.MinimumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			kind, _ := cmd.Flags().GetString("kind")
			request, err := noteAddArgs(args, kind)
			if err != nil {
				return err
			}
			response, browserID, err := requestAgent("notes.add", request)
			if err != nil {
				return err
			}
			notifyNoteAdded(kind, strings.Join(args[1:], " "), browserID, request["tabId"].(int))
			if flagJSON {
				fmt.Fprintln(cmd.OutOrStdout(), string(response))
				return nil
			}
			var result struct {
				Data struct {
					ID string `json:"id"`
				} `json:"data"`
			}
			if err := json.Unmarshal(response, &result); err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), result.Data.ID)
			return nil
		},
	}
	add.Flags().String("kind", "info", "note kind: "+strings.Join(noteKinds, ", "))
	command.AddCommand(add)

	list := &cobra.Command{
		Use: "list", Short: "List notes left by the current session (all sessions without one)", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			args := map[string]any{}
			if status, _ := cmd.Flags().GetString("status"); status != "" {
				args["status"] = status
			}
			return printAgentResponse(cmd, "notes.list", args)
		},
	}
	list.Flags().String("status", "", "filter by status: open, acknowledged, resolved")
	command.AddCommand(list)

	for _, operation := range []struct{ name, remote, short string }{
		{"get", "notes.get", "Show a note with its status and human reply"},
		{"resolve", "notes.resolve", "Mark a note resolved"},
	} {
		command.AddCommand(&cobra.Command{
			Use: operation.name + " <note-id>", Short: operation.short, Args: cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				return printAgentResponse(cmd, operation.remote, map[string]any{"id": args[0]})
			},
		})
	}

	wait := &cobra.Command{
		Use: "wait <note-id>", Short: "Block until a human acknowledges, replies to, or resolves a note", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			timeout, _ := cmd.Flags().GetDuration("timeout")
			interval, _ := cmd.Flags().GetDuration("interval")
			if timeout <= 0 || interval <= 0 {
				return fmt.Errorf("--timeout and --interval must be positive")
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
			note, err := waitForNote(func() (json.RawMessage, error) {
				return c.Request(target, cli.ExtCommand{Cmd: "notes.get", Args: map[string]any{"id": args[0]}})
			}, interval, timeout)
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), string(note))
			return nil
		},
	}
	wait.Flags().Duration("timeout", 10*time.Minute, "give up after this long")
	wait.Flags().Duration("interval", 2*time.Second, "poll interval")
	command.AddCommand(wait)
	return command
}

func init() { rootCmd.AddCommand(newNoteCmd()) }
