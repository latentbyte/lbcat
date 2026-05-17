// vmhost is the long-lived daemon process. It listens on a Unix socket,
// accepts connections from browser shims and CLI clients, and routes
// messages between them without inspecting payloads.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/daemon"
	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)

	// set up log file
	logPath := protocol.LogPath()
	if err := os.MkdirAll(protocol.StateDir(), 0o700); err == nil {
		if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			log.SetOutput(f)
			defer f.Close()
		}
	}

	srv := daemon.NewServer()
	if err := srv.Listen(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
	defer srv.Shutdown()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := srv.Serve(ctx); err != nil && err != context.Canceled {
		log.Printf("serve error: %v", err)
	}
}
