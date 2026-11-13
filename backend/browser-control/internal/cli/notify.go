package cli

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/protocol"
)

func missingWindowLatch(target string) string {
	sum := sha256.Sum256([]byte(target))
	return filepath.Join(filepath.Dir(protocol.SocketPath()), fmt.Sprintf("agent-window-missing-%x", sum[:8]))
}

func notifyMissingWindow(target string) {
	path := missingWindowLatch(target)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return
	}
	latch, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return
	}
	_ = latch.Close()
	if err := runNotify("Agent browser blocked", "Open or designate the agent browser window with browser-control agent-window create or designate.",
		"--group", windowGroup(target)); err != nil {
		fmt.Fprintf(os.Stderr, "browser-control: agent-window notification failed (%v); agent browser remains blocked\n", err)
	}
}

// NotifyGuideStep tells the human an agent published a walkthrough step for them; clicking
// the notification focuses the guided tab
func NotifyGuideStep(started bool, title, summary, browserID string, tabID int) {
	if title == "" {
		title = "Agent walkthrough"
	}
	heading := "Agent guide: new step"
	if started {
		heading = "Agent guide started"
	}
	if err := runNotify(heading, title+": "+summary, focusTabOnClick(browserID, tabID)...); err != nil {
		fmt.Fprintf(os.Stderr, "browser-control: guide notification failed (%v)\n", err)
	}
}

// NotifyNeedsHuman tells the human an agent left a needs-human note; clicking the notification
// focuses the noted tab
func NotifyNeedsHuman(summary, browserID string, tabID int) {
	if err := runNotify("Agent needs you", summary, focusTabOnClick(browserID, tabID)...); err != nil {
		fmt.Fprintf(os.Stderr, "browser-control: note notification failed (%v)\n", err)
	}
}

// focusTabOnClick is the notify option that brings the tab and its window forward on click
func focusTabOnClick(browserID string, tabID int) []string {
	executable, err := os.Executable()
	if err != nil {
		return nil
	}
	return []string{"--on-click", shellJoin(executable, "--browser", browserID, "human", "tabs", "focus", strconv.Itoa(tabID))}
}

// shellJoin quotes each word for /bin/sh
func shellJoin(words ...string) string {
	quoted := make([]string, len(words))
	for i, word := range words {
		quoted[i] = "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
	}
	return strings.Join(quoted, " ")
}

// runNotify sends a desktop notification. options use notify.sh flags (--on-click <cmd>, --group <id>); without
// notify.sh they are translated for terminal-notifier
func runNotify(title, body string, options ...string) error {
	tool, args, err := notifyCommand(title, body, options)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, tool, args...).Run(); err != nil {
		return fmt.Errorf("running %s: %w", filepath.Base(tool), err)
	}
	return nil
}

func notifyCommand(title, body string, options []string) (string, []string, error) {
	if script, err := exec.LookPath("notify.sh"); err == nil {
		return script, append(options, title, body), nil
	}
	// browsers launch the shim with a minimal PATH, so also check the conventional install location
	if home, err := os.UserHomeDir(); err == nil {
		script := filepath.Join(home, "scripts", "compat", "notify.sh")
		if _, err := os.Stat(script); err == nil {
			return script, append(options, title, body), nil
		}
	}
	notifier, err := exec.LookPath("terminal-notifier")
	if err != nil {
		return "", nil, fmt.Errorf("no notifier found: install terminal-notifier (brew install terminal-notifier)")
	}
	args := []string{"-title", title, "-message", body}
	for i := 0; i+1 < len(options); i += 2 {
		switch options[i] {
		case "--on-click":
			args = append(args, "-execute", options[i+1])
		case "--group":
			args = append(args, "-group", options[i+1])
		}
	}
	return notifier, args, nil
}

func clearMissingWindow(target string) { _ = os.Remove(missingWindowLatch(target)) }
