package cmd

import "testing"

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
