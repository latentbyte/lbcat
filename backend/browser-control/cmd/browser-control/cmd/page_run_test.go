package cmd

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/spf13/pflag"
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

func TestSummarizeStepIncludesRequestedSnapshot(t *testing.T) {
	got, err := summarizeStep("click", json.RawMessage(`{"matched":{"tag":"button","text":"Add"},`+
		`"changes":{"total":2,"added":[{"ref":"e2","role":"button","name":"Remove"}],"removed":[],"changed":[]}}`))
	if err != nil {
		t.Fatal(err)
	}
	if want := " <button> \"Add\"\n+ @e2 button \"Remove\""; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
}

func runInlineSteps(t *testing.T, steps []string, responses map[string]json.RawMessage) ([]pageCommandRequest, string, error) {
	t.Helper()
	var stdout bytes.Buffer
	pageRunCmd.SetOut(&stdout)
	t.Cleanup(func() { pageRunCmd.SetOut(nil) })
	result := startPageCommandDaemon(t, responses)
	err := pageRunCmd.RunE(pageRunCmd, append([]string{"12"}, steps...))
	return waitPageCommandRequests(t, result), stdout.String(), err
}

func TestPageRunInlineSteps(t *testing.T) {
	requests, output, err := runInlineSteps(t, []string{
		"goto https://a.test/login",
		`fill @e2 --value "Ada Lovelace"`,
		"click --text 'Sign in' --timeout 5s",
		"content --selector main --format markdown --max-chars 400",
	}, map[string]json.RawMessage{
		"page.goto":    json.RawMessage(`{"data":{"tabId":12,"navigated":true,"url":"https://a.test/login","title":"Login"}}`),
		"page.fill":    json.RawMessage(`{"data":{"matched":{"tag":"input","id":"name"},"navigated":false,"url":"https://a.test/login"}}`),
		"page.click":   json.RawMessage(`{"data":{"matched":{"tag":"button","text":"Sign in"},"navigated":true,"url":"https://a.test/home"}}`),
		"page.content": json.RawMessage(`{"data":"# Home"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	for cmd, want := range map[string]map[string]any{
		"page.goto":    {"tabId": 12.0, "url": "https://a.test/login", "wait": "load", "timeoutMs": 30000.0},
		"page.fill":    {"tabId": 12.0, "ref": "e2", "value": "Ada Lovelace", "wait": "load", "timeoutMs": 30000.0},
		"page.click":   {"tabId": 12.0, "text": "Sign in", "wait": "load", "timeoutMs": 5000.0},
		"page.content": {"tabId": 12.0, "selector": "main", "format": "markdown", "maxChars": 400.0},
	} {
		if got := lastRequestArgs(t, requests, cmd); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s args = %v, want %v", cmd, got, want)
		}
	}
	want := "[1/4] goto: https://a.test/login\n" +
		"[2/4] fill: <input#name>\n" +
		"[3/4] click: <button> \"Sign in\"; navigated to https://a.test/home\n" +
		"[4/4] content:\n# Home\n"
	if output != want {
		t.Fatalf("output = %q, want %q", output, want)
	}
}

func TestPageRunInlineStepFlags(t *testing.T) {
	for _, test := range []struct {
		name, step, cmd string
		want            map[string]any
	}{
		{"坐标点击转换为 x/y", "click --at 10,20 --wait none", "page.click",
			map[string]any{"x": 10.0, "y": 20.0, "wait": "none", "timeoutMs": 30000.0}},
		{"按键带定位与序号", "press Enter --text Search --nth 2", "page.press",
			map[string]any{"key": "Enter", "text": "Search", "nth": 2.0, "wait": "load", "timeoutMs": 30000.0}},
		{"选择器作为定位", "select '#country' --value Canada", "page.select",
			map[string]any{"selector": "#country", "value": "Canada", "wait": "load", "timeoutMs": 30000.0}},
		{"等待条件与布尔标志", "wait --load --url /home --timeout 3s", "page.wait",
			map[string]any{"load": true, "url": "/home", "timeoutMs": 3000.0}},
		{"重载绕过缓存", "reload --bypass-cache", "page.reload",
			map[string]any{"bypassCache": true, "wait": "load", "timeoutMs": 30000.0}},
		{"请求头与请求体", `fetch /api --method POST --header 'X-A: 1' --body '{"a":1}'`, "page.fetch",
			map[string]any{"url": "/api", "method": "POST", "headers": map[string]any{"X-A": "1"}, "body": `{"a":1}`, "timeoutMs": 30000.0}},
		{"执行代码", `exec 'document.title' --max-chars 50`, "page.exec",
			map[string]any{"code": "document.title", "world": "MAIN", "maxChars": 50.0, "timeoutMs": 45000.0}},
		{"快照范围", "snapshot --selector form --max 20", "page.snapshot",
			map[string]any{"selector": "form", "max": 20.0}},
		{"视口尺寸", "viewport --width 800", "page.viewport",
			map[string]any{"width": 800.0}},
	} {
		t.Run(test.name, func(t *testing.T) {
			steps, err := parseInlineSteps([]string{test.step}, 12)
			if err != nil {
				t.Fatal(err)
			}
			got := steps[0].args
			delete(got, "tabId")
			delete(got, "snapshot")
			encoded, _ := json.Marshal(got)
			var decoded map[string]any
			_ = json.Unmarshal(encoded, &decoded)
			if steps[0].cmd != test.cmd || !reflect.DeepEqual(decoded, test.want) {
				t.Fatalf("%s %v, want %s %v", steps[0].cmd, decoded, test.cmd, test.want)
			}
		})
	}
}

func TestPageRunSnapshotsOnlyAfterLastAction(t *testing.T) {
	snapshotOf := func(steps []runStep) []any {
		var modes []any
		for _, step := range steps {
			modes = append(modes, step.args["snapshot"])
		}
		return modes
	}
	for _, test := range []struct {
		name  string
		parse func() ([]runStep, error)
		want  []any
	}{
		{"内联步骤仅最后一个动作默认 diff", func() ([]runStep, error) {
			return parseInlineSteps([]string{"fill @e1 --value a", "click @e2"}, 12)
		}, []any{nil, "diff"}},
		{"JSON 步骤同样默认", func() ([]runStep, error) {
			return parseRunSteps([]byte(`[{"action":"fill","ref":"e1","value":"a"},{"action":"click","ref":"e2"}]`), 12)
		}, []any{nil, "diff"}},
		{"最后一步显式 none 不观察", func() ([]runStep, error) {
			return parseInlineSteps([]string{"click @e2 --snapshot none"}, 12)
		}, []any{"none"}},
		{"中间步骤可显式请求", func() ([]runStep, error) {
			return parseInlineSteps([]string{"click @e1 --snapshot full", "click @e2"}, 12)
		}, []any{"full", "diff"}},
		{"最后一步不是动作时不加快照", func() ([]runStep, error) {
			return parseInlineSteps([]string{"click @e1", "content"}, 12)
		}, []any{nil, nil}},
	} {
		t.Run(test.name, func(t *testing.T) {
			steps, err := test.parse()
			if err != nil {
				t.Fatal(err)
			}
			if got := snapshotOf(steps); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("snapshot modes = %v, want %v", got, test.want)
			}
		})
	}
}

func TestPageRunInlineValidatesBeforeRunning(t *testing.T) {
	for _, test := range []struct {
		name  string
		steps []string
		want  string
	}{
		{"未知动作提示加引号", []string{"click", "@e3"}, `step 2: unknown action "@e3" (quote each step`},
		{"未知标志", []string{"click @e3 --force"}, "step 1: unknown flag: --force"},
		{"缺少必需参数", []string{"goto"}, "step 1: goto needs <url>"},
		{"多余参数提示省略标签", []string{"fill 12 @e3 --value x"}, "step 1: fill takes at most 1 argument (steps omit the tab ID)"},
		{"标志值类型错误", []string{"click @e3 --nth two"}, "step 1: invalid argument"},
		{"坐标格式错误", []string{"click --at 10"}, "step 1: --at must be x,y"},
		{"引号未闭合", []string{`fill @e3 --value "a`}, "step 1: unterminated quote"},
		{"空步骤", []string{"  "}, "step 1: empty step"},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := pageRunCmd.RunE(pageRunCmd, append([]string{"12"}, test.steps...))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("err = %v, want %q", err, test.want)
			}
		})
	}
	t.Run("内联步骤与 -f 互斥", func(t *testing.T) {
		setCommandFlags(t, pageRunCmd, map[string]string{"file": writeSteps(t, `[{"action":"reload"}]`)})
		err := pageRunCmd.RunE(pageRunCmd, []string{"12", "reload"})
		if err == nil || !strings.Contains(err.Error(), "inline steps or -f, not both") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("没有步骤", func(t *testing.T) {
		err := pageRunCmd.RunE(pageRunCmd, []string{"12"})
		if err == nil || !strings.Contains(err.Error(), "provide steps") {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestSplitStepWords(t *testing.T) {
	for _, test := range []struct {
		name, text string
		want       []string
	}{
		{"空白分隔", "  click   @e3 ", []string{"click", "@e3"}},
		{"单引号原样保留", `fill --value 'a "b" \n'`, []string{"fill", "--value", `a "b" \n`}},
		{"双引号支持转义", `fill --value "say \"hi\" \\ $HOME"`, []string{"fill", "--value", `say "hi" \ $HOME`}},
		{"引号拼接到同一个词", `fill --value=a' b'"c"`, []string{"fill", "--value=a bc"}},
		{"空引号是空词", `fill --value ''`, []string{"fill", "--value", ""}},
		{"反斜杠转义空格", `click --text Sign\ in`, []string{"click", "--text", "Sign in"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := splitStepWords(test.text)
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("splitStepWords(%q) = %q, %v; want %q", test.text, got, err, test.want)
			}
		})
	}
}

func TestPageRunActionsTakeTheirCommandFlags(t *testing.T) {
	for name, action := range runActions {
		t.Run(name, func(t *testing.T) {
			flags, err := stepFlagSet(action.command)
			if err != nil {
				t.Fatal(err)
			}
			action.command.LocalFlags().VisitAll(func(flag *pflag.Flag) {
				if flags.Lookup(flag.Name) == nil {
					t.Fatalf("step flags miss --%s", flag.Name)
				}
			})
		})
	}
}
