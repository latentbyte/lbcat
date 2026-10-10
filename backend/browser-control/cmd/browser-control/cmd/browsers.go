package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

var browsersCmd = &cobra.Command{
	Use:     "browsers",
	Aliases: []string{"browser"},
	Short:   "List connected browser instances",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		peers := browserPeers(c.Peers())

		out := cmd.OutOrStdout()
		if flagJSON {
			data, err := json.Marshal(map[string]any{"cmd": "browsers", "data": peers})
			if err != nil {
				return err
			}
			_, err = fmt.Fprintln(out, string(data))
			return err
		}

		if len(peers) == 0 {
			_, err := fmt.Fprintln(out, "no browsers connected")
			return err
		}

		fmt.Fprintln(out, "connected browsers:")
		for _, p := range peers {
			fmt.Fprintf(out, "  %s\n", p)
		}
		return nil
	},
}

var browsersListCmd = &cobra.Command{
	Use:   "list",
	Short: "List connected browser instances",
	RunE:  browsersCmd.RunE,
}

func init() {
	browsersCmd.AddCommand(browsersListCmd)
	rootCmd.AddCommand(browsersCmd)
}
