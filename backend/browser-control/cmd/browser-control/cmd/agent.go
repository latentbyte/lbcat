package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

func runAgentCommand(cmd *cobra.Command, name string, args map[string]any) (json.RawMessage, error) {
	c, err := connectScoped()
	if err != nil {
		return nil, err
	}
	defer c.Close()
	target, err := resolveBrowser(c.Peers())
	if err != nil {
		return nil, err
	}
	return c.Request(target, cli.ExtCommand{Cmd: name, Args: args})
}

func printAgentResponse(cmd *cobra.Command, name string, args map[string]any) error {
	response, err := runAgentCommand(cmd, name, args)
	if err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), string(response))
	return nil
}

func newAgentWindowCmd() *cobra.Command {
	command := &cobra.Command{Use: "agent-window", Short: "Manage the designated same-profile agent window"}
	for _, operation := range []string{"create", "status", "list", "clear"} {
		command.AddCommand(&cobra.Command{
			Use: operation, Short: operation + " agent window", Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, _ []string) error {
				return printAgentResponse(cmd, "agentWindow."+operation, nil)
			},
		})
	}
	command.AddCommand(&cobra.Command{
		Use: "designate <window-id>", Short: "Explicitly designate an existing normal browser window", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			windowID, err := strconv.Atoi(args[0])
			if err != nil || windowID <= 0 {
				return fmt.Errorf("window ID must be a positive integer")
			}
			return printAgentResponse(cmd, "agentWindow.designate", map[string]any{"windowId": windowID})
		},
	})
	return command
}

func newSessionCmd() *cobra.Command {
	command := &cobra.Command{Use: "session", Short: "Manage agent task sessions and exclusive tab ownership"}
	command.AddCommand(newSessionBeginCmd())
	command.AddCommand(&cobra.Command{
		Use: "list", Short: "List active task sessions and owned tab IDs", Args: cobra.NoArgs,
		Long: "List active task sessions with expiry, pause state, and owned tabs. Needs no session.\n" +
			"Each session has tabIds and a parallel tabs array of {id, origin}; origin is the tab's current\n" +
			"http(s) scheme://host[:port] or null, never its path, query, or title.",
		RunE: func(cmd *cobra.Command, _ []string) error { return printAgentResponse(cmd, "sessions.list", nil) },
	})
	for _, operation := range []struct{ name, remote string }{{"renew", "renew"}, {"end", "close"}, {"pause", "pause"}, {"resume", "resume"}} {
		child := &cobra.Command{
			Use: operation.name + " [session-id]", Short: operation.name + " a task session", Args: cobra.MaximumNArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				sessionID := sessionFromFlag()
				if len(args) > 0 {
					sessionID = args[0]
				}
				if sessionID == "" {
					return fmt.Errorf("provide session ID or --session")
				}
				request := map[string]any{"sessionId": sessionID}
				if closeTabs, _ := cmd.Flags().GetBool("close-tabs"); closeTabs {
					request["closeTabs"] = true
				}
				return printAgentResponse(cmd, "sessions."+operation.remote, request)
			},
		}
		if operation.name == "end" {
			child.Flags().Bool("close-tabs", false,
				"also close the task's agent-window work tabs (personal tabs and paused tasks' tabs stay open)")
		}
		command.AddCommand(child)
	}
	command.AddCommand(&cobra.Command{
		Use: "claim <tab-id>", Short: "Claim an agent tab for the current task", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			tabID, err := strconv.Atoi(args[0])
			if err != nil || tabID <= 0 {
				return fmt.Errorf("tab ID must be a positive integer")
			}
			sessionID := sessionFromFlag()
			if sessionID == "" {
				return fmt.Errorf("provide --session or BROWSER_CONTROL_SESSION")
			}
			return printAgentResponse(cmd, "sessions.claim", map[string]any{"sessionId": sessionID, "tabId": tabID})
		},
	})
	return command
}

// sessionOpenArgs builds sessions.open arguments from the begin flags and environment.
func sessionOpenArgs(cmd *cobra.Command) (map[string]any, error) {
	args := map[string]any{}
	if cmd.Flags().Changed("ttl") {
		ttl, _ := cmd.Flags().GetDuration("ttl")
		if ttl <= 0 {
			return nil, fmt.Errorf("--ttl must be positive")
		}
		args["ttlMs"] = ttl.Milliseconds()
	}
	label, _ := cmd.Flags().GetString("label")
	if label == "" {
		label = os.Getenv("BROWSER_CONTROL_LABEL")
	}
	if label != "" {
		args["label"] = label
	}
	return args, nil
}

func newSessionBeginCmd() *cobra.Command {
	begin := &cobra.Command{
		Use: "begin", Short: "Begin a task and print its session ID", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			args, err := sessionOpenArgs(cmd)
			if err != nil {
				return err
			}
			response, err := runAgentCommand(cmd, "sessions.open", args)
			if err != nil {
				return err
			}
			if flagJSON {
				fmt.Fprintln(cmd.OutOrStdout(), string(response))
				return nil
			}
			var result struct {
				Data struct {
					SessionID string `json:"sessionId"`
				} `json:"data"`
			}
			if err := json.Unmarshal(response, &result); err != nil {
				return err
			}
			if result.Data.SessionID == "" {
				return fmt.Errorf("session response missing sessionId")
			}
			fmt.Fprintln(cmd.OutOrStdout(), result.Data.SessionID)
			return nil
		},
	}
	begin.Flags().Duration("ttl", 15*time.Minute, "session lease duration (extension default unless provided)")
	begin.Flags().String("label", "", "human-readable task name shown on agent tabs (defaults to BROWSER_CONTROL_LABEL)")
	return begin
}

func init() { rootCmd.AddCommand(newAgentWindowCmd(), newSessionCmd()) }
