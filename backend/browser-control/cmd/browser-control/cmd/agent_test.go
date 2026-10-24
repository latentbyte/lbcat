package cmd

import (
	"encoding/json"
	"testing"
)

func TestSessionOpenArgs(t *testing.T) {
	t.Run("标签参数优先于环境变量", func(t *testing.T) {
		t.Setenv("BROWSER_CONTROL_LABEL", "from env")
		command := newSessionBeginCmd()
		if err := command.Flags().Set("label", "claude: fix login"); err != nil {
			t.Fatal(err)
		}
		args, err := sessionOpenArgs(command)
		if err != nil || args["label"] != "claude: fix login" {
			t.Fatalf("args = %v, error = %v", args, err)
		}
	})
	t.Run("未指定标签时读取环境变量", func(t *testing.T) {
		t.Setenv("BROWSER_CONTROL_LABEL", "codex review")
		args, err := sessionOpenArgs(newSessionBeginCmd())
		if err != nil || args["label"] != "codex review" {
			t.Fatalf("args = %v, error = %v", args, err)
		}
	})
	t.Run("没有标签时不发送字段", func(t *testing.T) {
		t.Setenv("BROWSER_CONTROL_LABEL", "")
		args, err := sessionOpenArgs(newSessionBeginCmd())
		if _, ok := args["label"]; err != nil || ok {
			t.Fatalf("args = %v, error = %v", args, err)
		}
	})
	t.Run("非正租约时长被拒绝", func(t *testing.T) {
		command := newSessionBeginCmd()
		if err := command.Flags().Set("ttl", "0s"); err != nil {
			t.Fatal(err)
		}
		if _, err := sessionOpenArgs(command); err == nil {
			t.Fatal("expected ttl error")
		}
	})
}

func TestSessionBeginOutput(t *testing.T) {
	response := json.RawMessage(`{"ok":true,"data":{"sessionId":"ab12cd34","expiresAt":5}}`)
	t.Run("纯文本输出带浏览器名前缀", func(t *testing.T) {
		got, err := sessionBeginOutput(response, "zen-11", false)
		if err != nil || got != "zen:ab12cd34" {
			t.Fatalf("got %q, %v", got, err)
		}
	})
	t.Run("JSON 输出改写 sessionId 并保留其他字段", func(t *testing.T) {
		got, err := sessionBeginOutput(response, "zen-11", true)
		if err != nil {
			t.Fatal(err)
		}
		var decoded struct {
			OK   bool `json:"ok"`
			Data struct {
				SessionID string  `json:"sessionId"`
				ExpiresAt float64 `json:"expiresAt"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(got), &decoded); err != nil || !decoded.OK ||
			decoded.Data.SessionID != "zen:ab12cd34" || decoded.Data.ExpiresAt != 5 {
			t.Fatalf("got %s, %v", got, err)
		}
	})
	t.Run("缺少 sessionId 时报错", func(t *testing.T) {
		if _, err := sessionBeginOutput(json.RawMessage(`{"data":{}}`), "zen-11", false); err == nil {
			t.Fatal("expected error")
		}
	})
}
