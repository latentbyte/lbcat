package cmd

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseGuideMark(t *testing.T) {
	cases := []struct {
		raw  string
		want map[string]any
	}{
		{"@e12|Click here", map[string]any{"ref": "e12", "label": "Click here"}},
		{"@e3", map[string]any{"ref": "e3"}},
		{"text=Save draft|1", map[string]any{"text": "Save draft", "label": "1"}},
		{"#api-key", map[string]any{"selector": "#api-key"}},
		{"input:checked | tick these ", map[string]any{"selector": "input:checked", "label": "tick these"}},
		{"[lang|=en]|English", map[string]any{"selector": "[lang|=en]", "label": "English"}},
	}
	for _, tc := range cases {
		got, err := parseGuideMark(tc.raw)
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("parseGuideMark(%q) = %v, %v; want %v", tc.raw, got, err, tc.want)
		}
	}
	for _, raw := range []string{"", "|label", "@|x", "text=|x"} {
		if _, err := parseGuideMark(raw); err == nil {
			t.Errorf("parseGuideMark(%q) should fail", raw)
		}
	}
}

func TestGuideStepArgs(t *testing.T) {
	args, err := guideStepArgs("7", "  Copy the key  ", "Setup", []string{"#key|copy this", "@e2"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"tabId": 7,
		"text":  "Copy the key",
		"title": "Setup",
		"marks": []map[string]any{{"selector": "#key", "label": "copy this"}, {"ref": "e2"}},
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v; want %v", args, want)
	}
	if _, err := guideStepArgs("7", " ", "", nil); err == nil {
		t.Error("empty text should fail")
	}
	if _, err := guideStepArgs("x", "hi", "", nil); err == nil {
		t.Error("bad tab ID should fail")
	}
}

func TestNotifyGuideStep(t *testing.T) {
	t.Run("每一步都通知人工：首步标明开始，后续步骤标明新步骤，正文带标题与步骤首行", func(t *testing.T) {
		dir := t.TempDir()
		output := filepath.Join(dir, "notifications")
		script := "#!/bin/sh\nprintf '%s|%s\\n' \"$1\" \"$2\" >> \"$BC_TEST_NOTIFY_FILE\"\n"
		if err := os.WriteFile(filepath.Join(dir, "notify.sh"), []byte(script), 0o700); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", dir)
		t.Setenv("BC_TEST_NOTIFY_FILE", output)
		notifyGuideStep(json.RawMessage(`{"cmd":"guide.step","data":{"tabId":7,"step":1,"started":true}}`), " Setup ", "\n Open **Settings**\nthen more")
		notifyGuideStep(json.RawMessage(`{"cmd":"guide.step","data":{"tabId":7,"step":2}}`), "Setup", "Click Save")
		notifyGuideStep(json.RawMessage(`{"cmd":"guide.step","data":{"tabId":8,"step":1,"started":true}}`), "", strings.Repeat("x", 150))
		data, err := os.ReadFile(output)
		if err != nil {
			t.Fatal(err)
		}
		want := "Agent guide started|Setup: Open **Settings**\n" +
			"Agent guide: new step|Setup: Click Save\n" +
			"Agent guide started|Agent walkthrough: " + strings.Repeat("x", 99) + "...\n"
		if string(data) != want {
			t.Fatalf("notifications = %q; want %q", data, want)
		}
	})
}
