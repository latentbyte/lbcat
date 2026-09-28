package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

func nowTimestamp() string {
	return time.Now().Format(time.RFC3339)
}

// DefaultIdleTimeout is how long the daemon waits after all connections
// close before shutting itself down.
const DefaultIdleTimeout = 5 * time.Minute

// Server is the Browser Control daemon. It listens on a Unix socket,
// accepts connections from shims and CLI clients, and routes
// messages between them.
type Server struct {
	listener    net.Listener
	lockFile    *os.File
	reg         *Registry
	router      *Router
	wg          sync.WaitGroup
	IdleTimeout time.Duration // 0 disables idle shutdown
	cancel      context.CancelFunc
	idleMu      sync.Mutex
	idleTimer   *time.Timer
}

// NewServer creates a daemon server.
func NewServer() *Server {
	reg := NewRegistry()
	return &Server{
		reg:         reg,
		router:      NewRouter(reg),
		IdleTimeout: DefaultIdleTimeout,
	}
}

// Listen starts the Unix socket listener.
func (s *Server) Listen() error {
	sockPath := protocol.SocketPath()

	// ensure state directory exists
	if err := os.MkdirAll(filepath.Dir(sockPath), 0o700); err != nil {
		return fmt.Errorf("creating state dir: %w", err)
	}

	lockFile, err := os.OpenFile(filepath.Join(filepath.Dir(sockPath), "browser-control.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("opening daemon lock: %w", err)
	}
	if err := syscall.Flock(int(lockFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lockFile.Close()
		return fmt.Errorf("daemon already running or starting: %w", err)
	}
	defer func() {
		if s.lockFile == nil {
			_ = lockFile.Close()
		}
	}()

	if _, err := os.Lstat(sockPath); err == nil {
		conn, dialErr := net.DialTimeout("unix", sockPath, 200*time.Millisecond)
		if dialErr == nil {
			_ = conn.Close()
			return fmt.Errorf("daemon already listening on %s", sockPath)
		}
		if !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return fmt.Errorf("checking existing socket: %w", dialErr)
		}
		if err := os.Remove(sockPath); err != nil {
			return fmt.Errorf("removing stale socket: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("checking socket: %w", err)
	}

	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", sockPath, err)
	}

	// restrict socket to owner
	if err := os.Chmod(sockPath, 0o600); err != nil {
		ln.Close()
		return fmt.Errorf("setting socket permissions: %w", err)
	}

	s.listener = ln
	s.lockFile = lockFile

	// write PID file
	pidPath := protocol.PIDPath()
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		log.Printf("warning: could not write PID file: %v", err)
	}

	log.Printf("daemon listening on %s (pid %d)", sockPath, os.Getpid())
	return nil
}

// Serve accepts connections until the context is cancelled.
func (s *Server) Serve(ctx context.Context) error {
	ctx, s.cancel = context.WithCancel(ctx)

	go func() {
		<-ctx.Done()
		s.listener.Close()
	}()

	// start idle timer if no connections arrive
	s.resetIdleTimer()

	for {
		raw, err := s.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				s.wg.Wait()
				return ctx.Err()
			default:
				log.Printf("accept error: %v", err)
				continue
			}
		}

		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handleConn(raw)
		}()
	}
}

// resetIdleTimer resets or starts the idle shutdown timer.
// Called when a connection closes and no connections remain.
func (s *Server) resetIdleTimer() {
	if s.IdleTimeout <= 0 {
		return
	}
	s.idleMu.Lock()
	defer s.idleMu.Unlock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}
	s.idleTimer = time.AfterFunc(s.IdleTimeout, func() {
		log.Printf("idle timeout (%v), shutting down", s.IdleTimeout)
		if s.cancel != nil {
			s.cancel()
		}
	})
}

// cancelIdleTimer stops the idle timer because a connection is active.
func (s *Server) cancelIdleTimer() {
	s.idleMu.Lock()
	defer s.idleMu.Unlock()
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
}

// checkIdle starts the idle timer if no connections remain.
func (s *Server) checkIdle() {
	if len(s.reg.PeerIDs("")) == 0 {
		s.resetIdleTimer()
	}
}

// Shutdown cleans up resources.
func (s *Server) Shutdown() {
	s.cancelIdleTimer()
	if s.listener != nil {
		s.listener.Close()
	}
	os.Remove(protocol.SocketPath())
	os.Remove(protocol.PIDPath())
	if s.lockFile != nil {
		_ = s.lockFile.Close()
		s.lockFile = nil
	}
	log.Println("daemon shutdown complete")
}

// handleConn processes a single connection: handshake then message loop.
func (s *Server) handleConn(raw net.Conn) {
	defer raw.Close()

	// first frame must be a handshake
	frame, err := protocol.ReadFrame(raw)
	if err != nil {
		log.Printf("handshake read error: %v", err)
		return
	}

	var hs protocol.Handshake
	if err := json.Unmarshal(frame, &hs); err != nil {
		log.Printf("handshake decode error: %v", err)
		return
	}
	if hs.Type != protocol.MsgHandshake {
		log.Printf("expected handshake, got %s", hs.Type)
		return
	}

	conn := s.reg.Add(raw, &hs)
	s.cancelIdleTimer()

	s.reg.RecordEvent(ConnEvent{
		Time:    nowTimestamp(),
		Event:   "connected",
		ID:      conn.ID,
		Role:    string(conn.Role),
		Browser: conn.Meta.Browser,
	})
	if err := s.router.BroadcastBrowserLifecycle(conn, "browser-connected"); err != nil {
		log.Printf("browser lifecycle broadcast failed: %v", err)
	}

	defer func() {
		s.reg.RecordEvent(ConnEvent{
			Time:    nowTimestamp(),
			Event:   "disconnected",
			ID:      conn.ID,
			Role:    string(conn.Role),
			Browser: conn.Meta.Browser,
		})
		if err := s.router.BroadcastBrowserLifecycle(conn, "browser-disconnected"); err != nil {
			log.Printf("browser lifecycle broadcast failed: %v", err)
		}
		s.reg.Remove(conn.ID)
		s.router.ClearPending(conn.ID)
		conn.Close()
		log.Printf("connection closed: %s", conn)
		s.checkIdle()
	}()

	log.Printf("connection established: %s", conn)

	// send handshake ack
	ack := protocol.HandshakeAck{
		ID:     hs.ID,
		Type:   protocol.MsgHandshakeAck,
		ConnID: conn.ID,
		Peers:  s.reg.PeerIDs(conn.ID),
	}
	if err := conn.WriteJSON(&ack); err != nil {
		log.Printf("handshake ack write error: %v", err)
		return
	}

	// message loop
	for {
		env, err := conn.ReadEnvelope()
		if err != nil {
			// EOF is normal (disconnect)
			return
		}
		if err := s.router.Route(conn, env); err != nil {
			log.Printf("route error from %s: %v", conn.ID, err)
		}
	}
}

// Status returns information about the daemon's current state.
func (s *Server) Status() map[string]any {
	return map[string]any{
		"socket":      protocol.SocketPath(),
		"pid":         os.Getpid(),
		"connections": s.reg.Info(),
		"history":     s.reg.History(),
	}
}
