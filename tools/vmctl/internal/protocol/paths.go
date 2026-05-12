package protocol

import (
	"os"
	"path/filepath"
)

const (
	AppName  = "vmctl"
	HostName = "com.scriptcat.vmhost" // native messaging host name for ScriptCat
)

// StateDir returns the base directory for daemon runtime state.
// Uses XDG_STATE_HOME if set, otherwise ~/.local/state/vmctl.
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
	return filepath.Join(StateDir(), "vmctl.sock")
}

// PIDPath returns the path to the daemon's PID file.
func PIDPath() string {
	return filepath.Join(StateDir(), "vmctl.pid")
}

// LogPath returns the path to the daemon's log file.
func LogPath() string {
	return filepath.Join(StateDir(), "vmctl.log")
}

// ShimLogPath returns the path to the shim's log file.
func ShimLogPath() string {
	return filepath.Join(StateDir(), "shim.log")
}

// OffloadDir returns the directory used for large-frame file offloads.
func OffloadDir() string {
	return filepath.Join(StateDir(), "offload")
}
