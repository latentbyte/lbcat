package daemon

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"

	"github.com/scriptscat/scriptcat/tools/vmctl/internal/protocol"
)

// Conn wraps a socket connection with identity metadata.
type Conn struct {
	ID   string
	Role protocol.ConnRole
	Meta ConnMeta
	raw  net.Conn

	mu     sync.Mutex // serializes writes
	closed atomic.Bool
}

// ConnMeta holds optional identity details from the handshake.
type ConnMeta struct {
	Browser         string `json:"browser,omitempty"`
	Profile         string `json:"profile,omitempty"`
	ExtensionID     string `json:"extension_id,omitempty"`
	ManifestVersion int    `json:"manifest_version,omitempty"`
	VMVersion       string `json:"vm_version,omitempty"`
	PID             int    `json:"pid,omitempty"`
}

// ReadEnvelope reads the next envelope from the connection.
func (c *Conn) ReadEnvelope() (*protocol.Envelope, error) {
	return protocol.ReadEnvelope(c.raw)
}

// WriteEnvelope sends an envelope to the connection.
func (c *Conn) WriteEnvelope(env *protocol.Envelope) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return protocol.WriteEnvelope(c.raw, env)
}

// WriteJSON marshals v and sends it as a frame.
func (c *Conn) WriteJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return protocol.WriteJSON(c.raw, v)
}

// Close closes the underlying connection.
func (c *Conn) Close() error {
	if c.closed.CompareAndSwap(false, true) {
		return c.raw.Close()
	}
	return nil
}

// String returns a human-readable label for the connection.
func (c *Conn) String() string {
	if c.Role == protocol.RoleBrowser {
		return fmt.Sprintf("%s (%s)", c.ID, c.Meta.Browser)
	}
	return fmt.Sprintf("%s (cli pid=%d)", c.ID, c.Meta.PID)
}

// Registry tracks all active connections, assigning IDs and
// providing lookup by ID or role.
type Registry struct {
	mu      sync.RWMutex
	conns   map[string]*Conn
	seq     map[string]int // per-browser/cli sequence counters
	history []ConnEvent    // ring buffer of recent events
}

// NewRegistry creates an empty connection registry.
func NewRegistry() *Registry {
	return &Registry{
		conns: make(map[string]*Conn),
		seq:   make(map[string]int),
	}
}

// Add registers a new connection from a raw socket and handshake.
func (r *Registry) Add(raw net.Conn, hs *protocol.Handshake) *Conn {
	r.mu.Lock()
	defer r.mu.Unlock()

	prefix := string(hs.Role)
	if hs.Role == protocol.RoleBrowser && hs.Browser != "" {
		prefix = hs.Browser
	}

	r.seq[prefix]++
	id := fmt.Sprintf("%s-%02d", prefix, r.seq[prefix])

	c := &Conn{
		ID:   id,
		Role: hs.Role,
		raw:  raw,
		Meta: ConnMeta{
			Browser:         hs.Browser,
			Profile:         hs.Profile,
			ExtensionID:     hs.ExtensionID,
			ManifestVersion: hs.ManifestVersion,
			VMVersion:       hs.VMVersion,
			PID:             hs.PID,
		},
	}
	r.conns[id] = c
	return c
}

// Remove deregisters a connection.
func (r *Registry) Remove(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.conns, id)
}

// Get returns a connection by ID.
func (r *Registry) Get(id string) (*Conn, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.conns[id]
	return c, ok
}

// Browsers returns all browser-role connections.
func (r *Registry) Browsers() []*Conn {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []*Conn
	for _, c := range r.conns {
		if c.Role == protocol.RoleBrowser {
			out = append(out, c)
		}
	}
	return out
}

// CLIs returns all CLI-role connections.
func (r *Registry) CLIs() []*Conn {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []*Conn
	for _, c := range r.conns {
		if c.Role == protocol.RoleCLI {
			out = append(out, c)
		}
	}
	return out
}

// PeerIDs returns all connection IDs except the given one.
func (r *Registry) PeerIDs(exclude string) []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var ids []string
	for id := range r.conns {
		if id != exclude {
			ids = append(ids, id)
		}
	}
	return ids
}

// ConnInfo is a summary of a connection for status reporting.
type ConnInfo struct {
	ID      string          `json:"id"`
	Role    string          `json:"role"`
	Browser string          `json:"browser,omitempty"`
	Meta    json.RawMessage `json:"meta,omitempty"`
}

// ConnEvent records a connection lifecycle event for the history log.
type ConnEvent struct {
	Time    string `json:"time"`
	Event   string `json:"event"` // "connected" or "disconnected"
	ID      string `json:"id"`
	Role    string `json:"role"`
	Browser string `json:"browser,omitempty"`
}

const maxHistoryEvents = 50

// Info returns a summary of all connections.
func (r *Registry) Info() []ConnInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []ConnInfo
	for _, c := range r.conns {
		meta, _ := json.Marshal(c.Meta)
		out = append(out, ConnInfo{
			ID:      c.ID,
			Role:    string(c.Role),
			Browser: c.Meta.Browser,
			Meta:    meta,
		})
	}
	return out
}

// RecordEvent adds a connection event to the history ring buffer.
func (r *Registry) RecordEvent(evt ConnEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.history = append(r.history, evt)
	if len(r.history) > maxHistoryEvents {
		r.history = r.history[len(r.history)-maxHistoryEvents:]
	}
}

// History returns a copy of recent connection events.
func (r *Registry) History() []ConnEvent {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]ConnEvent, len(r.history))
	copy(out, r.history)
	return out
}
