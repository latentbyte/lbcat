package cmd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/protocol"
	"github.com/spf13/cobra"
)

func TestScreenshotFileUsesBitmapPixelLimit(t *testing.T) {
	for _, test := range []struct {
		name, format                              string
		width, height, cssWidth, cssHeight, limit int
	}{
		{"一倍像素密度未超限保留原图", "png", 200, 100, 200, 100, 30000},
		{"二倍像素密度按位图缩放PNG", "png", 400, 200, 200, 100, 30000},
		{"二倍像素密度按位图缩放JPEG", "jpeg", 400, 200, 200, 100, 30000},
		{"CSS尺寸超限时仍按位图比例缩放", "png", 400, 200, 200, 100, 10000},
		{"禁用限制时保留设备像素", "png", 400, 200, 200, 100, 0},
		{"极窄图片缩放后至少保留一像素", "png", 1, 1000, 1, 1000, 10},
	} {
		t.Run(test.name, func(t *testing.T) {
			var source bytes.Buffer
			bitmap := image.NewRGBA(image.Rect(0, 0, test.width, test.height))
			var err error
			if test.format == "jpeg" {
				err = jpeg.Encode(&source, bitmap, nil)
			} else {
				err = png.Encode(&source, bitmap)
			}
			if err != nil {
				t.Fatal(err)
			}
			output := filepath.Join(t.TempDir(), "screenshot."+test.format)
			for name, value := range map[string]string{"output": output, "format": test.format, "max-pixels": strconv.Itoa(test.limit)} {
				flag := pageScreenshotCmd.Flags().Lookup(name)
				previous := flag.Value.String()
				if err := flag.Value.Set(value); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = flag.Value.Set(previous) })
			}
			response, err := json.Marshal(map[string]any{"data": map[string]any{
				"dataUrl": "data:image/" + test.format + ";base64," + base64.StdEncoding.EncodeToString(source.Bytes()),
				"width":   test.cssWidth, "height": test.cssHeight,
			}})
			if err != nil {
				t.Fatal(err)
			}
			result := startPageCommandDaemon(t, map[string]json.RawMessage{"page.screenshot": response})
			if err := pageScreenshotCmd.RunE(pageScreenshotCmd, []string{"123"}); err != nil {
				t.Fatal(err)
			}
			waitPageCommandRequests(t, result)
			data, err := os.ReadFile(output)
			if err != nil {
				t.Fatal(err)
			}
			config, _, err := image.DecodeConfig(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if test.limit > 0 && config.Width*config.Height > test.limit {
				t.Fatalf("bitmap = %dx%d, exceeds %d pixels", config.Width, config.Height, test.limit)
			}
			if (test.limit == 0 || test.width*test.height <= test.limit) && !bytes.Equal(data, source.Bytes()) {
				t.Fatal("image below limit was re-encoded")
			}
			if config.Width < 1 || config.Height < 1 {
				t.Fatal("empty image")
			}
		})
	}
}

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
			if request.Cmd == "agentWindow.status" && !ok {
				payload = json.RawMessage(`{"cmd":"agentWindow.status","data":{"windowId":7,"markerTabId":8}}`)
				ok = true
			}
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
				if err := pageScreenshotCmd.Flags().Set("foreground", "true"); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = pageScreenshotCmd.Flags().Set("foreground", "false") })
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
			want := []string{"agentWindow.status", "page.screenshot"}
			if test.focus {
				want = append(want, "agentWindow.status", "tabs.focus", "agentWindow.status", "tabs.get")
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
				if len(requests) != 2 || requests[0].Cmd != "agentWindow.status" || requests[1].Cmd != test.name {
					t.Fatalf("requests = %+v", requests)
				}
				if err == nil || !strings.Contains(err.Error(), "HANDLER_ERROR: tab unavailable") {
					t.Errorf("command error = %v, want browser failure", err)
				}
				if test.name == "page.exec" {
					var args struct {
						World string `json:"world"`
					}
					if err := json.Unmarshal(requests[1].Args, &args); err != nil {
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

func TestScreenshotJSONWithOutputSavesFile(t *testing.T) {
	var source bytes.Buffer
	if err := png.Encode(&source, image.NewRGBA(image.Rect(0, 0, 20, 10))); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(t.TempDir(), "shot.png")
	flag := pageScreenshotCmd.Flags().Lookup("output")
	if err := flag.Value.Set(output); err != nil {
		t.Fatal(err)
	}
	previousJSON := flagJSON
	flagJSON = true
	var stdout bytes.Buffer
	pageScreenshotCmd.SetOut(&stdout)
	t.Cleanup(func() {
		_ = flag.Value.Set("")
		flagJSON = previousJSON
		pageScreenshotCmd.SetOut(nil)
	})
	response, err := json.Marshal(map[string]any{"data": map[string]any{
		"dataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString(source.Bytes()),
		"width":   20, "height": 10,
	}})
	if err != nil {
		t.Fatal(err)
	}
	result := startPageCommandDaemon(t, map[string]json.RawMessage{"page.screenshot": response})
	if err := pageScreenshotCmd.RunE(pageScreenshotCmd, []string{"123"}); err != nil {
		t.Fatal(err)
	}
	requests := waitPageCommandRequests(t, result)
	var args struct {
		TimeoutMs int `json:"timeoutMs"`
	}
	if err := json.Unmarshal(requests[len(requests)-1].Args, &args); err != nil || args.TimeoutMs != 115_000 {
		t.Fatalf("screenshot should send its timeout so the extension gives up first: %+v %v", args, err)
	}
	if data, err := os.ReadFile(output); err != nil || !bytes.Equal(data, source.Bytes()) {
		t.Fatalf("screenshot not saved: %v", err)
	}
	var decoded struct {
		Cmd  string `json:"cmd"`
		Data struct {
			Path          string `json:"path"`
			Width, Height int
			Bytes         int `json:"bytes"`
		} `json:"data"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &decoded); err != nil {
		t.Fatalf("output = %q: %v", stdout.String(), err)
	}
	if decoded.Cmd != "page.screenshot" || decoded.Data.Path != output || decoded.Data.Width != 20 || decoded.Data.Bytes != source.Len() || strings.Contains(stdout.String(), "base64") {
		t.Fatalf("output = %s", stdout.String())
	}
}

func TestScreenshotRegionReportsCSSSize(t *testing.T) {
	var source bytes.Buffer
	if err := png.Encode(&source, image.NewRGBA(image.Rect(0, 0, 600, 80))); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(t.TempDir(), "region.png")
	setCommandFlags(t, pageScreenshotCmd, map[string]string{"region": "10,20,300,40", "output": output})
	var stdout bytes.Buffer
	pageScreenshotCmd.SetOut(&stdout)
	t.Cleanup(func() { pageScreenshotCmd.SetOut(nil) })
	response, err := json.Marshal(map[string]any{"data": map[string]any{
		"dataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString(source.Bytes()), "width": 300, "height": 40,
	}})
	if err != nil {
		t.Fatal(err)
	}
	result := startPageCommandDaemon(t, map[string]json.RawMessage{"page.screenshot": response})
	if err := pageScreenshotCmd.RunE(pageScreenshotCmd, []string{"123"}); err != nil {
		t.Fatal(err)
	}
	args := lastRequestArgs(t, waitPageCommandRequests(t, result), "page.screenshot")
	if want := map[string]any{"x": 10.0, "y": 20.0, "width": 300.0, "height": 40.0}; !reflect.DeepEqual(args["region"], want) {
		t.Fatalf("region = %v, want %v", args["region"], want)
	}
	if want := "screenshot saved to " + output + " (600x80 bitmap pixels, 300x40 CSS pixels)"; strings.TrimSpace(stdout.String()) != want {
		t.Fatalf("output = %q, want %q", stdout.String(), want)
	}
}

func TestScreenshotRegionArgumentErrors(t *testing.T) {
	for _, test := range []struct {
		name  string
		flags map[string]string
		want  string
	}{
		{"区域与选择器同时给出", map[string]string{"region": "0,0,10,10", "selector": "#a"}, "--region cannot be combined"},
		{"区域与整页同时给出", map[string]string{"region": "0,0,10,10", "full-page": "true"}, "--region cannot be combined"},
		{"区域格式错误", map[string]string{"region": "0,0,10"}, "--region must be x,y,width,height"},
		{"区域尺寸为零", map[string]string{"region": "0,0,0,10"}, "--region must be x,y,width,height"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setCommandFlags(t, pageScreenshotCmd, test.flags)
			err := pageScreenshotCmd.RunE(pageScreenshotCmd, []string{"123"})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("err = %v, want %q", err, test.want)
			}
		})
	}
}
