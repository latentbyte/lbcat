package main

import (
	"os"

	"github.com/scriptscat/scriptcat/tools/vmctl/cmd/vmctl/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		os.Exit(1)
	}
}
