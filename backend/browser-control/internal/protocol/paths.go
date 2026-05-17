package protocol

import (
	"os"
	"path/filepath"
)

const (
	AppName  = "browser-control"
	HostName = "com.latentbyte.browser_control" // native messaging host name for LBCat
)

// StateDir returns the base directory for daemon runtime state.
// Uses XDG_STATE_HOME if set, otherwise ~/.local/state/browser-control.
func StateDir() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(base, AppName)
}

// SocketPath returns the path to the daemon's Unix socket.
func SocketPath() string {
	return filepath.Join(StateDir(), "browser-control.sock")
}

// PIDPath returns the path to the daemon's PID file.
func PIDPath() string {
	return filepath.Join(StateDir(), "browser-control.pid")
}

// LogPath returns the path to the daemon's log file.
func LogPath() string {
	return filepath.Join(StateDir(), "browser-control.log")
}

// ShimLogPath returns the path to the shim's log file.
func ShimLogPath() string {
	return filepath.Join(StateDir(), "shim.log")
}

// OffloadDir returns the directory used for large-frame file offloads.
func OffloadDir() string {
	return filepath.Join(StateDir(), "offload")
}
