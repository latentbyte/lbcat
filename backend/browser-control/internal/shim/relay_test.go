package shim

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

func TestRelayBrowserToDaemonOffloadsLargeResponse(t *testing.T) {
	response := &protocol.Envelope{
		ID:      "large-response",
		Type:    protocol.MsgResponse,
		Payload: json.RawMessage(`{"cmd":"page.screenshot","data":"` + strings.Repeat("x", 6*1024*1024) + `"}`),
	}
	var browserFrame bytes.Buffer
	data, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if err := protocol.WriteFrameN(&browserFrame, data, 64*1024*1024); err != nil {
		t.Fatal(err)
	}

	var daemonFrame bytes.Buffer
	relayBrowserToDaemon(&browserFrame, &daemonFrame, t.TempDir())
	forwarded, err := protocol.ReadEnvelope(&daemonFrame)
	if err != nil {
		t.Fatalf("large response was not forwarded: %v", err)
	}
	var ref struct {
		Offload string `json:"_offload"`
	}
	if err := json.Unmarshal(forwarded.Payload, &ref); err != nil || ref.Offload == "" {
		t.Fatalf("large response was not offloaded: %v", err)
	}
	content, err := os.ReadFile(ref.Offload)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(content, response.Payload) {
		t.Fatal("offloaded payload differs from browser response")
	}
}

func TestRelayBothClosesConnectionAfterOversizedFrame(t *testing.T) {
	browserIn, browserWriter := io.Pipe()
	shimConn, daemonConn := net.Pipe()
	defer daemonConn.Close()
	offloadDir := t.TempDir()

	done := make(chan struct{})
	go func() {
		relayBoth(browserIn, io.Discard, shimConn, offloadDir)
		close(done)
	}()

	if err := binary.Write(browserWriter, binary.LittleEndian, uint32(64*1024*1024+1)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("relay remained connected after browser input failed")
	}
	var one [1]byte
	if _, err := daemonConn.Read(one[:]); err == nil {
		t.Fatal("daemon connection remained open")
	}
	_ = browserWriter.Close()
}
