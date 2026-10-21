package cli

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

// NotifyGuideStarted tells the human an agent began walking them through a page
func NotifyGuideStarted(title string) {
	if title == "" {
		title = "Agent walkthrough"
	}
	if err := runNotify("Agent guide started", title+": follow the steps in the agent browser window."); err != nil {
		fmt.Fprintf(os.Stderr, "browser-control: guide notification failed (%v)\n", err)
	}
}

func runNotify(title, body string) error {
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
	if err := exec.CommandContext(ctx, executable, title, body).Run(); err != nil {
		return fmt.Errorf("verify notify.sh is installed and executable: %w", err)
	}
	return nil
}

func clearMissingWindow(target string) { _ = os.Remove(missingWindowLatch(target)) }
