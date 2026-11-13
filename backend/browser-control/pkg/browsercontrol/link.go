package browsercontrol

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
)

// LinkScheme is the URL scheme of tab links, opened on macOS by the handler app `browser-control install` registers
const LinkScheme = "lbcat"

// TabLink returns a link that focuses the tab and raises its window when opened, eg lbcat://tab/zen-01/116
func TabLink(browserID model.BrowserID, tabID int64) string {
	return fmt.Sprintf("%s://tab/%s/%d", LinkScheme, url.PathEscape(string(browserID)), tabID)
}

// ParseTabLink reads a TabLink back into its browser connection ID and tab ID
func ParseTabLink(link string) (model.BrowserID, int64, error) {
	parsed, err := url.Parse(link)
	if err != nil {
		return "", 0, fmt.Errorf("invalid tab link: %w", err)
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if parsed.Scheme != LinkScheme || parsed.Host != "tab" || len(parts) != 2 || parts[0] == "" {
		return "", 0, fmt.Errorf("invalid tab link %q: want %s://tab/<browser-id>/<tab-id>", link, LinkScheme)
	}
	tabID, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || tabID <= 0 {
		return "", 0, fmt.Errorf("invalid tab link %q: tab ID must be a positive integer", link)
	}
	return model.BrowserID(parts[0]), tabID, nil
}
