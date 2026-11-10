package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// runAction maps a step action to its extension command, defaults, and the single command whose syntax an
// inline step uses
type runAction struct {
	cmd         string
	defaults    map[string]any
	timeout     time.Duration // default wait budget sent as timeoutMs; zero sends none
	command     *cobra.Command
	positionals []string // argument names inline positionals fill; "locator" takes a selector or @ref
	required    int      // positionals an inline step must give
}

var navigationWait = map[string]any{"wait": "load"}

var runActions = map[string]runAction{
	"goto":     {cmd: "page.goto", defaults: navigationWait, timeout: 30 * time.Second, command: pageGotoCmd, positionals: []string{"url"}, required: 1},
	"back":     {cmd: "page.back", defaults: navigationWait, timeout: 30 * time.Second, command: pageBackCmd},
	"forward":  {cmd: "page.forward", defaults: navigationWait, timeout: 30 * time.Second, command: pageForwardCmd},
	"reload":   {cmd: "page.reload", defaults: map[string]any{"wait": "load", "bypassCache": false}, timeout: 30 * time.Second, command: pageReloadCmd},
	"click":    {cmd: "page.click", defaults: navigationWait, timeout: 30 * time.Second, command: pageClickCmd, positionals: []string{"locator"}},
	"fill":     {cmd: "page.fill", defaults: navigationWait, timeout: 30 * time.Second, command: pageFillCmd, positionals: []string{"locator"}},
	"select":   {cmd: "page.select", defaults: navigationWait, timeout: 30 * time.Second, command: pageSelectCmd, positionals: []string{"locator"}},
	"press":    {cmd: "page.press", defaults: navigationWait, timeout: 30 * time.Second, command: pagePressCmd, positionals: []string{"key", "locator"}, required: 1},
	"wait":     {cmd: "page.wait", timeout: 10 * time.Second, command: pageWaitCmd},
	"content":  {cmd: "page.content", defaults: map[string]any{"selector": "body", "format": "text"}, command: pageContentCmd},
	"snapshot": {cmd: "page.snapshot", command: pageSnapshotCmd},
	"exec":     {cmd: "page.exec", defaults: map[string]any{"world": "MAIN"}, timeout: 45 * time.Second, command: pageExecCmd, positionals: []string{"code"}},
	"fetch":    {cmd: "page.fetch", timeout: 30 * time.Second, command: pageFetchCmd, positionals: []string{"url"}, required: 1},
	"viewport": {cmd: "page.viewport", command: pageViewportCmd},
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
	return buildRunSteps(raw, tabID)
}

// parseInlineSteps reads steps written like their single commands without the tab ID: 'click @e3 --wait none'
func parseInlineSteps(texts []string, tabID int) ([]runStep, error) {
	raw := make([]map[string]any, len(texts))
	for i, text := range texts {
		fields, err := inlineStepFields(text)
		if err != nil {
			return nil, fmt.Errorf("step %d: %w", i+1, err)
		}
		raw[i] = fields
	}
	return buildRunSteps(raw, tabID)
}

func buildRunSteps(raw []map[string]any, tabID int) ([]runStep, error) {
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
	// the last step observes like its single command (--snapshot diff); earlier steps only when they ask
	last := steps[len(steps)-1]
	if flag := runActions[last.action].command.Flags().Lookup("snapshot"); flag != nil {
		if _, ok := last.args["snapshot"]; !ok {
			last.args["snapshot"] = flag.DefValue
		}
	}
	return steps, nil
}

// inlineStepFields parses one inline step with its single command's flag definitions into JSON step fields
func inlineStepFields(text string) (map[string]any, error) {
	words, err := splitStepWords(text)
	if err != nil {
		return nil, err
	}
	if len(words) == 0 {
		return nil, fmt.Errorf("empty step")
	}
	name := words[0]
	action, ok := runActions[name]
	if !ok {
		return nil, fmt.Errorf("unknown action %q (quote each step: 'click @e3')", name)
	}
	flags, err := stepFlagSet(action.command)
	if err != nil {
		return nil, err
	}
	if err := flags.Parse(words[1:]); err != nil {
		return nil, err
	}
	positionals := flags.Args()
	if len(positionals) < action.required {
		return nil, fmt.Errorf("%s needs <%s>", name, action.positionals[len(positionals)])
	}
	if max := len(action.positionals); len(positionals) > max {
		noun := "arguments"
		if max == 1 {
			noun = "argument"
		}
		return nil, fmt.Errorf("%s takes at most %d %s (steps omit the tab ID)", name, max, noun)
	}
	fields := map[string]any{"action": name}
	for i, value := range positionals {
		key := action.positionals[i]
		if key == "locator" {
			key = "selector"
			if strings.HasPrefix(value, "@") {
				key = "ref"
			}
		}
		fields[key] = value
	}
	flags.Visit(func(flag *pflag.Flag) {
		if err == nil {
			err = setStepFlag(fields, flags, flag)
		}
	})
	return fields, err
}

// stepFlagSet copies a single command's flag definitions so parsing a step leaves the command's own values alone;
// only flags a step sets are read, so defaults stay with runActions
func stepFlagSet(command *cobra.Command) (*pflag.FlagSet, error) {
	flags := pflag.NewFlagSet(command.Name(), pflag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var err error
	command.LocalFlags().VisitAll(func(flag *pflag.Flag) {
		switch flag.Value.Type() {
		case "string":
			flags.StringP(flag.Name, flag.Shorthand, "", flag.Usage)
		case "bool":
			flags.BoolP(flag.Name, flag.Shorthand, false, flag.Usage)
		case "int":
			flags.IntP(flag.Name, flag.Shorthand, 0, flag.Usage)
		case "duration":
			flags.DurationP(flag.Name, flag.Shorthand, 0, flag.Usage)
		case "stringArray":
			flags.StringArrayP(flag.Name, flag.Shorthand, nil, flag.Usage)
		default:
			err = fmt.Errorf("page %s --%s: %s flags are not supported in steps", command.Name(), flag.Name, flag.Value.Type())
		}
	})
	return flags, err
}

// setStepFlag maps a flag a step set onto the argument the extension reads, as the single command does
func setStepFlag(fields map[string]any, flags *pflag.FlagSet, flag *pflag.Flag) error {
	switch flag.Name {
	case "at":
		x, y, err := parsePoint(flag.Value.String())
		fields["x"], fields["y"] = x, y
		return err
	case "header":
		values, _ := flags.GetStringArray(flag.Name)
		headers, err := parseHeaders(values)
		fields["headers"] = headers
		return err
	case "file", "body-file":
		data, err := os.ReadFile(flag.Value.String())
		if err != nil {
			return fmt.Errorf("reading --%s: %w", flag.Name, err)
		}
		fields[map[string]string{"file": "code", "body-file": "body"}[flag.Name]] = string(data)
		return nil
	case "timeout":
		fields["timeout"] = flag.Value.String()
		return nil
	}
	parts := strings.Split(flag.Name, "-")
	for i := 1; i < len(parts); i++ {
		parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
	}
	key := strings.Join(parts, "")
	switch flag.Value.Type() {
	case "int":
		fields[key], _ = flags.GetInt(flag.Name)
	case "bool":
		fields[key], _ = flags.GetBool(flag.Name)
	default:
		fields[key] = flag.Value.String()
	}
	return nil
}

// splitStepWords splits a step into words like a POSIX shell without expansion: single quotes are literal, double
// quotes take backslash escapes for " \ $ and `, and a bare backslash escapes the next character
func splitStepWords(text string) ([]string, error) {
	var words []string
	var word strings.Builder
	inWord := false
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n':
			if inWord {
				words = append(words, word.String())
				word.Reset()
				inWord = false
			}
			continue
		case c == '\'':
			end := strings.IndexByte(text[i+1:], '\'')
			if end < 0 {
				return nil, fmt.Errorf("unterminated quote")
			}
			word.WriteString(text[i+1 : i+1+end])
			i += end + 1
		case c == '"':
			for i++; i < len(text) && text[i] != '"'; i++ {
				if text[i] == '\\' && i+1 < len(text) && strings.IndexByte("\"\\$`", text[i+1]) >= 0 {
					i++
				}
				word.WriteByte(text[i])
			}
			if i == len(text) {
				return nil, fmt.Errorf("unterminated quote")
			}
		case c == '\\' && i+1 < len(text):
			i++
			word.WriteByte(text[i])
		default:
			word.WriteByte(c)
		}
		inWord = true
	}
	if inWord {
		words = append(words, word.String())
	}
	return words, nil
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
		var size struct {
			Width, Height int
			Deferred      bool
		}
		err := json.Unmarshal(data, &size)
		line := fmt.Sprintf(" %dx%d", size.Width, size.Height)
		if size.Deferred {
			line += viewportDeferredNote
		}
		return line, err
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
	if observation := formatObservation(&result); observation != "" {
		line += "\n" + strings.TrimRight(observation, "\n")
	}
	return line, nil
}

// readRunSteps takes inline steps or the -f file, never both
func readRunSteps(cmd *cobra.Command, inline []string, tabID int) ([]runStep, error) {
	file, _ := cmd.Flags().GetString("file")
	switch {
	case file != "" && len(inline) > 0:
		return nil, fmt.Errorf("give inline steps or -f, not both")
	case len(inline) > 0:
		return parseInlineSteps(inline, tabID)
	case file == "":
		return nil, fmt.Errorf("provide steps inline ('click @e3' ...) or with -f <file> (-f - for stdin)")
	}
	var data []byte
	var err error
	if file == "-" {
		data, err = io.ReadAll(cmd.InOrStdin())
	} else {
		data, err = os.ReadFile(file)
	}
	if err != nil {
		return nil, fmt.Errorf("reading steps: %w", err)
	}
	return parseRunSteps(data, tabID)
}

var pageRunCmd = &cobra.Command{
	Use:   "run <tab-id> ['step' ...] | -f steps.json",
	Short: "Run a sequence of page steps, stopping at the first failure",
	Long: `Run steps in order over one connection, stopping at the first failure (non-zero exit).
Inline, each quoted argument is one step written like its single command without the tab ID:
  page run 12 'fill @e2 --value "Ada Lovelace"' 'click --text "Sign in"' 'wait --url /home'
Steps split into words like a shell (quotes, backslash escapes) without expansion.
With -f, steps are a JSON array of {"action": ..., ...args} using the extension's argument names (camelCase):
  [{"action": "goto", "url": "https://example.com/login"},
   {"action": "fill", "text": "Email", "value": "a@b.c"},
   {"action": "click", "ref": "@e4", "timeout": "15s"},
   {"action": "wait", "selector": ".dashboard"},
   {"action": "content", "selector": "main", "format": "markdown", "maxChars": 4000}]
Actions: goto back forward reload click fill select press wait content snapshot exec fetch viewport.
Navigating actions wait for load unless "wait": "none". "timeout" takes a duration. Use -f - for stdin.
Only the last step observes by default: a final click, fill, select, or press reports its snapshot diff like the
single command. Earlier steps take a snapshot only when asked ("snapshot": "diff" or "full", or --snapshot).
--json prints {steps: [{action, data}], failed?: {step, action, error}}.`,
	Args: cobra.MinimumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		steps, err := readRunSteps(cmd, args[1:], tabID)
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
