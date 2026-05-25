package cmd

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
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
