// package protocol implements the length-prefixed framing used by both
// Native Messaging (browser<->shim) and the daemon Unix socket.
//
// Wire format: [4 bytes little-endian uint32 length][N bytes UTF-8 JSON]
package protocol

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

// MaxFrameSize is the default limit for daemon/CLI socket frames (1 MB).
// This matches Chrome's Native Messaging limit.
const MaxFrameSize = 1024 * 1024

// BrowserMaxFrameSize bounds shim memory while accepting large browser responses.
const BrowserMaxFrameSize = 64 * 1024 * 1024

// ReadFrame reads one length-prefixed JSON frame from r,
// enforcing MaxFrameSize as the upper bound.
func ReadFrame(r io.Reader) (json.RawMessage, error) {
	return ReadFrameN(r, MaxFrameSize)
}

// ReadFrameN reads one length-prefixed JSON frame from r,
// enforcing maxSize as the upper bound.
func ReadFrameN(r io.Reader, maxSize uint32) (json.RawMessage, error) {
	var length uint32
	if err := binary.Read(r, binary.LittleEndian, &length); err != nil {
		return nil, fmt.Errorf("reading frame length: %w", err)
	}
	if length == 0 {
		return nil, fmt.Errorf("empty frame")
	}
	if length > maxSize {
		return nil, fmt.Errorf("frame too large: %d bytes (max %d)", length, maxSize)
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, fmt.Errorf("reading frame body: %w", err)
	}
	return json.RawMessage(buf), nil
}

// WriteFrame writes one length-prefixed JSON frame to w.
func WriteFrame(w io.Writer, data json.RawMessage) error {
	length := uint32(len(data))
	if length > MaxFrameSize {
		return fmt.Errorf("frame too large: %d bytes (max %d)", length, MaxFrameSize)
	}
	if err := binary.Write(w, binary.LittleEndian, length); err != nil {
		return fmt.Errorf("writing frame length: %w", err)
	}
	if _, err := w.Write(data); err != nil {
		return fmt.Errorf("writing frame body: %w", err)
	}
	return nil
}

// WriteFrameN writes one length-prefixed JSON frame to w,
// enforcing maxSize as the upper bound.
func WriteFrameN(w io.Writer, data json.RawMessage, maxSize uint32) error {
	length := uint32(len(data))
	if length > maxSize {
		return fmt.Errorf("frame too large: %d bytes (max %d)", length, maxSize)
	}
	if err := binary.Write(w, binary.LittleEndian, length); err != nil {
		return fmt.Errorf("writing frame length: %w", err)
	}
	if _, err := w.Write(data); err != nil {
		return fmt.Errorf("writing frame body: %w", err)
	}
	return nil
}

// ReadEnvelope reads a frame and decodes it as an Envelope.
func ReadEnvelope(r io.Reader) (*Envelope, error) {
	raw, err := ReadFrame(r)
	if err != nil {
		return nil, err
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("decoding envelope: %w", err)
	}
	return &env, nil
}

// WriteEnvelope encodes an Envelope and writes it as a frame.
func WriteEnvelope(w io.Writer, env *Envelope) error {
	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("encoding envelope: %w", err)
	}
	return WriteFrame(w, data)
}

// WriteJSON marshals any value and writes it as a frame.
func WriteJSON(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("encoding message: %w", err)
	}
	return WriteFrame(w, data)
}
