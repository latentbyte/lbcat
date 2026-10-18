package cmd

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

// stubAerospace replaces the aerospace CLI with canned list-windows output and records every call
func stubAerospace(t *testing.T, windows string, missing bool) *[][]string {
	t.Helper()
	var calls [][]string
	previous := aerospaceCommand
	aerospaceCommand = func(args ...string) ([]byte, error) {
		if missing {
			return nil, exec.ErrNotFound
		}
		calls = append(calls, args)
		if args[0] == "list-windows" {
			return []byte(windows), nil
		}
		return nil, nil
	}
	t.Cleanup(func() { aerospaceCommand = previous })
	return &calls
}

func countRequests(requests []pageCommandRequest, cmd string) int {
	count := 0
	for _, request := range requests {
		if request.Cmd == cmd {
			count++
		}
	}
	return count
}

func TestPageViewportWindowManager(t *testing.T) {
	windowResp := json.RawMessage(`{"data":{"tabId":12,"windowId":7,"width":500,"height":844,"exact":false,` +
		`"scope":"window","titleMarker":"[bctl 7] "}}`)
	listing := "136|h_tiles|Your watch history\n1012|h_tiles|[bctl 7] Example Domain\n"
	listArgs := []string{"list-windows", "--all", "--format", "%{window-id}|%{window-layout}|%{window-title}"}
	for _, test := range []struct {
		name     string
		flags    map[string]string
		resp     json.RawMessage
		windows  string
		missing  bool
		calls    [][]string
		requests int
		output   string
	}{
		{"平铺的代理窗口先浮动再重新调整尺寸", map[string]string{"width": "390", "height": "844"}, windowResp, listing, false,
			[][]string{listArgs, {"layout", "--window-id", "1012", "floating"}}, 2,
			"viewport 500x844 (requested 390x844; the browser or screen clamps the window size)"},
		{"已浮动的窗口不重复调整", map[string]string{"width": "390"}, windowResp,
			"1012|floating|[bctl 7] Example Domain\n", false, [][]string{listArgs}, 1,
			"viewport 500x844 (requested 390x844; the browser or screen clamps the window size)"},
		{"重置后把浮动窗口放回平铺", map[string]string{"reset": "true"},
			json.RawMessage(`{"data":{"tabId":12,"windowId":7,"width":1312,"height":900,"scope":"window","titleMarker":"[bctl 7] "}}`),
			"1012|floating|[bctl 7] Example Domain\n", false,
			[][]string{listArgs, {"layout", "--window-id", "1012", "tiling"}}, 1, "viewport 1312x900"},
		{"窗口隐藏时页面尚未重新布局", map[string]string{"width": "390", "height": "844"},
			json.RawMessage(`{"data":{"tabId":12,"windowId":7,"width":1512,"height":950,"exact":false,"deferred":true,` +
				`"scope":"window","titleMarker":"[bctl 7] "}}`),
			"1012|floating|[bctl 7] Example Domain\n", false, [][]string{listArgs}, 1,
			"viewport 1512x950" + viewportDeferredNote},
		{"Chrome 按标签模拟时不调用窗口管理器", map[string]string{"width": "390", "height": "844"},
			json.RawMessage(`{"data":{"tabId":12,"windowId":7,"width":390,"height":844,"exact":true,"scope":"tab"}}`),
			listing, false, nil, 1, "viewport 390x844"},
		{"未安装 AeroSpace 时只调整窗口", map[string]string{"width": "390", "height": "844"}, windowResp, "", true, nil, 1,
			"viewport 500x844 (requested 390x844; the browser or screen clamps the window size)"},
		{"找不到带标记的窗口时保持原样", map[string]string{"width": "390", "height": "844"}, windowResp,
			"136|h_tiles|Your watch history\n", false, [][]string{listArgs}, 1,
			"viewport 500x844 (requested 390x844; the browser or screen clamps the window size)"},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := stubAerospace(t, test.windows, test.missing)
			setCommandFlags(t, pageViewportCmd, test.flags)
			var stdout bytes.Buffer
			pageViewportCmd.SetOut(&stdout)
			t.Cleanup(func() { pageViewportCmd.SetOut(nil) })
			result := startPageCommandDaemon(t, map[string]json.RawMessage{"page.viewport": test.resp})
			if err := pageViewportCmd.RunE(pageViewportCmd, []string{"12"}); err != nil {
				t.Fatal(err)
			}
			requests := waitPageCommandRequests(t, result)
			if got := countRequests(requests, "page.viewport"); got != test.requests {
				t.Fatalf("page.viewport requests = %d, want %d", got, test.requests)
			}
			if !reflect.DeepEqual(*calls, test.calls) {
				t.Fatalf("aerospace calls = %v, want %v", *calls, test.calls)
			}
			if strings.TrimSpace(stdout.String()) != test.output {
				t.Fatalf("output = %q, want %q", stdout.String(), test.output)
			}
		})
	}
}

func TestPageViewportResetArgs(t *testing.T) {
	stubAerospace(t, "", true)
	setCommandFlags(t, pageViewportCmd, map[string]string{"reset": "true"})
	result := startPageCommandDaemon(t, map[string]json.RawMessage{
		"page.viewport": json.RawMessage(`{"data":{"tabId":12,"windowId":7,"width":1280,"height":720,"scope":"tab"}}`),
	})
	if err := pageViewportCmd.RunE(pageViewportCmd, []string{"12"}); err != nil {
		t.Fatal(err)
	}
	got := lastRequestArgs(t, waitPageCommandRequests(t, result), "page.viewport")
	if want := map[string]any{"tabId": 12.0, "reset": true}; !reflect.DeepEqual(got, want) {
		t.Fatalf("args = %v, want %v", got, want)
	}
}

func TestPageViewportResetConflictsWithSize(t *testing.T) {
	setCommandFlags(t, pageViewportCmd, map[string]string{"reset": "true", "width": "390"})
	err := pageViewportCmd.RunE(pageViewportCmd, []string{"12"})
	if err == nil || !strings.Contains(err.Error(), "--reset") {
		t.Fatalf("err = %v", err)
	}
}

func TestPageRunViewportFloatsWindow(t *testing.T) {
	calls := stubAerospace(t, "1012|h_tiles|[bctl 7] Example Domain\n", false)
	setCommandFlags(t, pageRunCmd, map[string]string{"file": "-"})
	pageRunCmd.SetIn(strings.NewReader(`[{"action": "viewport", "width": 390, "height": 844}]`))
	var stdout bytes.Buffer
	pageRunCmd.SetOut(&stdout)
	t.Cleanup(func() {
		pageRunCmd.SetIn(nil)
		pageRunCmd.SetOut(nil)
	})
	result := startPageCommandDaemon(t, map[string]json.RawMessage{
		"page.viewport": json.RawMessage(`{"data":{"tabId":12,"windowId":7,"width":500,"height":844,"exact":false,` +
			`"scope":"window","titleMarker":"[bctl 7] "}}`),
	})
	if err := pageRunCmd.RunE(pageRunCmd, []string{"12"}); err != nil {
		t.Fatal(err)
	}
	if got := countRequests(waitPageCommandRequests(t, result), "page.viewport"); got != 2 {
		t.Fatalf("page.viewport requests = %d, want 2", got)
	}
	if len(*calls) != 2 || (*calls)[1][3] != "floating" {
		t.Fatalf("aerospace calls = %v", *calls)
	}
	if strings.TrimSpace(stdout.String()) != "[1/1] viewport: 500x844" {
		t.Fatalf("output = %q", stdout.String())
	}
}
