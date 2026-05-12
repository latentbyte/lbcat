package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/scriptscat/scriptcat/tools/vmctl/internal/cli"
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

		peers := c.Peers()

		if flagJSON {
			data, _ := json.MarshalIndent(peers, "", "  ")
			fmt.Println(string(data))
			return nil
		}

		if len(peers) == 0 {
			fmt.Println("no browsers connected")
			return nil
		}

		fmt.Println("connected browsers:")
		for _, p := range peers {
			fmt.Printf("  %s\n", p)
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
