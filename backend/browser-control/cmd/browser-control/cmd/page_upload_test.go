package cmd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPageUploadSendsChunksThenSetsFiles(t *testing.T) {
	dir := t.TempDir()
	content := bytes.Repeat([]byte("0123456789"), 70_000) // 700 KB: two chunks
	path := filepath.Join(dir, "report.json")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	setCommandFlags(t, pageUploadCmd, map[string]string{"file": path, "text": "Attach"})
	var stdout bytes.Buffer
	pageUploadCmd.SetOut(&stdout)
	t.Cleanup(func() { pageUploadCmd.SetOut(nil) })
	result := startPageCommandDaemon(t, map[string]json.RawMessage{
		"page.upload.chunk": json.RawMessage(`{"data":{}}`),
		"page.upload":       json.RawMessage(`{"data":{"matched":{"tag":"input","id":"attach"},"navigated":false}}`),
	})
	if err := pageUploadCmd.RunE(pageUploadCmd, []string{"12"}); err != nil {
		t.Fatal(err)
	}
	requests := waitPageCommandRequests(t, result)

	var joined strings.Builder
	uploadIDs := map[string]bool{}
	chunks := 0
	for _, request := range requests {
		if request.Cmd != "page.upload.chunk" {
			continue
		}
		var args struct {
			UploadID string `json:"uploadId"`
			Data     string `json:"data"`
		}
		if err := json.Unmarshal(request.Args, &args); err != nil {
			t.Fatal(err)
		}
		chunks++
		uploadIDs[args.UploadID] = true
		joined.WriteString(args.Data)
	}
	if chunks != 2 || len(uploadIDs) != 1 || joined.String() != base64.StdEncoding.EncodeToString(content) {
		t.Fatalf("chunks = %d, upload IDs = %v, joined matches = %v", chunks, uploadIDs, joined.String() == base64.StdEncoding.EncodeToString(content))
	}
	var uploadID string
	for id := range uploadIDs {
		uploadID = id
	}
	got := lastRequestArgs(t, requests, "page.upload")
	want := map[string]any{
		"tabId": 12.0, "text": "Attach", "wait": "load", "timeoutMs": 30000.0, "snapshot": "diff",
		"files": []any{map[string]any{"name": "report.json", "type": "application/json", "uploadId": uploadID}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
	if strings.TrimSpace(stdout.String()) != "uploaded report.json to <input#attach>" {
		t.Fatalf("output = %q", stdout.String())
	}
}

func TestPageUploadRequiresFile(t *testing.T) {
	err := pageUploadCmd.RunE(pageUploadCmd, []string{"12"})
	if err == nil || !strings.Contains(err.Error(), "--file") {
		t.Fatalf("err = %v", err)
	}
}
