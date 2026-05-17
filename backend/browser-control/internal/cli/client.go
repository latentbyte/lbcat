// package cli provides the client-side logic for connecting to the
// Browser Control daemon and exchanging messages.
package cli

import (
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
	conn   net.Conn
	connID string   // assigned by daemon
	peers  []string // other connected IDs at handshake time
	reqMu  sync.Mutex
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

// RequestWithTimeout sends a command and waits for response up to timeout.
func (c *Client) RequestWithTimeout(target string, payload any, timeout time.Duration) (json.RawMessage, error) {
	c.reqMu.Lock()
	defer c.reqMu.Unlock()

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

	if err := protocol.WriteEnvelope(c.conn, &env); err != nil {
		return nil, fmt.Errorf("sending request: %w", err)
	}

	if timeout <= 0 {
		timeout = requestTimeout
	}

	if err := c.conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return nil, fmt.Errorf("setting request deadline: %w", err)
	}
	defer c.conn.SetDeadline(time.Time{})

	// read until this request's response arrives
	var resp *protocol.Envelope
	for {
		resp, err = protocol.ReadEnvelope(c.conn)
		if err != nil {
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
