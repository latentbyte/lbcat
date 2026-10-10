package cmd

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
)

func TestPageMonitorCommands(t *testing.T) {
	at := func(ms int64) string { return time.UnixMilli(ms).Format("15:04:05.000") }
	entries := `[{"time":1000,"type":"request","level":"error","method":"GET","url":"https://a.test/api","status":404,"message":"GET https://a.test/api -> 404"},` +
		`{"time":2000,"type":"console","level":"warn","message":"careful"},` +
		`{"time":3000,"type":"error","level":"error","message":"TypeError: boom","url":"https://a.test/app.js:3:7"},` +
		`{"time":4000,"type":"navigation","url":"https://a.test/next","message":"navigated to https://a.test/next"},` +
		`{"time":5000,"type":"dialog","message":"confirm: Leave? -> false"}]`
	for _, test := range []struct {
		name    string
		command *cobra.Command
		flags   map[string]string
		cmd     string
		resp    string
		want    map[string]any
		output  string
	}{
		{"开始监控并自动关闭对话框", pageMonitorStartCmd, map[string]string{"dialogs": "dismiss"},
			"page.monitor.start", `{"data":{"tabId":12,"monitoring":true}}`,
			map[string]any{"tabId": 12.0, "dialogs": "dismiss"}, "monitoring tab 12 (dialogs: dismiss)"},
		{"读取条目逐行输出", pageMonitorReadCmd, map[string]string{"keep": "true"},
			"page.monitor.read", `{"data":{"tabId":12,"dropped":3,"entries":` + entries + `}}`,
			map[string]any{"tabId": 12.0, "keep": true},
			"[3 older entries dropped]\n" +
				at(1000) + " request GET https://a.test/api -> 404\n" +
				at(2000) + " console.warn careful\n" +
				at(3000) + " error TypeError: boom (https://a.test/app.js:3:7)\n" +
				at(4000) + " navigation https://a.test/next\n" +
				at(5000) + " dialog confirm: Leave? -> false"},
		{"无条目时说明", pageMonitorReadCmd, nil,
			"page.monitor.read", `{"data":{"tabId":12,"dropped":0,"entries":[]}}`,
			map[string]any{"tabId": 12.0}, "no new entries"},
		{"停止时输出剩余条目", pageMonitorStopCmd, nil,
			"page.monitor.stop", `{"data":{"tabId":12,"dropped":0,"entries":[{"time":2000,"type":"console","level":"error","message":"x"}]}}`,
			map[string]any{"tabId": 12.0}, at(2000) + " console.error x\nstopped monitoring tab 12"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setCommandFlags(t, test.command, test.flags)
			var stdout bytes.Buffer
			test.command.SetOut(&stdout)
			t.Cleanup(func() { test.command.SetOut(nil) })
			result := startPageCommandDaemon(t, map[string]json.RawMessage{test.cmd: json.RawMessage(test.resp)})
			if err := test.command.RunE(test.command, []string{"12"}); err != nil {
				t.Fatal(err)
			}
			got := lastRequestArgs(t, waitPageCommandRequests(t, result), test.cmd)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("args = %v, want %v", got, test.want)
			}
			if strings.TrimSpace(stdout.String()) != test.output {
				t.Fatalf("output = %q, want %q", stdout.String(), test.output)
			}
		})
	}
}

func TestPageMonitorRejectsUnknownDialogMode(t *testing.T) {
	setCommandFlags(t, pageMonitorStartCmd, map[string]string{"dialogs": "maybe"})
	err := pageMonitorStartCmd.RunE(pageMonitorStartCmd, []string{"12"})
	if err == nil || !strings.Contains(err.Error(), "--dialogs") {
		t.Fatalf("err = %v", err)
	}
}
