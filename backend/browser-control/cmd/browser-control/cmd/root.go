package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
	"github.com/spf13/cobra"
)

var (
	flagBrowser     string
	flagJSON        bool
	flagSession     string
	flagPersonalTab int
)

var rootCmd = &cobra.Command{
	Use:   "browser-control",
	Short: "CLI for Browser Control by Latent Byte",
	Long: `browser-control communicates with LBCat through a local daemon
(browser-control-daemon) to manage userscripts, inspect tabs, read page
content, and execute JavaScript in browser tabs.`,
	SilenceUsage: true,
}

// Execute runs the root command.
func Execute() error {
	return rootCmd.Execute()
}

// sessionHandle splits --session or BROWSER_CONTROL_SESSION; `session begin` prints
// "<browser>:<id>" so later commands route to the owning browser without --browser
func sessionHandle() (browser, id string) {
	value := flagSession
	if value == "" {
		value = os.Getenv("BROWSER_CONTROL_SESSION")
	}
	if browser, id, ok := strings.Cut(value, ":"); ok {
		return browser, id
	}
	return "", value
}

func sessionFromFlag() string {
	_, id := sessionHandle()
	return id
}

func connectScoped() (*cli.Client, error) {
	c, err := cli.Connect()
	if err != nil {
		return nil, err
	}
	c.SessionID = sessionFromFlag()
	c.PersonalTabID = flagPersonalTab
	c.NotifyMissingWindow = true
	return c, nil
}

func init() {
	rootCmd.PersistentFlags().StringVar(&flagSession, "session", "", "agent task session handle from session begin, e.g. zen:ab12cd34 (defaults to BROWSER_CONTROL_SESSION)")
	rootCmd.PersistentFlags().IntVar(&flagPersonalTab, "personal-tab", 0, "explicit permission for this exact personal tab ID")
	rootCmd.PersistentFlags().StringVar(&flagBrowser, "browser", "",
		"target browser: connection ID (zen-01) or browser name (zen) when only one is connected; defaults to BROWSER_CONTROL_BROWSER, then the --session handle's browser")
	rootCmd.PersistentFlags().BoolVar(&flagJSON, "json", false,
		"output in JSON format")
}

// browserSelection is --browser, BROWSER_CONTROL_BROWSER, or the session handle's browser:
// an exact ID or a browser name
func browserSelection() string {
	if flagBrowser != "" {
		return flagBrowser
	}
	if browser := os.Getenv("BROWSER_CONTROL_BROWSER"); browser != "" {
		return browser
	}
	browser, _ := sessionHandle()
	return browser
}

func browserIDFromFlag() model.BrowserID {
	return model.BrowserID(browserSelection())
}

func isCLIPeer(peer string) bool {
	return strings.HasPrefix(peer, "cli-")
}

func browserPeers(peers []string) []string {
	browsers := make([]string, 0, len(peers))
	for _, peer := range peers {
		if !isCLIPeer(peer) {
			browsers = append(browsers, peer)
		}
	}
	return browsers
}

// resolveBrowser picks a browser target: the requested ID or name, else the only connected browser.
func resolveBrowser(peers []string) (string, error) {
	browsers := browserPeers(peers)
	if requested := browserSelection(); requested != "" {
		return browsercontrol.ResolveBrowserAlias(requested, browsers)
	}

	switch len(browsers) {
	case 0:
		return "", fmt.Errorf("no browsers connected")
	case 1:
		return browsers[0], nil
	default:
		fmt.Fprintf(os.Stderr, "multiple browsers connected: %v\n", browsers)
		return "", fmt.Errorf("specify --browser or BROWSER_CONTROL_BROWSER (e.g., --browser %s)", browsers[0])
	}
}
