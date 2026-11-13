// Package raise brings a browser tab's OS window to the front after the browser focused the tab.
//
// Browsers can focus their own window, but on macOS a background app cannot reliably activate itself, and window
// managers with virtual workspaces do not always follow. A Raiser asks the OS or window manager to do it. Support for
// another OS or window manager is one more Raiser listed in Default.
package raise

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
)

// ErrNoWindow means a Raiser could not tell which OS window shows the tab, so the next one gets a turn
var ErrNoWindow = errors.New("window not found")

// Raiser brings the OS window showing a tab to the front, switching workspace or desktop when needed
type Raiser interface {
	Name() string
	// Raise runs after the browser activated tab in its window; tabs lists every connected browser's tabs after that
	Raise(ctx context.Context, tab model.Tab, tabs []model.Tab) error
}

// Default lists the raisers usable on this machine, most precise first
func Default() []Raiser {
	if runtime.GOOS != "darwin" {
		return nil
	}
	var raisers []Raiser
	if path := findTool("aerospace"); path != "" {
		raisers = append(raisers, Aerospace{Path: path})
	}
	return append(raisers, MacOpen{})
}

// Window tries each raiser in order and returns the name of the one that raised the tab's window. With no raisers
// it does nothing; the browser's own window focus is all there is
func Window(ctx context.Context, raisers []Raiser, tab model.Tab, tabs []model.Tab) (string, error) {
	var failures []error
	for _, raiser := range raisers {
		err := raiser.Raise(ctx, tab, tabs)
		if err == nil {
			return raiser.Name(), nil
		}
		failures = append(failures, fmt.Errorf("%s: %w", raiser.Name(), err))
	}
	return "", errors.Join(failures...)
}

// findTool looks on PATH, then in Homebrew's prefixes: URL handlers and notification clicks run with a minimal PATH
func findTool(name string) string {
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin"} {
		path := filepath.Join(dir, name)
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path
		}
	}
	return ""
}
