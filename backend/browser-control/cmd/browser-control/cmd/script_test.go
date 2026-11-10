package cmd

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/protocol"
)

func TestParseScriptNameUsesMetadataBlock(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name, code, want string
	}{
		{"忽略头部之前的名称注释", "// @name License note\n// ==UserScript==\n// @name Actual Script\n// ==/UserScript==\n", "Actual Script"},
		{"忽略元数据之后的名称注释", "// ==UserScript==\n// @namespace test\n// ==/UserScript==\n// @name Body note\n", ""},
		{"没有完整头部时不提取名称", "// ==UserScript==\n// @name Incomplete Script\n", ""},
		{"空名称不读取下一行", "// ==UserScript==\n// @name   \n// @namespace test\n// ==/UserScript==\n", ""},
		{"支持缩进和CRLF元数据", "\t// ==UserScript==\r\n\t//\t@name\t 中文 Script \r\n\t// ==/UserScript==\r\n", "中文 Script"},
		{"保留普通名称", "// ==UserScript==\n// @name Actual Script\n// ==/UserScript==\n", "Actual Script"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := parseScriptName([]byte(test.code)); got != test.want {
				t.Fatalf("parseScriptName() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestArchiveScriptUsesMetadataName(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BROWSER_CONTROL_SCRIPTS_DIR", dir)
	code := []byte("// @name License note\n// ==UserScript==\n// @name Actual Script\n// @namespace test\n// @version 1.0.0\n// ==/UserScript==\n")
	archiveScript(code)
	path := filepath.Join(dir, "actual-script.user.js")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(code) {
		t.Fatal("archived source differs from original")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(path) {
		t.Fatalf("archive entries = %v", entries)
	}
}

func TestScriptWatchProcess(t *testing.T) {
	if os.Getenv("BROWSER_CONTROL_WATCH_TEST_PROCESS") != "1" {
		return
	}
	flagBrowser = "synthetic-target"
	scriptWatchCmd.SetContext(context.Background())
	if err := scriptWatchCmd.Flags().Set("debounce", "1"); err != nil {
		t.Fatal(err)
	}
	if err := scriptWatchCmd.RunE(scriptWatchCmd, []string{os.Getenv("BROWSER_CONTROL_WATCH_TEST_DIR")}); err != nil {
		t.Fatal(err)
	}
}

func TestScriptWatchPushesFinalEdit(t *testing.T) {
	state, err := os.MkdirTemp("/tmp", "watch-qa-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(state) })
	t.Setenv("XDG_STATE_HOME", state)
	if err := os.MkdirAll(protocol.StateDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", protocol.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	type pushedScript struct{ target, code string }
	pushes := make(chan pushedScript, 16)
	failures := make(chan error, 16)
	firstResponse := make(chan struct{})
	releaseFirst := sync.OnceFunc(func() { close(firstResponse) })
	defer releaseFirst()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
				if _, err := protocol.ReadFrame(conn); err != nil {
					failures <- err
					return
				}
				if err := protocol.WriteJSON(conn, &protocol.HandshakeAck{Type: protocol.MsgHandshakeAck, ConnID: "cli-qa", Peers: []string{"synthetic-other", "synthetic-target"}}); err != nil {
					failures <- err
					return
				}
				env, err := protocol.ReadEnvelope(conn)
				if err != nil {
					failures <- err
					return
				}
				var request struct {
					Cmd  string `json:"cmd"`
					Args struct {
						Code string `json:"code"`
					} `json:"args"`
				}
				if err := json.Unmarshal(env.Payload, &request); err != nil {
					failures <- err
					return
				}
				if request.Cmd != "script.push" {
					failures <- fmt.Errorf("unexpected command %q", request.Cmd)
					return
				}
				pushes <- pushedScript{target: env.Target, code: request.Args.Code}
				if strings.HasSuffix(request.Args.Code, "revision1") {
					<-firstResponse
				}
				if err := protocol.WriteEnvelope(conn, &protocol.Envelope{ID: env.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(`{"data":{"uuid":"qa-script","isNew":false}}`)}); err != nil {
					failures <- err
				}
			}()
		}
	}()
	dir := t.TempDir()
	path := filepath.Join(dir, "qa.user.js")
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestScriptWatchProcess$")
	child.Env = append(os.Environ(), "BROWSER_CONTROL_WATCH_TEST_PROCESS=1", "BROWSER_CONTROL_WATCH_TEST_DIR="+dir)
	stderr, err := child.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = child.Wait() }()
	ready := make(chan struct{})
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "Watching for changes in:") {
				close(ready)
				break
			}
		}
		for scanner.Scan() {
		}
	}()
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal("watcher not ready")
	}
	write := func(revision string) {
		t.Helper()
		if err := os.WriteFile(path, []byte("// ==UserScript==\n// @name QA\n// ==/UserScript==\n"+revision), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	waitRevision := func(revision string, wait time.Duration) {
		t.Helper()
		timer := time.NewTimer(wait)
		defer timer.Stop()
		for {
			select {
			case push := <-pushes:
				if push.target != "synthetic-target" {
					t.Fatalf("push target = %q", push.target)
				}
				if strings.HasSuffix(push.code, revision) {
					return
				}
			case err := <-failures:
				t.Fatal(err)
			case <-timer.C:
				t.Fatalf("revision %q was never pushed", revision)
			}
		}
	}
	write("revision1")
	waitRevision("revision1", 2*time.Second)
	write("revision2")
	write("revision3")
	if err := os.WriteFile(filepath.Join(dir, "other.user.js"), []byte("revision-other"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case push := <-pushes:
		t.Fatalf("overlapping push while first request is pending: %+v", push)
	case err := <-failures:
		t.Fatal(err)
	case <-time.After(1100 * time.Millisecond):
	}
	releaseFirst()
	wanted := map[string]bool{"revision3": true, "revision-other": true}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for len(wanted) > 0 {
		select {
		case push := <-pushes:
			if push.target != "synthetic-target" {
				t.Fatalf("push target = %q", push.target)
			}
			for revision := range wanted {
				if strings.HasSuffix(push.code, revision) {
					delete(wanted, revision)
				}
			}
		case err := <-failures:
			t.Fatal(err)
		case <-timer.C:
			t.Fatalf("final edits were never pushed: %v", wanted)
		}
	}
}

func TestScriptPushAllRequiresExplicitPath(t *testing.T) {
	t.Parallel()

	err := scriptPushAllCmd.Args(scriptPushAllCmd, nil)
	if err == nil {
		t.Fatal("expected missing path arg to fail")
	}
	if !strings.Contains(err.Error(), "accepts 1 arg(s), received 0") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestParsePushResponse(t *testing.T) {
	t.Parallel()

	resp, err := parsePushResponse([]byte(`{"data":{"uuid":"abc-123","isNew":true,"errors":["warn"]}}`))
	if err != nil {
		t.Fatalf("parsePushResponse returned error: %v", err)
	}
	if resp.Data.UUID != "abc-123" {
		t.Fatalf("expected uuid abc-123, got %s", resp.Data.UUID)
	}
	if !resp.Data.IsNew {
		t.Fatal("expected isNew to be true")
	}
	if len(resp.Data.Errors) != 1 {
		t.Fatalf("expected 1 error, got %d", len(resp.Data.Errors))
	}
}

func TestCollectPushStatsCountsCreatedAndUpdated(t *testing.T) {
	t.Parallel()

	stats := collectPushStats([]pushResult{
		{Success: true, IsNew: true},
		{Success: true, IsNew: false},
		{Success: true, IsNew: false},
		{Success: false},
	})
	if stats.Created != 1 {
		t.Fatalf("expected 1 created result, got %d", stats.Created)
	}
	if stats.Updated != 2 {
		t.Fatalf("expected 2 updated results, got %d", stats.Updated)
	}
	if stats.Completed != 3 {
		t.Fatalf("expected 3 completed results, got %d", stats.Completed)
	}
	if stats.Failed != 1 {
		t.Fatalf("expected 1 failed result, got %d", stats.Failed)
	}
}

func TestScriptPushReloadTabs(t *testing.T) {
	file := filepath.Join(t.TempDir(), "x.user.js")
	if err := os.WriteFile(file, []byte("// ==UserScript==\n// @name x\n// ==/UserScript==\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	setCommandFlags(t, scriptPushCmd, map[string]string{"no-save": "true", "reload-tabs": "true", "timeout": "10s"})
	result := startPageCommandDaemon(t, map[string]json.RawMessage{
		"script.push": json.RawMessage(`{"cmd":"script.push","data":{"uuid":"u1","isNew":false,"reloadedTabs":[101]}}`),
	})
	if err := scriptPushCmd.RunE(scriptPushCmd, []string{file}); err != nil {
		t.Fatal(err)
	}
	args := lastRequestArgs(t, waitPageCommandRequests(t, result), "script.push")
	delete(args, "code")
	want := map[string]any{"enabled": true, "reloadTabs": true, "wait": "load", "timeoutMs": 10000.0}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %#v, want %#v", args, want)
	}
}
