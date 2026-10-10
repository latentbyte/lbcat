package cmd

import (
	"bytes"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

func setCommandFlags(t *testing.T, command *cobra.Command, values map[string]string) {
	t.Helper()
	for name, value := range values {
		flag := command.Flags().Lookup(name)
		if flag == nil {
			t.Fatalf("missing flag --%s on %s", name, command.Name())
		}
		previous, changed := flag.Value.String(), flag.Changed
		slice, isSlice := flag.Value.(pflag.SliceValue)
		var previousSlice []string
		if isSlice {
			previousSlice = slice.GetSlice()
		}
		if err := command.Flags().Set(name, value); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			// Set appends to slice flags, so restore them wholesale
			if isSlice {
				_ = slice.Replace(previousSlice)
			} else {
				_ = flag.Value.Set(previous)
			}
			flag.Changed = changed
		})
	}
}

func lastRequestArgs(t *testing.T, requests []pageCommandRequest, cmd string) map[string]any {
	t.Helper()
	for _, request := range slices.Backward(requests) {
		if request.Cmd == cmd {
			var args map[string]any
			if err := json.Unmarshal(request.Args, &args); err != nil {
				t.Fatal(err)
			}
			delete(args, "sessionId")
			delete(args, "personalTabId")
			return args
		}
	}
	t.Fatalf("no %s request in %+v", cmd, requests)
	return nil
}

func TestPageActionCommands(t *testing.T) {
	clicked := json.RawMessage(`{"cmd":"page.click","data":{"matched":{"tag":"button","id":"save","text":"Save"},"navigated":true,"url":"https://a.test/next","title":"Next"}}`)
	for _, test := range []struct {
		name    string
		command *cobra.Command
		args    []string
		flags   map[string]string
		cmd     string
		resp    json.RawMessage
		want    map[string]any
		output  string
	}{
		{"按文本点击并等待导航", pageClickCmd, []string{"12"}, map[string]string{"text": "Save", "nth": "2"},
			"page.click", clicked,
			map[string]any{"tabId": 12.0, "text": "Save", "nth": 2.0, "wait": "load", "timeoutMs": 30000.0},
			`clicked <button#save> "Save"; navigated to https://a.test/next`},
		{"引用定位且不等待导航", pageClickCmd, []string{"12", "@e3"}, map[string]string{"wait": "none"},
			"page.click", clicked,
			map[string]any{"tabId": 12.0, "ref": "e3", "wait": "none", "timeoutMs": 30000.0},
			`clicked <button#save> "Save"; navigated to https://a.test/next`},
		{"按选择器填写", pageFillCmd, []string{"12", "#email"}, map[string]string{"value": "a@b.c"},
			"page.fill", json.RawMessage(`{"data":{"matched":{"tag":"input","id":"email"}}}`),
			map[string]any{"tabId": 12.0, "selector": "#email", "value": "a@b.c", "wait": "load", "timeoutMs": 30000.0},
			"filled <input#email>"},
		{"选择下拉项", pageSelectCmd, []string{"12", "#fruit"}, map[string]string{"value": "Banana"},
			"page.select", json.RawMessage(`{"data":{"matched":{"tag":"select","id":"fruit"},"selected":"b"}}`),
			map[string]any{"tabId": 12.0, "selector": "#fruit", "value": "Banana", "wait": "load", "timeoutMs": 30000.0},
			`selected <select#fruit> = "b"`},
		{"在聚焦元素按键", pagePressCmd, []string{"12", "Enter"}, nil,
			"page.press", json.RawMessage(`{"data":{"navigated":false}}`),
			map[string]any{"tabId": 12.0, "key": "Enter", "wait": "load", "timeoutMs": 30000.0}, "pressed"},
		{"跳转地址", pageGotoCmd, []string{"12", "https://b.test/"}, map[string]string{"timeout": "5s"},
			"page.goto", json.RawMessage(`{"data":{"url":"https://b.test/"}}`),
			map[string]any{"tabId": 12.0, "url": "https://b.test/", "wait": "load", "timeoutMs": 5000.0},
			"navigated tab 12: https://b.test/"},
		{"后退", pageBackCmd, []string{"12"}, nil,
			"page.back", json.RawMessage(`{"data":{"url":"https://a.test/"}}`),
			map[string]any{"tabId": 12.0, "wait": "load", "timeoutMs": 30000.0}, "back tab 12: https://a.test/"},
		{"等待元素与地址", pageWaitCmd, []string{"12"}, map[string]string{"selector": ".done", "url": "/done$", "state": "gone"},
			"page.wait", json.RawMessage(`{"data":{"elapsedMs":120,"url":"https://a.test/done"}}`),
			map[string]any{"tabId": 12.0, "selector": ".done", "url": "/done$", "state": "gone", "timeoutMs": 10000.0},
			"ready after 120ms: https://a.test/done"},
		{"执行脚本传递字符上限", pageExecCmd, []string{"12", "'x'"}, map[string]string{"max-chars": "5"},
			"page.exec", json.RawMessage(`{"data":{"result":"xxxxx","truncated":true,"totalLength":9}}`),
			map[string]any{"tabId": 12.0, "code": "'x'", "world": "MAIN", "timeoutMs": 45000.0, "maxChars": 5.0},
			"{\n  \"result\": \"xxxxx\",\n  \"totalLength\": 9,\n  \"truncated\": true\n}"},
		{"内容以 Markdown 输出并限制长度", pageContentCmd, []string{"12"}, map[string]string{"format": "markdown", "max-chars": "100"},
			"page.content", json.RawMessage(`{"data":"# Title"}`),
			map[string]any{"tabId": 12.0, "selector": "body", "format": "markdown", "maxChars": 100.0}, "# Title"},
		{"快照逐行列出元素引用", pageSnapshotCmd, []string{"12"}, map[string]string{"selector": "form", "max": "3"},
			"page.snapshot", json.RawMessage(`{"data":{"url":"https://a.test/","title":"Shop","total":9,"truncated":true,"elements":[` +
				`{"role":"heading","name":"Pay","level":2},{"ref":"e1","role":"textbox","name":"Email","value":"a@b.c"},` +
				`{"ref":"e2","role":"checkbox","name":"Remember","checked":false},{"ref":"e3","role":"link","name":"Help","href":"/help","disabled":true}]}}`),
			map[string]any{"tabId": 12.0, "selector": "form", "max": 3.0},
			"Shop\nhttps://a.test/\nh2 \"Pay\"\n@e1 textbox \"Email\" = \"a@b.c\"\n@e2 checkbox \"Remember\" [unchecked]\n" +
				"@e3 link \"Help\" -> /help [disabled]\n[showing 4 of 9; narrow --selector or raise --max]"},
		{"页面身份请求发送方法、头与正文", pageFetchCmd, []string{"12", "/api"},
			map[string]string{"method": "POST", "header": "X-A: 1", "body": `{"a":1}`, "max-chars": "5"},
			"page.fetch", json.RawMessage(`{"data":{"status":200,"ok":true,"body":"hello","truncated":true,"totalLength":9}}`),
			map[string]any{"tabId": 12.0, "url": "/api", "method": "POST", "headers": map[string]any{"X-A": "1"},
				"body": `{"a":1}`, "maxChars": 5.0, "timeoutMs": 30000.0},
			"hello\n\n[truncated: 5 of 9 characters]"},
		{"重载默认等待加载", pageReloadCmd, []string{"12"}, nil,
			"page.reload", json.RawMessage(`{"data":{"tabId":12}}`),
			map[string]any{"tabId": 12.0, "bypassCache": false, "wait": "load", "timeoutMs": 30000.0}, "reloaded tab 12"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setCommandFlags(t, test.command, test.flags)
			var stdout bytes.Buffer
			test.command.SetOut(&stdout)
			t.Cleanup(func() { test.command.SetOut(nil) })
			result := startPageCommandDaemon(t, map[string]json.RawMessage{test.cmd: test.resp})
			if err := test.command.RunE(test.command, test.args); err != nil {
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

func TestPageFetchNonOKStatusFails(t *testing.T) {
	var stdout bytes.Buffer
	pageFetchCmd.SetOut(&stdout)
	t.Cleanup(func() { pageFetchCmd.SetOut(nil) })
	result := startPageCommandDaemon(t, map[string]json.RawMessage{
		"page.fetch": json.RawMessage(`{"data":{"status":404,"ok":false,"body":"missing"}}`),
	})
	err := pageFetchCmd.RunE(pageFetchCmd, []string{"12", "/x"})
	waitPageCommandRequests(t, result)
	if err == nil || err.Error() != "HTTP 404" || strings.TrimSpace(stdout.String()) != "missing" {
		t.Fatalf("err = %v, output = %q", err, stdout.String())
	}
}

func TestPageActionArgumentErrors(t *testing.T) {
	for _, test := range []struct {
		name    string
		command *cobra.Command
		args    []string
		flags   map[string]string
		want    string
	}{
		{"点击缺少定位", pageClickCmd, []string{"12"}, nil, "selector or --text"},
		{"填写缺少值", pageFillCmd, []string{"12", "#email"}, nil, "--value is required"},
		{"等待缺少条件", pageWaitCmd, []string{"12"}, map[string]string{"state": "gone"}, "--load, --url"},
		{"无效等待模式", pageGotoCmd, []string{"12", "https://a.test/"}, map[string]string{"wait": "idle"}, "--wait must be"},
	} {
		t.Run(test.name, func(t *testing.T) {
			setCommandFlags(t, test.command, test.flags)
			err := test.command.RunE(test.command, test.args)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("err = %v, want %q", err, test.want)
			}
		})
	}
}
