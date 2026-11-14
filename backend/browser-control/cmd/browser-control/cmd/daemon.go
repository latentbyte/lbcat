package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/cli"
	"github.com/latentbyte/lbcat/backend/browser-control/internal/daemon"
	"github.com/latentbyte/lbcat/backend/browser-control/internal/protocol"
	"github.com/latentbyte/lbcat/backend/browser-control/internal/tablink"
	"github.com/spf13/cobra"
)

var daemonCmd = &cobra.Command{
	Use:   "daemon",
	Short: "Manage the Browser Control daemon",
}

var daemonStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the daemon",
	RunE: func(cmd *cobra.Command, args []string) error {
		background, _ := cmd.Flags().GetBool("background")
		if background {
			// re-exec ourselves without --background
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			proc := exec.Command(exe, "daemon", "start")
			proc.Stdout = nil
			proc.Stderr = nil
			if err := proc.Start(); err != nil {
				return fmt.Errorf("forking daemon: %w", err)
			}
			fmt.Fprintf(os.Stderr, "daemon started in background (pid %d)\n", proc.Process.Pid)
			return nil
		}

		srv := daemon.NewServer()
		if err := srv.Listen(); err != nil {
			return err
		}
		defer srv.Shutdown()

		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()
		go tablink.Run(ctx)

		fmt.Fprintf(os.Stderr, "daemon started (pid %d, socket %s)\n", os.Getpid(), protocol.SocketPath())
		return srv.Serve(ctx)
	},
}

var daemonStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the running daemon",
	RunE: func(cmd *cobra.Command, args []string) error {
		pidPath := protocol.PIDPath()
		data, err := os.ReadFile(pidPath)
		if err != nil {
			return fmt.Errorf("daemon not running (no PID file at %s)", pidPath)
		}
		pid, err := strconv.Atoi(string(data))
		if err != nil {
			return fmt.Errorf("invalid PID file: %w", err)
		}
		proc, err := os.FindProcess(pid)
		if err != nil {
			return fmt.Errorf("process %d not found: %w", pid, err)
		}
		if err := proc.Signal(syscall.SIGTERM); err != nil {
			return fmt.Errorf("sending SIGTERM to %d: %w", pid, err)
		}
		fmt.Fprintf(os.Stderr, "sent SIGTERM to daemon (pid %d)\n", pid)
		return nil
	},
}

var daemonStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show daemon status and connected browsers",
	RunE: func(cmd *cobra.Command, args []string) error {
		// try to query the daemon over the socket (the real check)
		c, err := cli.Connect()
		if err != nil {
			fmt.Println("daemon: not running")
			return nil
		}
		defer c.Close()

		resp, err := c.Request("daemon", cli.ExtCommand{Cmd: "status"})
		if err != nil {
			fmt.Println("daemon: running but not responding")
			return nil
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		var result struct {
			Data struct {
				PID         int             `json:"pid"`
				Socket      string          `json:"socket"`
				Connections json.RawMessage `json:"connections"`
				History     json.RawMessage `json:"history"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Println(string(resp))
			return nil
		}

		fmt.Printf("daemon: running (pid %d)\n", result.Data.PID)
		fmt.Printf("socket: %s\n", result.Data.Socket)

		var conns []struct {
			ID      string `json:"id"`
			Role    string `json:"role"`
			Browser string `json:"browser,omitempty"`
		}
		json.Unmarshal(result.Data.Connections, &conns)

		browsers := 0
		for _, conn := range conns {
			if conn.Role == "browser" {
				browsers++
			}
		}
		fmt.Printf("browsers: %d connected\n", browsers)
		for _, conn := range conns {
			if conn.Role == "browser" {
				fmt.Printf("  %s (%s)\n", conn.ID, conn.Browser)
			}
		}

		// display connection history
		var history []struct {
			Time    string `json:"time"`
			Event   string `json:"event"`
			ID      string `json:"id"`
			Role    string `json:"role"`
			Browser string `json:"browser,omitempty"`
		}
		json.Unmarshal(result.Data.History, &history)

		// filter to browser events only (cli connect/disconnect is noise)
		var browserHistory []struct {
			Time    string `json:"time"`
			Event   string `json:"event"`
			ID      string `json:"id"`
			Role    string `json:"role"`
			Browser string `json:"browser,omitempty"`
		}
		for _, evt := range history {
			if evt.Role == "browser" {
				browserHistory = append(browserHistory, evt)
			}
		}

		if len(browserHistory) > 0 {
			n, _ := cmd.Flags().GetInt("history")
			if n <= 0 {
				n = 5
			}
			start := 0
			if len(browserHistory) > n {
				start = len(browserHistory) - n
			}
			shown := browserHistory[start:]
			fmt.Printf("\nrecent browser events (last %d of %d, use --history N for more):\n", len(shown), len(browserHistory))
			for _, evt := range shown {
				label := evt.ID
				if evt.Browser != "" {
					label = fmt.Sprintf("%s (%s)", evt.ID, evt.Browser)
				}
				fmt.Printf("  %s  %-13s  %s\n", evt.Time, evt.Event, label)
			}
		}

		return nil
	},
}

func init() {
	daemonStartCmd.Flags().Bool("background", false, "start daemon in background and return immediately")
	daemonStatusCmd.Flags().Int("history", 5, "number of recent connection events to show")
	daemonCmd.AddCommand(daemonStartCmd, daemonStopCmd, daemonStatusCmd)
	rootCmd.AddCommand(daemonCmd)
}
