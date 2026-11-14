package raise

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
)

// MacOpen activates the browser app through Launch Services, which brings forward the window the browser just
// focused. It knows nothing about windows, so it comes after window-precise raisers
type MacOpen struct{}

func (MacOpen) Name() string { return "open" }

func (MacOpen) Locate(_ context.Context, tab model.Tab, _ []model.Tab) (func(context.Context) error, error) {
	if tab.AppName == "" {
		return nil, ErrNoWindow
	}
	return func(ctx context.Context) error {
		if output, err := exec.CommandContext(ctx, "/usr/bin/open", "-a", tab.AppName).CombinedOutput(); err != nil {
			return fmt.Errorf("activating %s: %w: %s", tab.AppName, err, strings.TrimSpace(string(output)))
		}
		return nil
	}, nil
}
