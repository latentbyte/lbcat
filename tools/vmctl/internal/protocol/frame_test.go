package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	msg := json.RawMessage(`{"hello":"world","n":42}`)

	var buf bytes.Buffer
	if err := WriteFrame(&buf, msg); err != nil {
		t.Fatalf("WriteFrame: %v", err)
	}

	// verify wire format: 4-byte LE length + body
	data := buf.Bytes()
	if len(data) != 4+len(msg) {
		t.Fatalf("expected %d bytes, got %d", 4+len(msg), len(data))
	}
	length := binary.LittleEndian.Uint32(data[:4])
	if int(length) != len(msg) {
		t.Fatalf("length prefix: expected %d, got %d", len(msg), length)
	}

	got, err := ReadFrame(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatalf("round-trip mismatch: %s != %s", got, msg)
	}
}

func TestEnvelopeRoundTrip(t *testing.T) {
	env := &Envelope{
		ID:      "test-123",
		Type:    MsgRequest,
		Target:  "chrome-01",
		Payload: json.RawMessage(`{"cmd":"tabs.list"}`),
	}

	var buf bytes.Buffer
	if err := WriteEnvelope(&buf, env); err != nil {
		t.Fatalf("WriteEnvelope: %v", err)
	}

	got, err := ReadEnvelope(&buf)
	if err != nil {
		t.Fatalf("ReadEnvelope: %v", err)
	}

	if got.ID != env.ID {
		t.Errorf("ID: %q != %q", got.ID, env.ID)
	}
	if got.Type != env.Type {
		t.Errorf("Type: %q != %q", got.Type, env.Type)
	}
	if got.Target != env.Target {
		t.Errorf("Target: %q != %q", got.Target, env.Target)
	}
	if string(got.Payload) != string(env.Payload) {
		t.Errorf("Payload: %s != %s", got.Payload, env.Payload)
	}
}

func TestMultipleFrames(t *testing.T) {
	messages := []string{
		`{"a":1}`,
		`{"b":"two"}`,
		`{"c":[3,4,5]}`,
	}

	var buf bytes.Buffer
	for _, m := range messages {
		if err := WriteFrame(&buf, json.RawMessage(m)); err != nil {
			t.Fatalf("WriteFrame: %v", err)
		}
	}

	reader := bytes.NewReader(buf.Bytes())
	for i, want := range messages {
		got, err := ReadFrame(reader)
		if err != nil {
			t.Fatalf("ReadFrame[%d]: %v", i, err)
		}
		if string(got) != want {
			t.Errorf("frame[%d]: %s != %s", i, got, want)
		}
	}

	// next read should EOF
	_, err := ReadFrame(reader)
	if err == nil {
		t.Fatal("expected error after last frame")
	}
}

func TestReadFrameEmptyInput(t *testing.T) {
	_, err := ReadFrame(bytes.NewReader(nil))
	if err == nil {
		t.Fatal("expected error on empty input")
	}
}

func TestReadFrameTruncatedBody(t *testing.T) {
	// write a length prefix claiming 100 bytes but only provide 5
	var buf bytes.Buffer
	binary.Write(&buf, binary.LittleEndian, uint32(100))
	buf.Write([]byte("short"))

	_, err := ReadFrame(&buf)
	if err == nil {
		t.Fatal("expected error on truncated body")
	}
}

func TestWriteFrameTooLarge(t *testing.T) {
	huge := make(json.RawMessage, MaxFrameSize+1)
	err := WriteFrame(io.Discard, huge)
	if err == nil {
		t.Fatal("expected error for oversized frame")
	}
}

func TestReadFrameNCustomLimit(t *testing.T) {
	msg := json.RawMessage(`{"screenshot":"data..."}`)

	var buf bytes.Buffer
	// write with a higher limit
	if err := WriteFrameN(&buf, msg, BrowserMaxFrameSize); err != nil {
		t.Fatalf("WriteFrameN: %v", err)
	}

	// read with higher limit should succeed
	got, err := ReadFrameN(bytes.NewReader(buf.Bytes()), BrowserMaxFrameSize)
	if err != nil {
		t.Fatalf("ReadFrameN: %v", err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatalf("round-trip mismatch: %s != %s", got, msg)
	}
}

func TestReadFrameNRejectsOverLimit(t *testing.T) {
	// create a frame that's just over 1MB but under 4MB
	data := make(json.RawMessage, MaxFrameSize+100)
	for i := range data {
		data[i] = 'x'
	}

	var buf bytes.Buffer
	// write with browser limit (4MB)
	if err := WriteFrameN(&buf, data, BrowserMaxFrameSize); err != nil {
		t.Fatalf("WriteFrameN: %v", err)
	}

	// reading with default 1MB limit should fail
	_, err := ReadFrameN(bytes.NewReader(buf.Bytes()), MaxFrameSize)
	if err == nil {
		t.Fatal("expected error for frame exceeding 1MB limit")
	}

	// reading with browser 4MB limit should succeed
	got, err := ReadFrameN(bytes.NewReader(buf.Bytes()), BrowserMaxFrameSize)
	if err != nil {
		t.Fatalf("ReadFrameN with browser limit: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("data mismatch after ReadFrameN with browser limit")
	}
}

func TestBrowserMaxFrameSize(t *testing.T) {
	if BrowserMaxFrameSize != 4*1024*1024 {
		t.Fatalf("BrowserMaxFrameSize: expected %d, got %d", 4*1024*1024, BrowserMaxFrameSize)
	}
	if MaxFrameSize != 1024*1024 {
		t.Fatalf("MaxFrameSize: expected %d, got %d", 1024*1024, MaxFrameSize)
	}
}
