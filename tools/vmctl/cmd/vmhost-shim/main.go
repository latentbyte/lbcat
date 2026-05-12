// vmhost-shim is the Native Messaging bridge binary.
// The browser spawns this process; it relays frames between
// the browser's stdin/stdout and the vmhost daemon's Unix socket.
package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/scriptscat/scriptcat/tools/vmctl/internal/protocol"
	"github.com/scriptscat/scriptcat/tools/vmctl/internal/shim"
)

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lshortfile)

	// redirect logs to a file since the browser discards shim stderr
	logPath := protocol.ShimLogPath()
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err == nil {
		if f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			log.SetOutput(f)
			defer f.Close()
		}
	}

	cfg := shim.Config{
		Browser:     envOr("VMCTL_BROWSER", ""),
		ExtensionID: envOr("VMCTL_EXTENSION_ID", ""),
		Profile:     envOr("VMCTL_PROFILE", ""),
	}
	if v, err := strconv.Atoi(envOr("VMCTL_MANIFEST_VERSION", "")); err == nil {
		cfg.ManifestVersion = v
	}

	// chrome passes the extension origin as the first arg after the binary
	// e.g., vmhost-shim chrome-extension://abcdef1234/
	if len(os.Args) > 1 {
		arg := os.Args[1]
		cfg.ExtensionID = arg
		// infer browser from origin scheme
		if strings.HasPrefix(arg, "chrome-extension://") {
			if cfg.Browser == "" {
				cfg.Browser = "chrome"
			}
			cfg.ManifestVersion = 2 // MV2 uses background page which keeps NM alive
		}
	}

	// if browser is still unknown, detect from parent process name
	if cfg.Browser == "" {
		cfg.Browser = detectBrowserFromParent()
	}

	if cfg.Browser == "" {
		cfg.Browser = "unknown"
	}

	log.Printf("shim starting: browser=%s ext=%s pid=%d ppid=%d",
		cfg.Browser, cfg.ExtensionID, os.Getpid(), os.Getppid())

	if err := shim.Run(cfg); err != nil {
		log.Fatalf("shim exiting with error: %v", err)
	}
	log.Printf("shim exiting normally: browser=%s", cfg.Browser)
}

// detectBrowserFromParent identifies the browser by inspecting the parent
// process name. The browser spawns the shim directly via Native Messaging,
// so os.Getppid() gives us the browser's PID.
func detectBrowserFromParent() string {
	ppid := os.Getppid()
	name := parentProcessName(ppid)
	if name == "" {
		return ""
	}
	return matchBrowserName(name)
}

// parentProcessName returns the executable name of the given PID.
func parentProcessName(pid int) string {
	switch runtime.GOOS {
	case "linux":
		// /proc/<pid>/comm contains the process name (max 15 chars, no path)
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(data))
	case "darwin":
		// ps -p <pid> -o comm= gives the full executable path
		out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "comm=").Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	default:
		return ""
	}
}

// matchBrowserName maps a process name (or path) to a known browser identifier.
// it checks the base name of the executable against known browser names.
func matchBrowserName(procName string) string {
	// normalize: take the base name, lowercase it
	base := strings.ToLower(filepath.Base(procName))

	// map of process name patterns to browser identifiers
	// order matters: more specific matches first
	browsers := []struct {
		patterns []string
		name     string
	}{
		{[]string{"zen"}, "zen"},
		{[]string{"waterfox"}, "waterfox"},
		{[]string{"librewolf"}, "librewolf"},
		{[]string{"floorp"}, "floorp"},
		{[]string{"brave"}, "brave"},
		{[]string{"vivaldi"}, "vivaldi"},
		{[]string{"opera"}, "opera"},
		{[]string{"edge", "msedge"}, "edge"},
		{[]string{"chromium"}, "chromium"},
		{[]string{"chrome", "google chrome", "google-chrome"}, "chrome"},
		{[]string{"firefox"}, "firefox"},
	}

	for _, b := range browsers {
		for _, p := range b.patterns {
			if base == p || strings.Contains(base, p) {
				return b.name
			}
		}
	}
	return ""
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
