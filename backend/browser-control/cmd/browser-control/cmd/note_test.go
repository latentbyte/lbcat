package cmd

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func noteResponse(status string) json.RawMessage {
	return json.RawMessage(`{"cmd":"notes.get","data":{"id":"n1","status":"` + status + `","reply":"done"}}`)
}

func TestWaitForNote(t *testing.T) {
	t.Run("人工确认后返回便签", func(t *testing.T) {
		statuses := []string{"open", "open", "acknowledged"}
		calls := 0
		note, err := waitForNote(func() (json.RawMessage, error) {
			calls++
			return noteResponse(statuses[calls-1]), nil
		}, time.Millisecond, time.Second)
		if err != nil || calls != 3 {
			t.Fatalf("calls = %d, error = %v", calls, err)
		}
		var data struct{ Status, Reply string }
		if err := json.Unmarshal(note, &data); err != nil || data.Status != "acknowledged" || data.Reply != "done" {
			t.Fatalf("note = %s, error = %v", note, err)
		}
	})
	t.Run("超时仍未处理时报错", func(t *testing.T) {
		_, err := waitForNote(func() (json.RawMessage, error) { return noteResponse("open"), nil }, time.Millisecond, 5*time.Millisecond)
		if err == nil {
			t.Fatal("expected timeout")
		}
	})
	t.Run("读取失败立即返回错误", func(t *testing.T) {
		want := errors.New("NOTE_NOT_FOUND")
		_, err := waitForNote(func() (json.RawMessage, error) { return nil, want }, time.Millisecond, time.Second)
		if !errors.Is(err, want) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestNoteAddArgs(t *testing.T) {
	t.Run("合并文本并校验类型", func(t *testing.T) {
		args, err := noteAddArgs([]string{"12", "solve", "the captcha"}, "needs-human")
		if err != nil || args["tabId"] != 12 || args["text"] != "solve the captcha" || args["kind"] != "needs-human" {
			t.Fatalf("args = %v, error = %v", args, err)
		}
	})
	t.Run("拒绝无效标签与类型", func(t *testing.T) {
		if _, err := noteAddArgs([]string{"x", "hi"}, "info"); err == nil {
			t.Fatal("expected tab error")
		}
		if _, err := noteAddArgs([]string{"3", "hi"}, "todo"); err == nil {
			t.Fatal("expected kind error")
		}
	})
}
