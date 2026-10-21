// package shim implements the Native Messaging bridge process.
// It relays length-prefixed frames between the browser (stdin/stdout)
// and the Browser Control daemon (Unix socket) without inspecting payloads.
package shim

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

// Config holds shim startup parameters, typically from env or args.
type Config struct {
	Browser         string // chrome, firefox, brave
	ExtensionID     string // passed by browser in argv or env
	Profile         string // browser profile name
	ManifestVersion int    // extension manifest version (2 or 3)
}

// Run is the shim's main loop. It connects to the daemon and relays
// frames between stdin/stdout and the socket until either side closes.
func Run(cfg Config) error {
	conn, err := connectToDaemon()
	if err != nil {
		return fmt.Errorf("connecting to daemon: %w", err)
	}
	defer conn.Close()

	// send handshake so daemon knows who we are
	hs := protocol.Handshake{
		ID:              "shim-handshake",
		Type:            protocol.MsgHandshake,
		Role:            protocol.RoleBrowser,
		Browser:         cfg.Browser,
		ExtensionID:     cfg.ExtensionID,
		Profile:         cfg.Profile,
		ManifestVersion: cfg.ManifestVersion,
	}
	if err := protocol.WriteJSON(conn, &hs); err != nil {
		return fmt.Errorf("sending handshake: %w", err)
	}

	// wait for ack
	if _, err := protocol.ReadFrame(conn); err != nil {
		return fmt.Errorf("reading handshake ack: %w", err)
	}

	// ensure offload directory exists
	offloadDir := protocol.OffloadDir()
	if err := os.MkdirAll(offloadDir, 0o700); err != nil {
		log.Printf("warning: cannot create offload dir %s: %v", offloadDir, err)
	}

	relayBoth(os.Stdin, os.Stdout, conn, offloadDir)
	return nil
}

func relayBoth(browserIn io.ReadCloser, browserOut io.Writer, conn net.Conn, offloadDir string) {
	// return when either direction ends; closing os.Stdin does not wake a
	// pending read, so waiting for both would keep the shim alive with a dead
	// daemon and the browser would never reconnect
	stopped := make(chan struct{}, 2)

	// browser stdin -> daemon socket (with large-frame offload)
	go func() {
		defer func() { stopped <- struct{}{} }()
		relayBrowserToDaemon(browserIn, conn, offloadDir)
	}()

	// daemon socket -> browser stdout
	go func() {
		defer func() { stopped <- struct{}{} }()
		relay(conn, browserOut, "daemon->browser")
	}()

	<-stopped
	_ = browserIn.Close()
	_ = conn.Close()
}

// relay copies length-prefixed frames from src to dst.
func relay(src io.Reader, dst io.Writer, label string) {
	for {
		frame, err := protocol.ReadFrame(src)
		if err != nil {
			if err != io.EOF {
				log.Printf("%s read error: %v", label, err)
			}
			return
		}
		if err := protocol.WriteFrame(dst, json.RawMessage(frame)); err != nil {
			log.Printf("%s write error: %v", label, err)
			return
		}
	}
}

// relayBrowserToDaemon reads frames from the browser (up to 64 MB) and
// relays them to the daemon. Frames that exceed the daemon's 1 MB limit
// are offloaded to a temp file; only a small envelope with the file path
// is sent over the socket.
func relayBrowserToDaemon(src io.Reader, dst io.Writer, offloadDir string) {
	for {
		frame, err := protocol.ReadFrameN(src, protocol.BrowserMaxFrameSize)
		if err != nil {
			if err != io.EOF {
				log.Printf("browser->daemon read error: %v", err)
			}
			return
		}

		// small enough for the daemon socket, relay directly
		if uint32(len(frame)) <= protocol.MaxFrameSize {
			if err := protocol.WriteFrame(dst, frame); err != nil {
				log.Printf("browser->daemon write error: %v", err)
				return
			}
			continue
		}

		// large frame: offload payload to a temp file
		rewritten, err := offloadFrame(frame, offloadDir)
		if err != nil {
			log.Printf("browser->daemon offload error: %v", err)
			return
		}
		if err := protocol.WriteFrame(dst, rewritten); err != nil {
			log.Printf("browser->daemon write error (offloaded): %v", err)
			return
		}
	}
}

// offloadFrame takes a large envelope frame, writes the payload to a
// temp file, and returns a rewritten envelope where payload is replaced
// with {"_offload": "/path/to/file"}.
func offloadFrame(frame json.RawMessage, offloadDir string) (json.RawMessage, error) {
	// parse just the envelope structure
	var env protocol.Envelope
	if err := json.Unmarshal(frame, &env); err != nil {
		// not a valid envelope, can't offload; drop it
		return nil, fmt.Errorf("parsing envelope for offload: %w", err)
	}

	// write the original payload to a temp file
	f, err := os.CreateTemp(offloadDir, "frame-*.json")
	if err != nil {
		return nil, fmt.Errorf("creating offload file: %w", err)
	}
	if _, err := f.Write(env.Payload); err != nil {
		f.Close()
		os.Remove(f.Name())
		return nil, fmt.Errorf("writing offload file: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(f.Name())
		return nil, fmt.Errorf("closing offload file: %w", err)
	}

	log.Printf("offloaded %d bytes to %s (msg id=%s)", len(env.Payload), f.Name(), env.ID)

	// rewrite the envelope with a file reference instead of the payload
	ref, _ := json.Marshal(map[string]string{"_offload": f.Name()})
	env.Payload = ref

	rewritten, err := json.Marshal(&env)
	if err != nil {
		os.Remove(f.Name())
		return nil, fmt.Errorf("re-encoding offloaded envelope: %w", err)
	}
	return rewritten, nil
}

// connectToDaemon tries to connect to the daemon socket.
// If the daemon isn't running, it attempts to start it.
func connectToDaemon() (net.Conn, error) {
	sockPath := protocol.SocketPath()

	conn, err := net.Dial("unix", sockPath)
	if err == nil {
		return conn, nil
	}

	// daemon not running, try to start it
	if err := startDaemon(); err != nil {
		return nil, fmt.Errorf("auto-starting daemon: %w", err)
	}

	// wait for socket to appear
	for i := range 20 {
		_ = i
		time.Sleep(100 * time.Millisecond)
		conn, err = net.Dial("unix", sockPath)
		if err == nil {
			return conn, nil
		}
	}
	return nil, fmt.Errorf("daemon did not start within 2 seconds")
}

// startDaemon launches the Browser Control daemon in the background.
func startDaemon() error {
	// look for browser-control-daemon next to our own binary
	self, err := os.Executable()
	if err != nil {
		return err
	}

	// try browser-control-daemon in same directory, then PATH
	candidates := []string{
		filepath.Join(filepath.Dir(self), "browser-control-daemon"),
		"browser-control-daemon",
	}

	for _, bin := range candidates {
		cmd := exec.Command(bin, "daemon", "start", "--background")
		cmd.Stdout = nil
		cmd.Stderr = nil
		if err := cmd.Start(); err == nil {
			// detach; don't wait
			go cmd.Wait() //nolint:errcheck
			return nil
		}
	}
	return fmt.Errorf("could not find browser-control-daemon binary")
}
