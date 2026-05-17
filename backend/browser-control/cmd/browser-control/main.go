package main

import (
	"os"

	"github.com/scriptscat/scriptcat/backend/browser-control/cmd/browser-control/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		os.Exit(1)
	}
}
