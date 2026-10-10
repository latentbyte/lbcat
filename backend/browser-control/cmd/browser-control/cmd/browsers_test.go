package cmd

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestBrowsersJSONUsesEnvelope(t *testing.T) {
	previousJSON := flagJSON
	flagJSON = true
	var stdout bytes.Buffer
	browsersCmd.SetOut(&stdout)
	t.Cleanup(func() {
		flagJSON = previousJSON
		browsersCmd.SetOut(nil)
	})
	result := startPageCommandDaemon(t, nil)
	if err := browsersCmd.RunE(browsersCmd, nil); err != nil {
		t.Fatal(err)
	}
	waitPageCommandRequests(t, result)
	var decoded struct {
		Cmd  string   `json:"cmd"`
		Data []string `json:"data"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &decoded); err != nil {
		t.Fatalf("output = %q: %v", stdout.String(), err)
	}
	if decoded.Cmd != "browsers" || len(decoded.Data) != 1 || decoded.Data[0] != "zen-01" {
		t.Fatalf("output = %s", stdout.String())
	}
}
