package cmd

import (
	"fmt"
	"os"
	"strings"

	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
	"github.com/spf13/cobra"
)

var (
	flagBrowser string
	flagJSON    bool
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

func init() {
	rootCmd.PersistentFlags().StringVar(&flagBrowser, "browser", "",
		"target browser connection (e.g., chrome-01, firefox-01)")
	rootCmd.PersistentFlags().BoolVar(&flagJSON, "json", false,
		"output in JSON format")
}

func browserIDFromFlag() model.BrowserID {
	return model.BrowserID(flagBrowser)
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

// resolveBrowser picks a browser target. If --browser is set, use it.
// Otherwise try to auto-select if exactly one browser is connected.
func resolveBrowser(peers []string) (string, error) {
	if flagBrowser != "" {
		return flagBrowser, nil
	}

	browsers := browserPeers(peers)

	switch len(browsers) {
	case 0:
		return "", fmt.Errorf("no browsers connected")
	case 1:
		return browsers[0], nil
	default:
		fmt.Fprintf(os.Stderr, "multiple browsers connected: %v\n", browsers)
		return "", fmt.Errorf("specify --browser (e.g., --browser %s)", browsers[0])
	}
}
