package cmd

import (
	"encoding/json"
	"fmt"
	"os"
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
	Matched       *pageElement     `json:"matched"`
	Selected      string           `json:"selected"`
	Navigated     bool             `json:"navigated"`
	URL           string           `json:"url"`
	Title         string           `json:"title"`
	ElapsedMs     int              `json:"elapsedMs"`
	Snapshot      *pageSnapshot    `json:"snapshot"`
	Changes       *snapshotChanges `json:"changes"`
	SnapshotError string           `json:"snapshotError"`
}

// snapshotChanges is what an action changed in the snapshot; Count is set when the lists are truncated
type snapshotChanges struct {
	Added     []snapshotElement `json:"added"`
	Removed   []snapshotElement `json:"removed"`
	Changed   []snapshotElement `json:"changed"`
	Total     int               `json:"total"`
	Truncated bool              `json:"truncated"`
	Count     int               `json:"count"`
}

// formatObservation renders the snapshot an action asked for, one line per element, or "" when none
func formatObservation(result *pageResult) string {
	switch {
	case result.SnapshotError != "":
		return "snapshot unavailable: " + result.SnapshotError + "\n"
	case result.Snapshot != nil:
		return formatSnapshot(*result.Snapshot)
	case result.Changes == nil:
		return ""
	}
	changes := result.Changes
	var b strings.Builder
	for _, group := range []struct {
		mark     string
		elements []snapshotElement
	}{{"+", changes.Added}, {"-", changes.Removed}, {"~", changes.Changed}} {
		for _, el := range group.elements {
			fmt.Fprintf(&b, "%s %s\n", group.mark, formatElement(el))
		}
	}
	if b.Len() == 0 {
		return "snapshot unchanged\n"
	}
	if changes.Truncated {
		shown := len(changes.Added) + len(changes.Removed) + len(changes.Changed)
		fmt.Fprintf(&b, "[showing %d of %d changes; run page snapshot for the full list]\n", shown, changes.Count)
	}
	return b.String()
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
	return decodePageResult(cmd, name, resp)
}

// decodePageResult prints the raw response for --json (returning nil) or decodes it
func decodePageResult(cmd *cobra.Command, name string, resp []byte) (*pageResult, error) {
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
	_, err := fmt.Fprint(cmd.OutOrStdout(), line+"\n"+formatObservation(result))
	return err
}

func addSnapshotFlag(command *cobra.Command) {
	command.Flags().String("snapshot", "diff",
		"after the action: diff (snapshot lines it added +, removed -, or changed ~; a full snapshot after loading a new document), full, or none")
}

func snapshotArgs(cmd *cobra.Command, args map[string]any) error {
	switch mode, _ := cmd.Flags().GetString("snapshot"); mode {
	case "diff", "full":
		args["snapshot"] = mode
	case "none":
	default:
		return fmt.Errorf("--snapshot must be diff, full, or none")
	}
	return nil
}

// parsePoint reads viewport CSS pixel coordinates given as x,y
func parsePoint(value string) (float64, float64, error) {
	xText, yText, ok := strings.Cut(value, ",")
	x, xErr := strconv.ParseFloat(strings.TrimSpace(xText), 64)
	y, yErr := strconv.ParseFloat(strings.TrimSpace(yText), 64)
	if !ok || xErr != nil || yErr != nil {
		return 0, 0, fmt.Errorf("--at must be x,y in viewport CSS pixels, got %q", value)
	}
	return x, y, nil
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
			if err := snapshotArgs(cmd, request); err != nil {
				return err
			}
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
	command.Example = "  page click 12 'button[type=submit]'\n  page click 12 --text Save --nth 2\n  page click 12 @e7   # ref from page snapshot\n  page click 12 --at 640,380   # viewport CSS pixels"
	command.Flags().String("text", "", "match by visible text, label, or placeholder (case-insensitive, exact before contains)")
	command.Flags().Int("nth", 0, "pick the Nth visible match (1-based) instead of failing with AMBIGUOUS_MATCH")
	command.Flags().String("wait", "load", "after the action: load (wait for any navigation it starts) or none")
	command.Flags().Duration("timeout", 30*time.Second, "max time to wait for navigation")
	addSnapshotFlag(command)
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

var pageClickCmd = newPageActionCmd("click <tab-id> [selector]",
	"Click an element by CSS selector, visible text, ref, or viewport coordinates",
	"clicked", "page.click", 1, 2, func(cmd *cobra.Command, args []string) (map[string]any, error) {
		selector := optionalArg(args, 1)
		text, _ := cmd.Flags().GetString("text")
		if at, _ := cmd.Flags().GetString("at"); at != "" {
			if nth, _ := cmd.Flags().GetInt("nth"); selector != "" || text != "" || nth > 0 {
				return nil, fmt.Errorf("--at cannot be combined with a selector, --text, or --nth")
			}
			x, y, err := parsePoint(at)
			if err != nil {
				return nil, err
			}
			return map[string]any{"x": x, "y": y}, nil
		}
		if selector == "" && text == "" {
			return nil, fmt.Errorf("provide a selector, --text, or --at")
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

// parseHeaders reads repeated --header 'Name: value' flags
func parseHeaders(values []string) (map[string]string, error) {
	headers := map[string]string{}
	for _, header := range values {
		name, value, ok := strings.Cut(header, ":")
		if !ok || strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("--header must be 'Name: value', got %q", header)
		}
		headers[strings.TrimSpace(name)] = strings.TrimSpace(value)
	}
	return headers, nil
}

var pageFetchCmd = &cobra.Command{
	Use:   "fetch <tab-id> <url>",
	Short: "HTTP request from the page's origin with its cookies",
	Long: `Fetch a URL (absolute or relative to the page) as the page would, with its cookies.
Prints the response body; non-2xx statuses print the body and exit non-zero.
--json returns {status, ok, url, contentType, body, truncated?, totalLength?}.
Fails with FETCH_FAILED (network/CORS) or FETCH_TIMEOUT.`,
	Example: `  page fetch 12 /api/me
  page fetch 12 /api/items --method POST --body '{"name":"x"}' --max-chars 4000`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		request := map[string]any{"tabId": tabID, "url": args[1]}
		if method, _ := cmd.Flags().GetString("method"); method != "" {
			request["method"] = method
		}
		if headerFlags, _ := cmd.Flags().GetStringArray("header"); len(headerFlags) > 0 {
			headers, err := parseHeaders(headerFlags)
			if err != nil {
				return err
			}
			request["headers"] = headers
		}
		body, _ := cmd.Flags().GetString("body")
		bodyFile, _ := cmd.Flags().GetString("body-file")
		switch {
		case body != "" && bodyFile != "":
			return fmt.Errorf("use --body or --body-file, not both")
		case bodyFile != "":
			data, err := os.ReadFile(bodyFile)
			if err != nil {
				return fmt.Errorf("reading body file: %w", err)
			}
			request["body"] = string(data)
		case cmd.Flags().Changed("body"):
			request["body"] = body
		}
		if maxChars, _ := cmd.Flags().GetInt("max-chars"); maxChars > 0 {
			request["maxChars"] = maxChars
		}
		timeout, _ := cmd.Flags().GetDuration("timeout")
		request["timeoutMs"] = int(timeout / time.Millisecond)

		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()
		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}
		resp, err := c.RequestWithTimeout(target, cli.ExtCommand{Cmd: "page.fetch", Args: request}, timeout+pageRequestMargin)
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		if flagJSON {
			_, err := fmt.Fprintln(out, string(resp))
			return err
		}
		var result struct {
			Data struct {
				Status      int    `json:"status"`
				OK          bool   `json:"ok"`
				Body        string `json:"body"`
				Truncated   bool   `json:"truncated"`
				TotalLength int    `json:"totalLength"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			return fmt.Errorf("decoding page.fetch response: %w", err)
		}
		fmt.Fprint(out, result.Data.Body)
		if result.Data.Truncated {
			fmt.Fprintf(out, "\n\n[truncated: %d of %d characters]", len([]rune(result.Data.Body)), result.Data.TotalLength)
		}
		fmt.Fprintln(out)
		if !result.Data.OK {
			return fmt.Errorf("HTTP %d", result.Data.Status)
		}
		return nil
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

// formatElement renders one snapshot element: @e3 textbox "Email" = "a@b.c" [disabled]
func formatElement(el snapshotElement) string {
	if el.Role == "heading" {
		return fmt.Sprintf("h%d %s", el.Level, strconv.Quote(el.Name))
	}
	var b strings.Builder
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
	return b.String()
}

// formatSnapshot renders the title, URL, then one element per line
func formatSnapshot(snapshot pageSnapshot) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n%s\n", snapshot.Title, snapshot.URL)
	for _, el := range snapshot.Elements {
		b.WriteString(formatElement(el) + "\n")
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

var pageViewportCmd = &cobra.Command{
	Use:   "viewport <tab-id>",
	Short: "Set the tab's viewport to a CSS size, or --reset it",
	Long: `Set the page viewport to --width x --height CSS pixels (one flag keeps the other dimension); --reset undoes it;
with no flags, print the current viewport. Only the size changes: no touch, device pixel ratio, or user agent
emulation. Tabs outside the agent window are refused.

Chrome emulates the size on that tab alone (any width; Chrome shows its debugging banner until --reset). Firefox has
no emulation API, so the agent window is resized instead, affecting all its tabs; under AeroSpace the window is
floated so tiling does not undo the resize, and tiled again on --reset. Firefox windows stop near 500px wide; the
reached size is reported.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		request := map[string]any{"tabId": tabID}
		width, _ := cmd.Flags().GetInt("width")
		height, _ := cmd.Flags().GetInt("height")
		reset, _ := cmd.Flags().GetBool("reset")
		if reset && (width > 0 || height > 0) {
			return fmt.Errorf("--reset cannot be combined with --width or --height")
		}
		if width > 0 {
			request["width"] = width
		}
		if height > 0 {
			request["height"] = height
		}
		if reset {
			request["reset"] = true
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
		resp, err := requestViewport(c, target, request, cmd.ErrOrStderr())
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		if flagJSON {
			_, err := fmt.Fprintln(out, string(resp))
			return err
		}
		var result struct {
			Data struct {
				Width    int   `json:"width"`
				Height   int   `json:"height"`
				Exact    *bool `json:"exact"`
				Deferred bool  `json:"deferred"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			return fmt.Errorf("decoding page.viewport response: %w", err)
		}
		line := fmt.Sprintf("viewport %dx%d", result.Data.Width, result.Data.Height)
		if result.Data.Deferred {
			line += viewportDeferredNote
		} else if result.Data.Exact != nil && !*result.Data.Exact {
			requested := func(size, actual int) int {
				if size > 0 {
					return size
				}
				return actual
			}
			line += fmt.Sprintf(" (requested %dx%d; the browser or screen clamps the window size)",
				requested(width, result.Data.Width), requested(height, result.Data.Height))
		}
		_, err = fmt.Fprintln(out, line)
		return err
	},
}

func init() {
	pageClickCmd.Flags().String("at", "", "click the element at x,y viewport CSS pixels (canvas, maps, editors); mouse events carry those coordinates")
	pageSelectCmd.Flags().String("value", "", "option value or visible label")
	pageFillCmd.Flags().String("value", "", "text to enter (replaces the current value)")

	pageWaitCmd.Flags().String("selector", "", "CSS selector to wait for")
	pageWaitCmd.Flags().String("text", "", "visible text to wait for (case-insensitive)")
	pageWaitCmd.Flags().String("state", "visible", "element state for --selector/--text: visible, attached, gone")
	pageWaitCmd.Flags().String("url", "", "regular expression the tab URL must match")
	pageWaitCmd.Flags().Bool("load", false, "wait until the tab finishes loading")
	pageWaitCmd.Flags().Duration("timeout", 10*time.Second, "max total wait")

	pageFetchCmd.Flags().String("method", "", "HTTP method (default GET, or POST with a body)")
	pageFetchCmd.Flags().StringArray("header", nil, "request header 'Name: value' (repeatable)")
	pageFetchCmd.Flags().String("body", "", "request body; JSON-looking bodies default to Content-Type: application/json")
	pageFetchCmd.Flags().String("body-file", "", "read the request body from a file")
	pageFetchCmd.Flags().Int("max-chars", 0, "truncate the response body (0 = no limit)")
	pageFetchCmd.Flags().Duration("timeout", 30*time.Second, "max time to wait for the response")

	pageSnapshotCmd.Flags().String("selector", "", "only include elements inside the first match")
	pageSnapshotCmd.Flags().Int("max", 150, "max elements to list")

	pageViewportCmd.Flags().Int("width", 0, "target viewport width in CSS pixels")
	pageViewportCmd.Flags().Int("height", 0, "target viewport height in CSS pixels")
	pageViewportCmd.Flags().Bool("reset", false, "undo a previous size (Chrome: end emulation; Firefox: restore the window)")

	addWaitFlags(pageReloadCmd)
	addWaitFlags(tabsCreateCmd)

	pageCmd.AddCommand(pageClickCmd, pageFillCmd, pageSelectCmd, pagePressCmd, pageWaitCmd,
		pageGotoCmd, pageBackCmd, pageForwardCmd, pageSnapshotCmd, pageFetchCmd, pageViewportCmd)
}
