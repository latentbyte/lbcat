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
	// Locate finds the tab's OS window before the browser focuses the tab: raising a window on another workspace
	// stalls window managers such as AeroSpace, which then list windows without titles for a moment. tabs lists
	// every connected browser's tabs. It returns ErrNoWindow when it cannot tell the window apart, else a func
	// that raises the window
	Locate(ctx context.Context, tab model.Tab, tabs []model.Tab) (func(context.Context) error, error)
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

// Window locates the tab's window with the first raiser that can, runs focus (the browser focusing the tab), then
// raises the window and returns the raiser's name. With no raisers it only runs focus
func Window(ctx context.Context, raisers []Raiser, tab model.Tab, tabs []model.Tab, focus func() error) (string, error) {
	var failures []error
	var name string
	var raiseWindow func(context.Context) error
	for _, raiser := range raisers {
		located, err := raiser.Locate(ctx, tab, tabs)
		if err == nil {
			name, raiseWindow = raiser.Name(), located
			break
		}
		failures = append(failures, fmt.Errorf("%s: %w", raiser.Name(), err))
	}
	if err := focus(); err != nil {
		return "", err
	}
	if raiseWindow == nil {
		return "", errors.Join(failures...)
	}
	if err := raiseWindow(ctx); err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	return name, nil
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
