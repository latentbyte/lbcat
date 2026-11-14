package browsercontrol

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
)

// LinkScheme is the URL scheme of tab links opened by the macOS handler app `browser-control install` registers
const LinkScheme = "lbcat"

// LinkHost is where the daemon serves http tab links. Chat apps that only open web links (T3, Slack) can still open
// these: the default browser requests the page and the daemon focuses the tab
const LinkHost = "127.0.0.1:47823"

// TabLink returns a link that focuses the tab and raises its window when opened, eg
// http://127.0.0.1:47823/tab/zen-01/116
func TabLink(browserID model.BrowserID, tabID int64) string {
	return fmt.Sprintf("http://%s/tab/%s/%d", LinkHost, url.PathEscape(string(browserID)), tabID)
}

// IsTabLink reports whether arg looks like a tab link rather than a tab ID
func IsTabLink(arg string) bool {
	return strings.HasPrefix(arg, LinkScheme+":") || strings.HasPrefix(arg, "http://"+LinkHost+"/")
}

// ParseTabLink reads a TabLink, or its lbcat://tab/<browser-id>/<tab-id> form, into its browser connection ID and
// tab ID
func ParseTabLink(link string) (model.BrowserID, int64, error) {
	parsed, err := url.Parse(link)
	if err != nil {
		return "", 0, fmt.Errorf("invalid tab link: %w", err)
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	switch {
	case parsed.Scheme == LinkScheme && parsed.Host == "tab" && len(parts) == 2:
	case parsed.Scheme == "http" && parsed.Host == LinkHost && len(parts) == 3 && parts[0] == "tab":
		parts = parts[1:]
	default:
		parts = nil
	}
	if len(parts) != 2 || parts[0] == "" {
		return "", 0, fmt.Errorf("invalid tab link %q: want http://%s/tab/<browser-id>/<tab-id>", link, LinkHost)
	}
	tabID, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || tabID <= 0 {
		return "", 0, fmt.Errorf("invalid tab link %q: tab ID must be a positive integer", link)
	}
	return model.BrowserID(parts[0]), tabID, nil
}
