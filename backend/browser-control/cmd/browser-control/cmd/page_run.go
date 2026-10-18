package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

// runAction maps a step action to its extension command and defaults
type runAction struct {
	cmd      string
	defaults map[string]any
	timeout  time.Duration // default wait budget sent as timeoutMs; zero sends none
}

var navigationWait = map[string]any{"wait": "load"}

var runActions = map[string]runAction{
	"goto":     {"page.goto", navigationWait, 30 * time.Second},
	"back":     {"page.back", navigationWait, 30 * time.Second},
	"forward":  {"page.forward", navigationWait, 30 * time.Second},
	"reload":   {"page.reload", map[string]any{"wait": "load", "bypassCache": false}, 30 * time.Second},
	"click":    {"page.click", navigationWait, 30 * time.Second},
	"fill":     {"page.fill", navigationWait, 30 * time.Second},
	"select":   {"page.select", navigationWait, 30 * time.Second},
	"press":    {"page.press", navigationWait, 30 * time.Second},
	"wait":     {"page.wait", nil, 10 * time.Second},
	"content":  {"page.content", map[string]any{"selector": "body", "format": "text"}, 0},
	"snapshot": {"page.snapshot", nil, 0},
	"exec":     {"page.exec", map[string]any{"world": "MAIN"}, 45 * time.Second},
	"fetch":    {"page.fetch", nil, 30 * time.Second},
	"viewport": {"page.viewport", nil, 0},
}

type runStep struct {
	action  string
	cmd     string
	args    map[string]any
	timeout time.Duration
}

func parseRunSteps(data []byte, tabID int) ([]runStep, error) {
	var raw []map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		if bytes.HasPrefix(bytes.TrimSpace(data), []byte("[")) {
			return nil, fmt.Errorf("parsing steps: %w", err)
		}
		return nil, fmt.Errorf("steps must be a JSON array of {\"action\": ...} objects")
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("no steps")
	}
	steps := make([]runStep, len(raw))
	for i, fields := range raw {
		name, _ := fields["action"].(string)
		action, ok := runActions[name]
		if !ok {
			return nil, fmt.Errorf("step %d: unknown action %q", i+1, name)
		}
		args := map[string]any{"tabId": tabID}
		for key, value := range action.defaults {
			args[key] = value
		}
		timeout := action.timeout
		for key, value := range fields {
			switch key {
			case "action":
			case "timeout":
				text, _ := value.(string)
				parsed, err := time.ParseDuration(text)
				if err != nil || parsed <= 0 {
					return nil, fmt.Errorf("step %d: invalid timeout %v (use a duration like \"10s\")", i+1, value)
				}
				timeout = parsed
			case "ref":
				ref, _ := value.(string)
				args[key] = strings.TrimPrefix(ref, "@")
			default:
				args[key] = value
			}
		}
		if timeout > 0 {
			args["timeoutMs"] = int(timeout / time.Millisecond)
		}
		steps[i] = runStep{action: name, cmd: action.cmd, args: args, timeout: timeout}
	}
	return steps, nil
}

// summarizeStep renders a step result the way the matching single command would, compactly
func summarizeStep(action string, data json.RawMessage) (string, error) {
	switch action {
	case "content":
		var text string
		err := json.Unmarshal(data, &text)
		return "\n" + strings.TrimRight(text, "\n"), err
	case "snapshot":
		var snapshot pageSnapshot
		err := json.Unmarshal(data, &snapshot)
		return "\n" + strings.TrimRight(formatSnapshot(snapshot), "\n"), err
	case "exec":
		var value any
		if err := json.Unmarshal(data, &value); err != nil {
			return "", err
		}
		pretty, err := json.MarshalIndent(value, "", "  ")
		return "\n" + string(pretty), err
	case "fetch":
		var response struct {
			Status int    `json:"status"`
			OK     bool   `json:"ok"`
			Body   string `json:"body"`
		}
		if err := json.Unmarshal(data, &response); err != nil {
			return "", err
		}
		if !response.OK {
			return "", fmt.Errorf("HTTP %d", response.Status)
		}
		return "\n" + strings.TrimRight(response.Body, "\n"), nil
	case "viewport":
		var size struct{ Width, Height int }
		err := json.Unmarshal(data, &size)
		return fmt.Sprintf(" %dx%d", size.Width, size.Height), err
	}
	var result pageResult
	if err := json.Unmarshal(data, &result); err != nil {
		return "", err
	}
	if result.Matched == nil {
		return " " + result.URL, nil
	}
	line := " " + result.Matched.String()
	if result.Navigated {
		line += "; navigated to " + result.URL
	}
	return line, nil
}

var pageRunCmd = &cobra.Command{
	Use:   "run <tab-id> -f steps.json",
	Short: "Run a sequence of page steps, stopping at the first failure",
	Long: `Run steps from a JSON array over one connection, stopping at the first failure (non-zero exit).
Each step is {"action": ..., ...args}; args are the extension's argument names (camelCase), e.g.
  [{"action": "goto", "url": "https://example.com/login"},
   {"action": "fill", "text": "Email", "value": "a@b.c"},
   {"action": "click", "ref": "@e4", "timeout": "15s"},
   {"action": "wait", "selector": ".dashboard"},
   {"action": "content", "selector": "main", "format": "markdown", "maxChars": 4000}]
Actions: goto back forward reload click fill select press wait content snapshot exec fetch viewport.
Navigating actions wait for load unless "wait": "none". "timeout" takes a duration. Use -f - for stdin.
--json prints {steps: [{action, data}], failed?: {step, action, error}}.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		file, _ := cmd.Flags().GetString("file")
		if file == "" {
			return fmt.Errorf("provide steps with -f <file> (or -f - for stdin)")
		}
		var data []byte
		if file == "-" {
			data, err = io.ReadAll(cmd.InOrStdin())
		} else {
			data, err = os.ReadFile(file)
		}
		if err != nil {
			return fmt.Errorf("reading steps: %w", err)
		}
		steps, err := parseRunSteps(data, tabID)
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

		out := cmd.OutOrStdout()
		type stepResult struct {
			Action string          `json:"action"`
			Data   json.RawMessage `json:"data"`
		}
		var results []stepResult
		var failure error
		failedStep := 0
		for i, step := range steps {
			var resp json.RawMessage
			var err error
			if step.action == "viewport" {
				resp, err = requestViewport(c, target, step.args, cmd.ErrOrStderr())
			} else {
				resp, err = c.RequestWithTimeout(target, cli.ExtCommand{Cmd: step.cmd, Args: step.args}, step.timeout+pageRequestMargin)
			}
			var line string
			if err == nil {
				var envelope struct {
					Data json.RawMessage `json:"data"`
				}
				if err = json.Unmarshal(resp, &envelope); err == nil {
					results = append(results, stepResult{step.action, envelope.Data})
					line, err = summarizeStep(step.action, envelope.Data)
				}
			}
			if err != nil {
				failure = fmt.Errorf("step %d/%d (%s): %w", i+1, len(steps), step.action, err)
				failedStep = i + 1
				break
			}
			if !flagJSON {
				if _, err := fmt.Fprintf(out, "[%d/%d] %s:%s\n", i+1, len(steps), step.action, line); err != nil {
					return err
				}
			}
		}
		if flagJSON {
			report := map[string]any{"steps": results}
			if failure != nil {
				report["failed"] = map[string]any{"step": failedStep, "action": steps[failedStep-1].action, "error": failure.Error()}
			}
			encoded, err := json.Marshal(report)
			if err != nil {
				return err
			}
			if _, err := fmt.Fprintln(out, string(encoded)); err != nil {
				return err
			}
		}
		return failure
	},
}

func init() {
	pageRunCmd.Flags().StringP("file", "f", "", "JSON steps file, or - for stdin")
	pageCmd.AddCommand(pageRunCmd)
}
