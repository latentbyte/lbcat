package cmd

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

// stays under the 10 minute limit agent harnesses put on one shell command; the overlay
// survives a timeout, so the agent runs guide wait again
const defaultGuideWait = 9 * time.Minute

// parseGuideMark turns "LOCATOR|label" into a mark. LOCATOR is @ref, text=..., or a CSS
// selector; the label follows the last "|", so a selector containing "|" needs a label.
func parseGuideMark(raw string) (map[string]any, error) {
	locator, label := raw, ""
	if i := strings.LastIndex(raw, "|"); i >= 0 {
		locator, label = raw[:i], strings.TrimSpace(raw[i+1:])
	}
	locator = strings.TrimSpace(locator)
	mark := map[string]any{}
	switch {
	case strings.HasPrefix(locator, "@"):
		mark["ref"] = locator[1:]
	case strings.HasPrefix(locator, "text="):
		mark["text"] = strings.TrimPrefix(locator, "text=")
	default:
		mark["selector"] = locator
	}
	for _, value := range mark {
		if value == "" {
			return nil, fmt.Errorf("--mark %q needs a selector, @ref, or text=...", raw)
		}
	}
	if label != "" {
		mark["label"] = label
	}
	return mark, nil
}

func guideStepArgs(tabArg, text, title string, rawMarks []string) (map[string]any, error) {
	tabID, err := parseTabArg(tabArg)
	if err != nil {
		return nil, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("--text is required")
	}
	marks := []map[string]any{}
	for _, raw := range rawMarks {
		mark, err := parseGuideMark(raw)
		if err != nil {
			return nil, err
		}
		marks = append(marks, mark)
	}
	args := map[string]any{"tabId": tabID, "text": text, "marks": marks}
	if title = strings.TrimSpace(title); title != "" {
		args["title"] = title
	}
	return args, nil
}

// printGuideResponse prints the envelope for --json, otherwise only its data
func printGuideResponse(cmd *cobra.Command, resp json.RawMessage) error {
	if !flagJSON {
		var result struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			return err
		}
		resp = result.Data
	}
	_, err := fmt.Fprintln(cmd.OutOrStdout(), string(resp))
	return err
}

func guideWait(c *cli.Client, target string, tabID int, timeout time.Duration) (json.RawMessage, error) {
	args := map[string]any{"tabId": tabID, "timeoutMs": int(timeout / time.Millisecond)}
	return c.RequestWithTimeout(target, cli.ExtCommand{Cmd: "guide.wait", Args: args}, timeout+pageRequestMargin)
}

func newGuideCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "guide",
		Short: "Walk a human through a page step by step instead of acting for them",
		Long: `Walkthrough mode. Each step draws a card with instructions and highlighted marks on the page,
then blocks until the human responds in the browser:
  next       the human did the step (reply may carry a note)
  reply      the human sent a message; revise the current step
  talk       the human wants to discuss; stop and end the turn
  delegate   the human asks you to do this step yourself, then keep guiding
  navigated  the page changed; inspect it before the next step
  closed     the tab was closed or the guide was cleared
  timeout    nothing yet; the card stays up, run guide wait again
interactions lists clicks and inputs on marked elements since the last result.`,
	}

	step := &cobra.Command{
		Use:   "step <tab-id>",
		Short: "Show one step and wait for the human (prints the wait result as JSON)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			text, _ := cmd.Flags().GetString("text")
			title, _ := cmd.Flags().GetString("title")
			marks, _ := cmd.Flags().GetStringArray("mark")
			request, err := guideStepArgs(args[0], text, title, marks)
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
			resp, err := c.Request(target, cli.ExtCommand{Cmd: "guide.step", Args: request})
			if err != nil {
				return err
			}
			if noWait, _ := cmd.Flags().GetBool("no-wait"); noWait {
				return printGuideResponse(cmd, resp)
			}
			timeout, _ := cmd.Flags().GetDuration("timeout")
			if resp, err = guideWait(c, target, request["tabId"].(int), timeout); err != nil {
				return err
			}
			return printGuideResponse(cmd, resp)
		},
	}
	step.Flags().String("text", "", "instructions shown to the human, Markdown subset: lists, **bold**, *italic*, inline code, ``` fenced blocks with a copy button (required)")
	step.Flags().String("title", "", "card title (default: Agent walkthrough)")
	step.Flags().StringArray("mark", nil, `highlight an element: "@e12|label", "text=Save|label", or "css|label" (repeatable; unlabeled marks are numbered)`)
	step.Flags().Bool("no-wait", false, "draw the step and return without waiting")
	step.Flags().Duration("timeout", defaultGuideWait, "how long to wait before returning timeout")
	command.AddCommand(step)

	wait := &cobra.Command{
		Use:   "wait <tab-id>",
		Short: "Keep waiting on the current step (after a timeout or --no-wait)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			tabID, err := parseTabArg(args[0])
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
			timeout, _ := cmd.Flags().GetDuration("timeout")
			resp, err := guideWait(c, target, tabID, timeout)
			if err != nil {
				return err
			}
			return printGuideResponse(cmd, resp)
		},
	}
	wait.Flags().Duration("timeout", defaultGuideWait, "how long to wait before returning timeout")
	command.AddCommand(wait)

	command.AddCommand(&cobra.Command{
		Use:   "clear <tab-id>",
		Short: "Remove the guide card and marks from the page",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			tabID, err := parseTabArg(args[0])
			if err != nil {
				return err
			}
			resp, err := runAgentCommand(cmd, "guide.clear", map[string]any{"tabId": tabID})
			if err != nil {
				return err
			}
			return printGuideResponse(cmd, resp)
		},
	})
	return command
}

func init() { rootCmd.AddCommand(newGuideCmd()) }
