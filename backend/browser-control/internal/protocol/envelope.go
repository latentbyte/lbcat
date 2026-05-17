package protocol

import "encoding/json"

// MsgType identifies the purpose of a message in the routing layer.
type MsgType string

const (
	MsgRequest      MsgType = "request"
	MsgResponse     MsgType = "response"
	MsgEvent        MsgType = "event"
	MsgHandshake    MsgType = "handshake"
	MsgHandshakeAck MsgType = "handshake-ack"
)

// Envelope is the routing wrapper around every message.
// The daemon inspects only these fields; payload is opaque.
type Envelope struct {
	ID      string          `json:"id"`
	Type    MsgType         `json:"type"`
	Target  string          `json:"target,omitempty"`  // conn ID or "*" for broadcast, empty for responses
	Source  string          `json:"source,omitempty"`  // daemon-assigned source conn ID for responses and events
	Payload json.RawMessage `json:"payload,omitempty"` // opaque to daemon
}

// ConnRole distinguishes browser shims from CLI clients.
type ConnRole string

const (
	RoleBrowser ConnRole = "browser"
	RoleCLI     ConnRole = "cli"
)

// Handshake is sent by a new connection to identify itself.
type Handshake struct {
	ID              string   `json:"id"`
	Type            MsgType  `json:"type"` // always MsgHandshake
	Role            ConnRole `json:"role"`
	Browser         string   `json:"browser,omitempty"`          // chrome, firefox, brave, zen
	Profile         string   `json:"profile,omitempty"`          // browser profile name
	ExtensionID     string   `json:"extension_id,omitempty"`     // for browser connections
	ManifestVersion int      `json:"manifest_version,omitempty"` // 2 or 3
	VMVersion       string   `json:"vm_version,omitempty"`       // extension version
	PID             int      `json:"pid,omitempty"`              // for CLI connections
}

// HandshakeAck is the daemon's response to a handshake.
type HandshakeAck struct {
	ID     string   `json:"id"`
	Type   MsgType  `json:"type"` // always MsgHandshakeAck
	ConnID string   `json:"conn_id"`
	Peers  []string `json:"peers"` // other connected conn IDs
}
