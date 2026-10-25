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

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
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
	if err := runNotify("Agent browser blocked", "Open or designate the agent browser window with browser-control agent-window create or designate."); err != nil {
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
	var options []string
	if executable, err := os.Executable(); err == nil {
		focus := shellJoin(executable, "--browser", browserID, "human", "tabs", "focus", strconv.Itoa(tabID))
		options = append(options, "--on-click", focus)
	}
	if err := runNotify(heading, title+": "+summary, options...); err != nil {
		fmt.Fprintf(os.Stderr, "browser-control: guide notification failed (%v)\n", err)
	}
}

// shellJoin quotes each word for /bin/sh
func shellJoin(words ...string) string {
	quoted := make([]string, len(words))
	for i, word := range words {
		quoted[i] = "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
	}
	return strings.Join(quoted, " ")
}

func runNotify(title, body string, options ...string) error {
	executable, err := exec.LookPath("notify.sh")
	if err != nil {
		home, homeErr := os.UserHomeDir()
		if homeErr != nil {
			return fmt.Errorf("cannot locate notify.sh")
		}
		executable = filepath.Join(home, "scripts", "compat", "notify.sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, executable, append(options, title, body)...).Run(); err != nil {
		return fmt.Errorf("verify notify.sh is installed and executable: %w", err)
	}
	return nil
}

func clearMissingWindow(target string) { _ = os.Remove(missingWindowLatch(target)) }
