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
	executable, err := exec.LookPath("notify.sh")
	if err != nil {
		home, homeErr := os.UserHomeDir()
		if homeErr != nil {
			fmt.Fprintln(os.Stderr, "browser-control: cannot locate notify.sh; agent browser remains blocked")
			return
		}
		executable = filepath.Join(home, "scripts", "compat", "notify.sh")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, executable, "Agent browser blocked", "Open or designate the agent browser window with browser-control agent-window create or designate.").Run(); err != nil {
		fmt.Fprintln(os.Stderr, "browser-control: agent-window notification failed; verify notify.sh is installed and executable")
	}
}

func clearMissingWindow(target string) { _ = os.Remove(missingWindowLatch(target)) }
