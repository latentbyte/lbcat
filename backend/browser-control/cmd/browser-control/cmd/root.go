package cmd

import (
	"fmt"
	"os"

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

// resolveBrowser picks a browser target. If --browser is set, use it.
// Otherwise try to auto-select if exactly one browser is connected.
func resolveBrowser(peers []string) (string, error) {
	if flagBrowser != "" {
		return flagBrowser, nil
	}

	// filter to browser-like peers (not cli-*)
	var browsers []string
	for _, p := range peers {
		if len(p) > 4 && p[:4] != "cli-" {
			browsers = append(browsers, p)
		}
	}

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
