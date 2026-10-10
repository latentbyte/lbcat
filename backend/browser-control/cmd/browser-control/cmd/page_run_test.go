package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeSteps(t *testing.T, steps string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "steps.json")
	if err := os.WriteFile(path, []byte(steps), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func runPageSteps(t *testing.T, steps string, responses map[string]json.RawMessage) ([]pageCommandRequest, string, error) {
	t.Helper()
	setCommandFlags(t, pageRunCmd, map[string]string{"file": writeSteps(t, steps)})
	var stdout bytes.Buffer
	pageRunCmd.SetOut(&stdout)
	t.Cleanup(func() { pageRunCmd.SetOut(nil) })
	result := startPageCommandDaemon(t, responses)
	err := pageRunCmd.RunE(pageRunCmd, []string{"12"})
	return waitPageCommandRequests(t, result), stdout.String(), err
}

func TestPageRunExecutesStepsInOrder(t *testing.T) {
	requests, output, err := runPageSteps(t, `[
		{"action": "goto", "url": "https://a.test/login"},
		{"action": "fill", "ref": "@e2", "value": "a@b.c"},
		{"action": "click", "text": "Sign in", "timeout": "5s"},
		{"action": "content", "selector": "main", "format": "markdown"}
	]`, map[string]json.RawMessage{
		"page.goto":    json.RawMessage(`{"data":{"tabId":12,"navigated":true,"url":"https://a.test/login","title":"Login"}}`),
		"page.fill":    json.RawMessage(`{"data":{"matched":{"tag":"input","id":"email"},"navigated":false,"url":"https://a.test/login"}}`),
		"page.click":   json.RawMessage(`{"data":{"matched":{"tag":"button","text":"Sign in"},"navigated":true,"url":"https://a.test/home"}}`),
		"page.content": json.RawMessage(`{"data":"# Home"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	var cmds []string
	for _, request := range requests {
		if request.Cmd != "agentWindow.status" {
			cmds = append(cmds, request.Cmd)
		}
	}
	if want := []string{"page.goto", "page.fill", "page.click", "page.content"}; !reflect.DeepEqual(cmds, want) {
		t.Fatalf("cmds = %v, want %v", cmds, want)
	}
	for cmd, want := range map[string]map[string]any{
		"page.goto":    {"tabId": 12.0, "url": "https://a.test/login", "wait": "load", "timeoutMs": 30000.0},
		"page.fill":    {"tabId": 12.0, "ref": "e2", "value": "a@b.c", "wait": "load", "timeoutMs": 30000.0},
		"page.click":   {"tabId": 12.0, "text": "Sign in", "wait": "load", "timeoutMs": 5000.0},
		"page.content": {"tabId": 12.0, "selector": "main", "format": "markdown"},
	} {
		if got := lastRequestArgs(t, requests, cmd); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s args = %v, want %v", cmd, got, want)
		}
	}
	want := "[1/4] goto: https://a.test/login\n" +
		"[2/4] fill: <input#email>\n" +
		"[3/4] click: <button> \"Sign in\"; navigated to https://a.test/home\n" +
		"[4/4] content:\n# Home\n"
	if output != want {
		t.Fatalf("output = %q, want %q", output, want)
	}
}

func TestPageRunStopsAtFirstError(t *testing.T) {
	requests, output, err := runPageSteps(t, `[
		{"action": "click", "selector": "#missing", "wait": "none"},
		{"action": "content"}
	]`, map[string]json.RawMessage{
		"page.click": json.RawMessage(`{"cmd":"error","error":{"code":"SELECTOR_NOT_FOUND","message":"no element matches selector: #missing"}}`),
	})
	if err == nil || !strings.Contains(err.Error(), "step 1/2 (click): SELECTOR_NOT_FOUND") {
		t.Fatalf("err = %v", err)
	}
	for _, request := range requests {
		if request.Cmd == "page.content" {
			t.Fatal("ran a step after the failure")
		}
	}
	if output != "" {
		t.Fatalf("output = %q", output)
	}
}

func TestPageRunValidatesBeforeRunning(t *testing.T) {
	for _, test := range []struct{ steps, want string }{
		{`[{"action": "hover"}]`, `step 1: unknown action "hover"`},
		{`[{"action": "goto", "url": "x", "timeout": "soon"}]`, `step 1: invalid timeout`},
		{`{"action": "goto"}`, "steps must be a JSON array"},
		{`[]`, "no steps"},
	} {
		setCommandFlags(t, pageRunCmd, map[string]string{"file": writeSteps(t, test.steps)})
		err := pageRunCmd.RunE(pageRunCmd, []string{"12"})
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Fatalf("steps %s: err = %v, want %q", test.steps, err, test.want)
		}
	}
}

func TestPageRunJSONReportsFailedStep(t *testing.T) {
	flagJSON = true
	t.Cleanup(func() { flagJSON = false })
	_, output, err := runPageSteps(t, `[{"action": "goto", "url": "https://a.test/"}, {"action": "fetch", "url": "/api"}]`,
		map[string]json.RawMessage{
			"page.goto":  json.RawMessage(`{"data":{"url":"https://a.test/"}}`),
			"page.fetch": json.RawMessage(`{"data":{"status":404,"ok":false,"body":"missing"}}`),
		})
	if err == nil {
		t.Fatal("expected HTTP failure")
	}
	var report struct {
		Steps  []map[string]any `json:"steps"`
		Failed map[string]any   `json:"failed"`
	}
	if err := json.Unmarshal([]byte(output), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Steps) != 2 || report.Failed["step"] != 2.0 || report.Failed["action"] != "fetch" {
		t.Fatalf("report = %s", output)
	}
}
