package cmd

import "github.com/spf13/cobra"

func newHumanCmd() *cobra.Command {
	command := &cobra.Command{
		Use:   "human",
		Short: "Human-operated browser commands across all windows",
		Long:  "Human-operated browser commands across all windows. Lists tab metadata without an agent window or task session; does not grant page access or authenticate a human.",
	}
	tabs := &cobra.Command{Use: "tabs", Short: "Inspect tab metadata across all windows"}
	tabs.AddCommand(newTabsListCmd(true))
	command.AddCommand(tabs)
	return command
}

func init() {
	rootCmd.AddCommand(newHumanCmd())
}
