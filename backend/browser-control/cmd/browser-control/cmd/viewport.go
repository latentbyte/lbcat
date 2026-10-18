package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
)

// aerospaceCommand runs the AeroSpace CLI; tests replace it
var aerospaceCommand = func(args ...string) ([]byte, error) {
	path, err := exec.LookPath("aerospace")
	if err != nil {
		return nil, err
	}
	return exec.Command(path, args...).Output()
}

// requestViewport sends page.viewport. When the extension resizes the agent window (Firefox) it marks the window
// title; under AeroSpace that window is floated first, since a tiled window snaps back to its tile, and tiled again
// on reset. Without AeroSpace the plain resize stands.
func requestViewport(c *cli.Client, target string, args map[string]any, warn io.Writer) (json.RawMessage, error) {
	resp, err := c.Request(target, cli.ExtCommand{Cmd: "page.viewport", Args: args})
	if err != nil {
		return nil, err
	}
	var result struct {
		Data struct {
			TitleMarker string `json:"titleMarker"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp, &result); err != nil || result.Data.TitleMarker == "" {
		return resp, nil
	}
	reset, _ := args["reset"].(bool)
	changed, err := setAgentWindowFloating(result.Data.TitleMarker, !reset)
	if err != nil {
		fmt.Fprintf(warn, "warning: AeroSpace: %v\n", err)
		return resp, nil
	}
	if !changed || reset {
		return resp, nil
	}
	return c.Request(target, cli.ExtCommand{Cmd: "page.viewport", Args: args})
}

// setAgentWindowFloating floats or tiles the AeroSpace window whose title starts with marker; it reports whether the
// layout changed. A missing aerospace binary is not an error.
func setAgentWindowFloating(marker string, floating bool) (bool, error) {
	out, err := aerospaceCommand("list-windows", "--all", "--format", "%{window-id}|%{window-layout}|%{window-title}")
	if errors.Is(err, exec.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("listing windows: %w", err)
	}
	var id, layout string
	for line := range strings.Lines(string(out)) {
		fields := strings.SplitN(strings.TrimRight(line, "\n"), "|", 3)
		if len(fields) == 3 && strings.HasPrefix(fields[2], marker) {
			if id != "" {
				return false, fmt.Errorf("several windows are titled %q", marker)
			}
			id, layout = fields[0], fields[1]
		}
	}
	if id == "" || (layout == "floating") == floating {
		return false, nil
	}
	target := "tiling"
	if floating {
		target = "floating"
	}
	if _, err := aerospaceCommand("layout", "--window-id", id, target); err != nil {
		return false, fmt.Errorf("setting window %s %s: %w", id, target, err)
	}
	return true, nil
}
