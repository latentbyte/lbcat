package cmd

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

var pingCmd = &cobra.Command{
	Use:   "ping",
	Short: "Check if the daemon is reachable",
	RunE: func(cmd *cobra.Command, args []string) error {
		start := time.Now()

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		resp, err := c.Request("daemon", cli.ExtCommand{Cmd: "ping"})
		if err != nil {
			return err
		}

		rtt := time.Since(start)

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		var result struct {
			Cmd  string `json:"cmd"`
			Data struct {
				PID int `json:"pid"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Println(string(resp))
			return nil
		}

		fmt.Printf("pong from daemon (pid %d) in %s\n", result.Data.PID, rtt.Round(time.Microsecond))
		return nil
	},
}

func init() {
	rootCmd.AddCommand(pingCmd)
}
