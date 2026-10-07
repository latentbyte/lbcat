package cmd

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
	"github.com/spf13/cobra"
)

type fakeRequestClient struct {
	responses map[string]json.RawMessage
	calls     []string
}

func (f *fakeRequestClient) Request(_ string, payload any) (json.RawMessage, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var cmd struct {
		Cmd string `json:"cmd"`
	}
	if err := json.Unmarshal(data, &cmd); err != nil {
		return nil, err
	}
	f.calls = append(f.calls, cmd.Cmd)
	resp, ok := f.responses[cmd.Cmd]
	if !ok {
		return nil, errors.New("unexpected command: " + cmd.Cmd)
	}
	return resp, nil
}

func TestParseExtensionError(t *testing.T) {
	t.Parallel()

	extErr, ok := parseExtensionError(json.RawMessage(`{"cmd":"error","error":{"code":"HANDLER_ERROR","message":"Missing activeTab permission"}}`))
	if !ok {
		t.Fatal("parseExtensionError() ok = false, want true")
	}
	if extErr.Code != "HANDLER_ERROR" || extErr.Message != "Missing activeTab permission" {
		t.Fatalf("parseExtensionError() = %#v", extErr)
	}
}

func TestShouldFocusForCallerCapture(t *testing.T) {
	t.Parallel()

	if !shouldFocusForCallerCapture(extensionError{Code: "HANDLER_ERROR", Message: "Missing activeTab permission"}) {
		t.Fatal("shouldFocusForCallerCapture(activeTab) = false")
	}
	if shouldFocusForCallerCapture(extensionError{Code: "HANDLER_ERROR", Message: "element not found: #app"}) {
		t.Fatal("shouldFocusForCallerCapture(element not found) = true")
	}
}

func TestFocusTabForCallerCaptureVerifiesActiveTab(t *testing.T) {
	t.Parallel()

	client := &fakeRequestClient{responses: map[string]json.RawMessage{
		"tabs.focus": json.RawMessage(`{"data":{"tabId":123,"windowId":7}}`),
		"tabs.get":   json.RawMessage(`{"data":{"id":123,"windowId":7,"active":true}}`),
	}}

	got, err := focusTabForCallerCapture(client, "zen-01", 123)
	if err != nil {
		t.Fatalf("focusTabForCallerCapture() error = %v", err)
	}
	want := focusedTab{TabID: 123, WindowID: 7}
	if got != want {
		t.Fatalf("focusTabForCallerCapture() = %#v, want %#v", got, want)
	}
	if !reflect.DeepEqual(client.calls, []string{"tabs.focus", "tabs.get"}) {
		t.Fatalf("calls = %#v", client.calls)
	}
}

func TestFocusTabForCallerCaptureRejectsInactiveTab(t *testing.T) {
	t.Parallel()

	client := &fakeRequestClient{responses: map[string]json.RawMessage{
		"tabs.focus": json.RawMessage(`{"data":{"tabId":123,"windowId":7}}`),
		"tabs.get":   json.RawMessage(`{"data":{"id":123,"windowId":7,"active":false}}`),
	}}

	_, err := focusTabForCallerCapture(client, "zen-01", 123)
	if err == nil || !strings.Contains(err.Error(), "not active") {
		t.Fatalf("focusTabForCallerCapture() error = %v, want not active", err)
	}
}

func TestHandleScreenshotExtensionErrorFocusesForActiveTabFailure(t *testing.T) {
	t.Parallel()

	client := &fakeRequestClient{responses: map[string]json.RawMessage{
		"tabs.focus": json.RawMessage(`{"data":{"tabId":123,"windowId":7}}`),
		"tabs.get":   json.RawMessage(`{"data":{"id":123,"windowId":7,"active":true}}`),
	}}

	err := handleScreenshotExtensionError(client, "zen-01", 123, extensionError{Code: "HANDLER_ERROR", Message: "Missing activeTab permission"})
	if err == nil {
		t.Fatal("handleScreenshotExtensionError() error = nil")
	}
	msg := err.Error()
	if !strings.Contains(msg, "focused tab 123 in window 7") || !strings.Contains(msg, "caller may run OS-level capture") {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(client.calls, []string{"tabs.focus", "tabs.get"}) {
		t.Fatalf("calls = %#v", client.calls)
	}
}

type pageCommandRequest struct {
	Cmd  string          `json:"cmd"`
	Args json.RawMessage `json:"args"`
}

type pageCommandResult struct {
	requests []pageCommandRequest
	err      error
}

func startPageCommandDaemon(t *testing.T, responses map[string]json.RawMessage) <-chan pageCommandResult {
	t.Helper()
	stateHome, err := os.MkdirTemp("/tmp", "bc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(stateHome) })
	t.Setenv("XDG_STATE_HOME", stateHome)
	if err := os.MkdirAll(protocol.StateDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", protocol.SocketPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	result := make(chan pageCommandResult, 1)
	go func() {
		var got pageCommandResult
		defer func() { result <- got }()
		conn, err := listener.Accept()
		if err != nil {
			got.err = err
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := protocol.ReadFrame(conn); err != nil {
			got.err = err
			return
		}
		if err := protocol.WriteJSON(conn, &protocol.HandshakeAck{Type: protocol.MsgHandshakeAck, ConnID: "cli-01", Peers: []string{"zen-01"}}); err != nil {
			got.err = err
			return
		}
		for {
			env, err := protocol.ReadEnvelope(conn)
			if err != nil {
				return
			}
			var request pageCommandRequest
			if err := json.Unmarshal(env.Payload, &request); err != nil {
				got.err = err
				return
			}
			got.requests = append(got.requests, request)
			payload, ok := responses[request.Cmd]
			if !ok {
				got.err = errors.New("unexpected command: " + request.Cmd)
				return
			}
			if payload == nil {
				continue
			}
			if err := protocol.WriteEnvelope(conn, &protocol.Envelope{ID: env.ID, Type: protocol.MsgResponse, Payload: payload}); err != nil {
				got.err = err
				return
			}
		}
	}()
	return result
}

func waitPageCommandRequests(t *testing.T, result <-chan pageCommandResult) []pageCommandRequest {
	t.Helper()
	select {
	case got := <-result:
		if got.err != nil {
			t.Fatal(got.err)
		}
		return got.requests
	case <-time.After(time.Second):
		t.Fatal("mock daemon did not finish")
		return nil
	}
}

func TestScreenshotCommandFocusRecovery(t *testing.T) {
	for _, test := range []struct {
		name    string
		focus   bool
		timeout bool
	}{
		{name: "截图失败默认不切换标签焦点"},
		{name: "显式开启焦点恢复时保留调用方捕获流程", focus: true},
		{name: "截图请求遵循调用方设置的超时", timeout: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.focus {
				if err := pageScreenshotCmd.Flags().Set("focus-on-error", "true"); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = pageScreenshotCmd.Flags().Set("focus-on-error", "false") })
			}
			if test.timeout {
				if err := pageScreenshotCmd.Flags().Set("timeout", "20ms"); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = pageScreenshotCmd.Flags().Set("timeout", "2m") })
			}
			responses := map[string]json.RawMessage{
				"page.screenshot": json.RawMessage(`{"cmd":"error","error":{"code":"HANDLER_ERROR","message":"Missing activeTab permission"}}`),
				"tabs.focus":      json.RawMessage(`{"data":{"tabId":123,"windowId":7}}`),
				"tabs.get":        json.RawMessage(`{"data":{"id":123,"windowId":7,"active":true}}`),
			}
			if test.timeout {
				responses["page.screenshot"] = nil
			}
			result := startPageCommandDaemon(t, responses)
			err := pageScreenshotCmd.RunE(pageScreenshotCmd, []string{"123"})
			wantError := "Missing activeTab permission"
			if test.timeout {
				wantError = "timed out after 20ms"
			}
			if err == nil || !strings.Contains(err.Error(), wantError) {
				t.Fatalf("screenshot error = %v", err)
			}
			want := []string{"page.screenshot"}
			if test.focus {
				want = append(want, "tabs.focus", "tabs.get")
				if !strings.Contains(err.Error(), "focused tab 123 in window 7") {
					t.Fatalf("focus recovery missing: %v", err)
				}
			}
			var got []string
			for _, request := range waitPageCommandRequests(t, result) {
				got = append(got, request.Cmd)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("commands = %v, want %v", got, want)
			}
		})
	}
}

func TestPageCommandsReturnExtensionErrors(t *testing.T) {
	for _, test := range []struct {
		name    string
		command *cobra.Command
		args    []string
	}{
		{name: "page.content", command: pageContentCmd, args: []string{"123"}},
		{name: "page.exec", command: pageExecCmd, args: []string{"123", "1 + 1"}},
		{name: "page.reload", command: pageReloadCmd, args: []string{"123"}},
	} {
		for _, jsonOutput := range []bool{false, true} {
			name := test.name + map[bool]string{false: "/普通输出返回扩展错误", true: "/JSON输出返回扩展错误"}[jsonOutput]
			t.Run(name, func(t *testing.T) {
				previousJSON := flagJSON
				flagJSON = jsonOutput
				t.Cleanup(func() { flagJSON = previousJSON })
				result := startPageCommandDaemon(t, map[string]json.RawMessage{
					test.name: json.RawMessage(`{"cmd":"error","error":{"code":"HANDLER_ERROR","message":"tab unavailable"}}`),
				})
				err := test.command.RunE(test.command, test.args)
				requests := waitPageCommandRequests(t, result)
				if len(requests) != 1 || requests[0].Cmd != test.name {
					t.Fatalf("requests = %+v", requests)
				}
				if err == nil || !strings.Contains(err.Error(), "HANDLER_ERROR: tab unavailable") {
					t.Errorf("command error = %v, want browser failure", err)
				}
				if test.name == "page.exec" {
					var args struct {
						World string `json:"world"`
					}
					if err := json.Unmarshal(requests[0].Args, &args); err != nil {
						t.Fatal(err)
					}
					if args.World != "MAIN" {
						t.Errorf("default execution world = %q, want MAIN", args.World)
					}
				}
			})
		}
	}
}
