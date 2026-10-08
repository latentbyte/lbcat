// package cli provides the client-side logic for connecting to the
// Browser Control daemon and exchanging messages.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

// Client connects to the Browser Control daemon over Unix socket.
type Client struct {
	conn    net.Conn
	connID  string   // assigned by daemon
	peers   []string // other connected IDs at handshake time
	reqOnce sync.Once
	reqGate chan struct{}

	SessionID           string
	PersonalTabID       int
	NotifyMissingWindow bool
}

const (
	handshakeTimeout = 2 * time.Second
	requestTimeout   = 30 * time.Second
)

// Connect dials the daemon and performs the CLI handshake.
func Connect() (*Client, error) {
	sockPath := protocol.SocketPath()
	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to daemon at %s: %w\nhint: start the daemon with `browser-control daemon start`", sockPath, err)
	}

	c := &Client{conn: conn}
	if err := c.handshake(); err != nil {
		conn.Close()
		return nil, err
	}
	return c, nil
}

func (c *Client) handshake() error {
	hs := protocol.Handshake{
		ID:   uuid.NewString(),
		Type: protocol.MsgHandshake,
		Role: protocol.RoleCLI,
		PID:  os.Getpid(),
	}
	if err := protocol.WriteJSON(c.conn, &hs); err != nil {
		return fmt.Errorf("sending handshake: %w", err)
	}

	if err := c.conn.SetDeadline(time.Now().Add(handshakeTimeout)); err != nil {
		return fmt.Errorf("setting handshake deadline: %w", err)
	}
	defer c.conn.SetDeadline(time.Time{})

	frame, err := protocol.ReadFrame(c.conn)
	if err != nil {
		return fmt.Errorf("reading handshake ack: %w", err)
	}

	var ack protocol.HandshakeAck
	if err := json.Unmarshal(frame, &ack); err != nil {
		return fmt.Errorf("decoding handshake ack: %w", err)
	}

	c.connID = ack.ConnID
	c.peers = ack.Peers
	return nil
}

// Close disconnects from the daemon.
func (c *Client) Close() error {
	return c.conn.Close()
}

// ConnID returns this client's daemon-assigned connection ID.
func (c *Client) ConnID() string {
	return c.connID
}

// Peers returns the list of other connections at handshake time.
func (c *Client) Peers() []string {
	return c.peers
}

// Request sends a command to a target browser and waits for the response.
// The target is a connection ID (e.g., "chrome-01") or "*" for broadcast.
// The payload is the extension command (opaque to the daemon).
func (c *Client) Request(target string, payload any) (json.RawMessage, error) {
	return c.RequestWithTimeout(target, payload, requestTimeout)
}

// RequestContext stops waiting when the caller's context expires.
func (c *Client) RequestContext(ctx context.Context, target string, payload any) (json.RawMessage, error) {
	return c.request(ctx, target, payload, requestTimeout)
}

// RequestWithTimeout sends a command and waits for response up to timeout.
func (c *Client) RequestWithTimeout(target string, payload any, timeout time.Duration) (json.RawMessage, error) {
	return c.request(context.Background(), target, payload, timeout)
}

func (c *Client) request(ctx context.Context, target string, payload any, timeout time.Duration) (json.RawMessage, error) {
	if timeout <= 0 {
		timeout = requestTimeout
	}
	parentCtx := ctx
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	c.reqOnce.Do(func() { c.reqGate = make(chan struct{}, 1) })
	var response json.RawMessage
	var err error
	select {
	case c.reqGate <- struct{}{}:
		defer func() { <-c.reqGate }()
		err = ctx.Err()
		if err == nil {
			response, err = c.requestScoped(ctx, target, payload, timeout)
		}
	case <-ctx.Done():
		err = ctx.Err()
	}
	if errors.Is(err, context.DeadlineExceeded) && parentCtx.Err() == nil {
		return response, fmt.Errorf("request timed out after %v waiting for %q response", timeout, target)
	}
	return response, err
}

func (c *Client) requestScoped(ctx context.Context, target string, payload any, timeout time.Duration) (json.RawMessage, error) {
	if command, ok := payload.(ExtCommand); ok && scoped(command.Cmd) {
		status, err := c.requestLocked(ctx, target, ExtCommand{Cmd: "agentWindow.status"}, timeout)
		if err != nil {
			return status, fmt.Errorf("agent window safety check failed: %w", err)
		}
		var registration struct {
			Data struct {
				WindowID    int `json:"windowId"`
				MarkerTabID int `json:"markerTabId"`
			} `json:"data"`
		}
		if err := json.Unmarshal(status, &registration); err != nil || registration.Data.WindowID <= 0 || registration.Data.MarkerTabID <= 0 {
			return nil, fmt.Errorf("agent window safety check failed: extension returned invalid registration; reload or upgrade LBCat")
		}
	}
	return c.requestLocked(ctx, target, payload, timeout)
}

func (c *Client) requestLocked(ctx context.Context, target string, payload any, timeout time.Duration) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	command, isCommand := payload.(ExtCommand)
	if isCommand {
		var scopeErr error
		command, scopeErr = c.scopedCommand(command)
		if scopeErr != nil {
			return nil, scopeErr
		}
		payload = command
	}
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encoding payload: %w", err)
	}

	env := protocol.Envelope{
		ID:      uuid.NewString(),
		Type:    protocol.MsgRequest,
		Target:  target,
		Payload: payloadBytes,
	}

	if timeout <= 0 {
		timeout = requestTimeout
	}

	deadline := time.Now().Add(timeout)
	if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
		deadline = ctxDeadline
	}
	if err := c.conn.SetDeadline(deadline); err != nil {
		return nil, fmt.Errorf("setting request deadline: %w", err)
	}
	if ctx.Done() != nil {
		stop := make(chan struct{})
		stopped := make(chan struct{})
		go func() {
			defer close(stopped)
			select {
			case <-ctx.Done():
				_ = c.conn.SetDeadline(time.Now())
			case <-stop:
			}
		}()
		defer func() {
			close(stop)
			<-stopped
			_ = c.conn.SetDeadline(time.Time{})
		}()
	} else {
		defer c.conn.SetDeadline(time.Time{})
	}
	if err := protocol.WriteEnvelope(c.conn, &env); err != nil {
		_ = c.conn.Close()
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, fmt.Errorf("sending request: %w", err)
	}

	// read until this request's response arrives
	var resp *protocol.Envelope
	for {
		resp, err = protocol.ReadEnvelope(c.conn)
		if err != nil {
			_ = c.conn.Close()
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, ctxErr
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				return nil, fmt.Errorf("request timed out after %v waiting for %q response", timeout, target)
			}
			return nil, fmt.Errorf("reading response: %w", err)
		}
		if resp.Type == protocol.MsgEvent {
			// tabs.watch may receive events very quickly, skip until response
			continue
		}
		if resp.Type != protocol.MsgResponse {
			return nil, fmt.Errorf("unexpected message type %q while waiting for response", resp.Type)
		}
		if resp.ID != env.ID {
			return nil, fmt.Errorf("unexpected response id %q, expected %q", resp.ID, env.ID)
		}
		break
	}

	// resolve file-offloaded payloads from the shim
	resolved, err := resolveOffload(resp.Payload)
	if err != nil {
		return nil, fmt.Errorf("resolving offload: %w", err)
	}

	var result struct {
		Error *CommandError `json:"error"`
	}
	if err := json.Unmarshal(resolved, &result); err == nil && result.Error != nil {
		if c.NotifyMissingWindow && result.Error.Code == "AGENT_WINDOW_MISSING" {
			notifyMissingWindow(target)
		}
		return resolved, result.Error
	}
	if c.NotifyMissingWindow && isCommand && clearsMissingWindow(command) {
		clearMissingWindow(target)
	}
	return resolved, nil
}

// resolveOffload checks if a payload contains a {"_offload": "/path"}
// reference from the shim's large-frame offload. If so, it reads the
// file contents as the real payload and removes the temp file.
func resolveOffload(payload json.RawMessage) (json.RawMessage, error) {
	var ref struct {
		Offload string `json:"_offload"`
	}
	if err := json.Unmarshal(payload, &ref); err != nil || ref.Offload == "" {
		// not an offload reference, return as-is
		return payload, nil
	}

	data, err := os.ReadFile(ref.Offload)
	if err != nil {
		return nil, fmt.Errorf("reading offloaded payload from %s: %w", ref.Offload, err)
	}

	// clean up the temp file
	os.Remove(ref.Offload)

	return json.RawMessage(data), nil
}

// ReadEvent reads the next event envelope (blocking).
// Used for streaming subscriptions (tab watch, etc.).
func (c *Client) ReadEvent() (*protocol.Envelope, error) {
	env, err := protocol.ReadEnvelope(c.conn)
	if err != nil {
		return nil, err
	}
	resolved, err := resolveOffload(env.Payload)
	if err != nil {
		return nil, fmt.Errorf("resolving event offload: %w", err)
	}
	env.Payload = resolved
	return env, nil
}

// ExtCommand is a command payload sent to the extension.
type ExtCommand struct {
	Cmd  string `json:"cmd"`
	Args any    `json:"args,omitempty"`
}
