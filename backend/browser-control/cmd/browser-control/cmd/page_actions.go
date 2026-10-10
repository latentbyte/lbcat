package cmd

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

// extra time over the browser-side timeout so the extension reports its own timeout error first
const pageRequestMargin = 5 * time.Second

type pageElement struct {
	Tag  string `json:"tag"`
	ID   string `json:"id,omitempty"`
	Text string `json:"text,omitempty"`
}

func (e *pageElement) String() string {
	if e == nil {
		return ""
	}
	label := "<" + e.Tag
	if e.ID != "" {
		label += "#" + e.ID
	}
	label += ">"
	if e.Text != "" {
		label += " " + strconv.Quote(e.Text)
	}
	return label
}

type pageResult struct {
	Matched   *pageElement `json:"matched"`
	Selected  string       `json:"selected"`
	Navigated bool         `json:"navigated"`
	URL       string       `json:"url"`
	Title     string       `json:"title"`
	ElapsedMs int          `json:"elapsedMs"`
}

// sendPageCommand runs one tab-scoped command and prints the raw response for --json
func sendPageCommand(cmd *cobra.Command, name string, args map[string]any, timeout time.Duration) (*pageResult, error) {
	if timeout > 0 {
		args["timeoutMs"] = int(timeout / time.Millisecond)
	}
	c, err := connectScoped()
	if err != nil {
		return nil, err
	}
	defer c.Close()
	target, err := resolveBrowser(c.Peers())
	if err != nil {
		return nil, err
	}
	resp, err := c.RequestWithTimeout(target, cli.ExtCommand{Cmd: name, Args: args}, timeout+pageRequestMargin)
	if err != nil {
		return nil, err
	}
	if flagJSON {
		_, err := fmt.Fprintln(cmd.OutOrStdout(), string(resp))
		return nil, err
	}
	var result struct {
		Data pageResult `json:"data"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, fmt.Errorf("decoding %s response: %w", name, err)
	}
	return &result.Data, nil
}

func parseTabArg(arg string) (int, error) {
	tabID, err := strconv.Atoi(arg)
	if err != nil {
		return 0, fmt.Errorf("invalid tab ID: %w", err)
	}
	return tabID, nil
}

// locatorArgs maps a positional selector (or @ref) plus --text/--nth to request args
func locatorArgs(cmd *cobra.Command, selector string, args map[string]any) map[string]any {
	if strings.HasPrefix(selector, "@") {
		args["ref"] = selector[1:]
	} else if selector != "" {
		args["selector"] = selector
	}
	if text, _ := cmd.Flags().GetString("text"); text != "" {
		args["text"] = text
	}
	if nth, _ := cmd.Flags().GetInt("nth"); nth > 0 {
		args["nth"] = nth
	}
	return args
}

func waitArgs(cmd *cobra.Command, args map[string]any) (map[string]any, time.Duration, error) {
	wait, _ := cmd.Flags().GetString("wait")
	if wait != "load" && wait != "none" {
		return nil, 0, fmt.Errorf("--wait must be load or none")
	}
	args["wait"] = wait
	timeout, _ := cmd.Flags().GetDuration("timeout")
	return args, timeout, nil
}

func printPageResult(cmd *cobra.Command, verb string, result *pageResult) error {
	if result == nil {
		return nil
	}
	line := verb
	if result.Matched != nil {
		line += " " + result.Matched.String()
	}
	if result.Selected != "" {
		line += " = " + strconv.Quote(result.Selected)
	}
	if result.Navigated {
		line += "; navigated to " + result.URL
	}
	_, err := fmt.Fprintln(cmd.OutOrStdout(), line)
	return err
}

func newPageActionCmd(use, short, verb, op string, minArgs, maxArgs int, build func(*cobra.Command, []string) (map[string]any, error)) *cobra.Command {
	command := &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.RangeArgs(minArgs, maxArgs),
		RunE: func(cmd *cobra.Command, args []string) error {
			tabID, err := parseTabArg(args[0])
			if err != nil {
				return err
			}
			request, err := build(cmd, args)
			if err != nil {
				return err
			}
			request["tabId"] = tabID
			request, timeout, err := waitArgs(cmd, request)
			if err != nil {
				return err
			}
			result, err := sendPageCommand(cmd, op, request, timeout)
			if err != nil {
				return err
			}
			return printPageResult(cmd, verb, result)
		},
	}
	command.Example = "  page click 12 'button[type=submit]'\n  page click 12 --text Save --nth 2\n  page click 12 @e7   # ref from page snapshot"
	command.Flags().String("text", "", "match by visible text, label, or placeholder (case-insensitive, exact before contains)")
	command.Flags().Int("nth", 0, "pick the Nth visible match (1-based) instead of failing with AMBIGUOUS_MATCH")
	command.Flags().String("wait", "load", "after the action: load (wait for any navigation it starts) or none")
	command.Flags().Duration("timeout", 30*time.Second, "max time to wait for navigation")
	return command
}

func optionalArg(args []string, index int) string {
	if len(args) > index {
		return args[index]
	}
	return ""
}

func requireLocator(cmd *cobra.Command, selector string) error {
	if text, _ := cmd.Flags().GetString("text"); selector == "" && text == "" {
		return fmt.Errorf("provide a selector or --text")
	}
	return nil
}

var pageClickCmd = newPageActionCmd("click <tab-id> [selector]", "Click an element by CSS selector or visible text",
	"clicked", "page.click", 1, 2, func(cmd *cobra.Command, args []string) (map[string]any, error) {
		selector := optionalArg(args, 1)
		if err := requireLocator(cmd, selector); err != nil {
			return nil, err
		}
		return locatorArgs(cmd, selector, map[string]any{}), nil
	})

func valueActionBuilder(cmd *cobra.Command, args []string) (map[string]any, error) {
	selector := optionalArg(args, 1)
	if err := requireLocator(cmd, selector); err != nil {
		return nil, err
	}
	if !cmd.Flags().Changed("value") {
		return nil, fmt.Errorf("--value is required")
	}
	value, _ := cmd.Flags().GetString("value")
	return locatorArgs(cmd, selector, map[string]any{"value": value}), nil
}

var pageFillCmd = newPageActionCmd("fill <tab-id> [selector] --value V",
	"Fill an input, textarea, or contenteditable (fires input/change like typing)",
	"filled", "page.fill", 1, 2, valueActionBuilder)

var pageSelectCmd = newPageActionCmd("select <tab-id> [selector] --value V", "Choose a <select> option by value or label",
	"selected", "page.select", 1, 2, valueActionBuilder)

var pagePressCmd = newPageActionCmd("press <tab-id> <key> [selector]",
	"Press a key (Enter, Escape, Control+a) on an element or the focused element",
	"pressed", "page.press", 2, 3, func(cmd *cobra.Command, args []string) (map[string]any, error) {
		return locatorArgs(cmd, optionalArg(args, 2), map[string]any{"key": args[1]}), nil
	})

func newPageNavigateCmd(use, short, verb, op string, exactArgs int, build func([]string) map[string]any) *cobra.Command {
	command := &cobra.Command{
		Use:   use,
		Short: short,
		Args:  cobra.ExactArgs(exactArgs),
		RunE: func(cmd *cobra.Command, args []string) error {
			tabID, err := parseTabArg(args[0])
			if err != nil {
				return err
			}
			request := build(args)
			request["tabId"] = tabID
			request, timeout, err := waitArgs(cmd, request)
			if err != nil {
				return err
			}
			result, err := sendPageCommand(cmd, op, request, timeout)
			if err != nil || result == nil {
				return err
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "%s tab %d: %s\n", verb, tabID, result.URL)
			return err
		},
	}
	addWaitFlags(command)
	return command
}

func addWaitFlags(command *cobra.Command) {
	command.Flags().String("wait", "load", "load (wait until the page finishes loading) or none")
	command.Flags().Duration("timeout", 30*time.Second, "max time to wait for the page to load")
}

var pageGotoCmd = newPageNavigateCmd("goto <tab-id> <url>", "Navigate a tab to a URL", "navigated", "page.goto", 2,
	func(args []string) map[string]any { return map[string]any{"url": args[1]} })

var pageBackCmd = newPageNavigateCmd("back <tab-id>", "Go back in tab history", "back", "page.back", 1,
	func([]string) map[string]any { return map[string]any{} })

var pageForwardCmd = newPageNavigateCmd("forward <tab-id>", "Go forward in tab history", "forward", "page.forward", 1,
	func([]string) map[string]any { return map[string]any{} })

var pageWaitCmd = &cobra.Command{
	Use:   "wait <tab-id>",
	Short: "Wait for page load, a URL, an element, or text",
	Long: `Wait until every given condition holds, in order: --load, --url, then --selector/--text.
All conditions share one --timeout. Fails with WAIT_TIMEOUT.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		request := map[string]any{"tabId": tabID}
		for _, name := range []string{"selector", "text", "url", "state"} {
			if value, _ := cmd.Flags().GetString(name); value != "" {
				request[name] = value
			}
		}
		if load, _ := cmd.Flags().GetBool("load"); load {
			request["load"] = true
		}
		if len(request) == 1 || (len(request) == 2 && request["state"] != nil) {
			return fmt.Errorf("provide --load, --url, --selector, or --text")
		}
		timeout, _ := cmd.Flags().GetDuration("timeout")
		result, err := sendPageCommand(cmd, "page.wait", request, timeout)
		if err != nil || result == nil {
			return err
		}
		line := fmt.Sprintf("ready after %dms: %s", result.ElapsedMs, result.URL)
		if result.Matched != nil {
			line += " " + result.Matched.String()
		}
		_, err = fmt.Fprintln(cmd.OutOrStdout(), line)
		return err
	},
}

type snapshotElement struct {
	Ref      string `json:"ref"`
	Role     string `json:"role"`
	Name     string `json:"name"`
	Value    string `json:"value"`
	Checked  *bool  `json:"checked"`
	Disabled bool   `json:"disabled"`
	Href     string `json:"href"`
	Level    int    `json:"level"`
}

type pageSnapshot struct {
	URL       string            `json:"url"`
	Title     string            `json:"title"`
	Elements  []snapshotElement `json:"elements"`
	Total     int               `json:"total"`
	Truncated bool              `json:"truncated"`
}

// formatSnapshot renders one element per line: @e3 textbox "Email" = "a@b.c" [disabled]
func formatSnapshot(snapshot pageSnapshot) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n%s\n", snapshot.Title, snapshot.URL)
	for _, el := range snapshot.Elements {
		if el.Role == "heading" {
			fmt.Fprintf(&b, "h%d %s\n", el.Level, strconv.Quote(el.Name))
			continue
		}
		fmt.Fprintf(&b, "@%s %s %s", el.Ref, el.Role, strconv.Quote(el.Name))
		if el.Value != "" {
			fmt.Fprintf(&b, " = %s", strconv.Quote(el.Value))
		}
		if el.Href != "" {
			fmt.Fprintf(&b, " -> %s", el.Href)
		}
		if el.Checked != nil {
			b.WriteString(map[bool]string{true: " [checked]", false: " [unchecked]"}[*el.Checked])
		}
		if el.Disabled {
			b.WriteString(" [disabled]")
		}
		b.WriteString("\n")
	}
	if snapshot.Truncated {
		fmt.Fprintf(&b, "[showing %d of %d; narrow --selector or raise --max]\n", len(snapshot.Elements), snapshot.Total)
	}
	return b.String()
}

var pageSnapshotCmd = &cobra.Command{
	Use:   "snapshot <tab-id>",
	Short: "List visible interactive elements and headings with refs for actions",
	Long: `List visible links, buttons, fields, and headings in document order, one per line.
Pass a ref to actions instead of a selector: page click <tab-id> @e12.
Refs stay stable for the same element across snapshots and expire when the page navigates.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		request := map[string]any{"tabId": tabID}
		if selector, _ := cmd.Flags().GetString("selector"); selector != "" {
			request["selector"] = selector
		}
		if limit, _ := cmd.Flags().GetInt("max"); limit > 0 {
			request["max"] = limit
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
		resp, err := c.Request(target, cli.ExtCommand{Cmd: "page.snapshot", Args: request})
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		if flagJSON {
			_, err := fmt.Fprintln(out, string(resp))
			return err
		}
		var result struct {
			Data pageSnapshot `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			return fmt.Errorf("decoding page.snapshot response: %w", err)
		}
		_, err = fmt.Fprint(out, formatSnapshot(result.Data))
		return err
	},
}

func init() {
	pageSelectCmd.Flags().String("value", "", "option value or visible label")
	pageFillCmd.Flags().String("value", "", "text to enter (replaces the current value)")

	pageWaitCmd.Flags().String("selector", "", "CSS selector to wait for")
	pageWaitCmd.Flags().String("text", "", "visible text to wait for (case-insensitive)")
	pageWaitCmd.Flags().String("state", "visible", "element state for --selector/--text: visible, attached, gone")
	pageWaitCmd.Flags().String("url", "", "regular expression the tab URL must match")
	pageWaitCmd.Flags().Bool("load", false, "wait until the tab finishes loading")
	pageWaitCmd.Flags().Duration("timeout", 10*time.Second, "max total wait")

	pageSnapshotCmd.Flags().String("selector", "", "only include elements inside the first match")
	pageSnapshotCmd.Flags().Int("max", 150, "max elements to list")

	addWaitFlags(pageReloadCmd)
	addWaitFlags(tabsCreateCmd)

	pageCmd.AddCommand(pageClickCmd, pageFillCmd, pageSelectCmd, pagePressCmd, pageWaitCmd,
		pageGotoCmd, pageBackCmd, pageForwardCmd, pageSnapshotCmd)
}
