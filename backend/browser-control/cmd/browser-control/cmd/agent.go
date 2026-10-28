package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol"
	"github.com/spf13/cobra"
)

func runAgentCommand(cmd *cobra.Command, name string, args map[string]any) (json.RawMessage, error) {
	response, _, err := requestAgent(name, args)
	return response, err
}

// requestAgent sends an extension command and also returns the resolved browser connection ID
func requestAgent(name string, args map[string]any) (json.RawMessage, string, error) {
	c, err := connectScoped()
	if err != nil {
		return nil, "", err
	}
	defer c.Close()
	target, err := resolveBrowser(c.Peers())
	if err != nil {
		return nil, "", err
	}
	response, err := c.Request(target, cli.ExtCommand{Cmd: name, Args: args})
	return response, target, err
}

func printAgentResponse(cmd *cobra.Command, name string, args map[string]any) error {
	response, err := runAgentCommand(cmd, name, args)
	if err != nil {
		return err
	}
	fmt.Fprintln(cmd.OutOrStdout(), string(response))
	return nil
}

// defaultApprovalWait stays under common 10-minute agent tool timeouts, like guide waits
const defaultApprovalWait = 9 * time.Minute

// awaitWindowApproval is swapped in tests
var awaitWindowApproval = cli.AwaitWindowApproval

// askCreateAgentWindow returns a live registration as is; otherwise it creates a window once
// the human clicks the approval notification
func askCreateAgentWindow(cmd *cobra.Command, timeout time.Duration) error {
	response, target, err := requestAgent("agentWindow.status", nil)
	var commandError *cli.CommandError
	if err == nil {
		fmt.Fprintln(cmd.OutOrStdout(), string(response))
		return nil
	}
	if !errors.As(err, &commandError) || commandError.Code != "AGENT_WINDOW_MISSING" {
		return err
	}
	if err := awaitWindowApproval(target, browsercontrol.BrowserNameFromID(target), timeout); err != nil {
		return err
	}
	return printAgentResponse(cmd, "agentWindow.create", nil)
}

func newAgentWindowCmd() *cobra.Command {
	command := &cobra.Command{Use: "agent-window", Short: "Manage the designated same-profile agent window"}
	create := &cobra.Command{
		Use: "create", Short: "create agent window", Args: cobra.NoArgs,
		Long: "Create a background agent window in the same profile.\n" +
			"--ask first reuses a live registration; when the window is missing it sends a click-to-allow\n" +
			"desktop notification and creates the window only after the click. No click within --timeout\n" +
			"fails with AGENT_WINDOW_APPROVAL_TIMEOUT.",
		RunE: func(cmd *cobra.Command, _ []string) error {
			if ask, _ := cmd.Flags().GetBool("ask"); ask {
				timeout, _ := cmd.Flags().GetDuration("timeout")
				return askCreateAgentWindow(cmd, timeout)
			}
			return printAgentResponse(cmd, "agentWindow.create", nil)
		},
	}
	create.Flags().Bool("ask", false, "ask the human to approve by notification click before creating")
	create.Flags().Duration("timeout", defaultApprovalWait, "with --ask, how long to wait for approval")
	command.AddCommand(create)
	command.AddCommand(&cobra.Command{
		Use: "approve <request-id>", Short: "Approve a pending create --ask (run by its notification click)",
		Args: cobra.ExactArgs(1), Hidden: true,
		RunE: func(_ *cobra.Command, args []string) error { return cli.ApproveWindow(args[0]) },
	})
	for _, operation := range []string{"status", "list", "clear"} {
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
				if len(args) > 0 {
					flagSession = args[0]
				}
				sessionID := sessionFromFlag()
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

// sessionBeginOutput prefixes the new session ID with the browser name ("zen:ab12cd34")
func sessionBeginOutput(response json.RawMessage, target string, asJSON bool) (string, error) {
	var result map[string]any
	if err := json.Unmarshal(response, &result); err != nil {
		return "", err
	}
	data, _ := result["data"].(map[string]any)
	sessionID, _ := data["sessionId"].(string)
	if sessionID == "" {
		return "", fmt.Errorf("session response missing sessionId")
	}
	handle := browsercontrol.BrowserNameFromID(target) + ":" + sessionID
	if !asJSON {
		return handle, nil
	}
	data["sessionId"] = handle
	output, err := json.Marshal(result)
	return string(output), err
}

func newSessionBeginCmd() *cobra.Command {
	begin := &cobra.Command{
		Use: "begin", Short: "Begin a task and print its session handle (<browser>:<id>)", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			args, err := sessionOpenArgs(cmd)
			if err != nil {
				return err
			}
			response, target, err := requestAgent("sessions.open", args)
			if err != nil {
				return err
			}
			output, err := sessionBeginOutput(response, target, flagJSON)
			if err != nil {
				return err
			}
			fmt.Fprintln(cmd.OutOrStdout(), output)
			return nil
		},
	}
	begin.Flags().Duration("ttl", 15*time.Minute, "session lease duration (extension default unless provided)")
	begin.Flags().String("label", "", "human-readable task name shown on agent tabs (defaults to BROWSER_CONTROL_LABEL)")
	return begin
}

func init() { rootCmd.AddCommand(newAgentWindowCmd(), newSessionCmd()) }
