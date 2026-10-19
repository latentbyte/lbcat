package cli

import (
	"encoding/json"
	"fmt"
	"strings"
)

// CommandError preserves structured daemon and extension failures.
type CommandError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *CommandError) Error() string {
	if e == nil {
		return ""
	}
	if e.Code == "" {
		return e.Message
	}
	if e.Message == "" {
		return e.Code
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func scoped(cmd string) bool {
	return strings.HasPrefix(cmd, "tabs.") || strings.HasPrefix(cmd, "page.") || strings.HasPrefix(cmd, "notes.") ||
		strings.HasPrefix(cmd, "guide.")
}

func (c *Client) scopedCommand(command ExtCommand) (ExtCommand, error) {
	if !scoped(command.Cmd) {
		return command, nil
	}
	args := make(map[string]any)
	if command.Args != nil {
		original, err := json.Marshal(command.Args)
		if err != nil {
			return command, fmt.Errorf("encoding command args: %w", err)
		}
		if err := json.Unmarshal(original, &args); err != nil {
			return command, fmt.Errorf("command args must be an object: %w", err)
		}
		if args == nil {
			args = make(map[string]any)
		}
	}
	if c.SessionID != "" {
		args["sessionId"] = c.SessionID
	}
	if c.PersonalTabID > 0 {
		args["personalTabId"] = c.PersonalTabID
	}
	command.Args = args
	return command, nil
}

func clearsMissingWindow(command ExtCommand) bool {
	return scoped(command.Cmd) || command.Cmd == "agentWindow.status" || command.Cmd == "agentWindow.create" || command.Cmd == "agentWindow.designate" || command.Cmd == "sessions.open"
}
