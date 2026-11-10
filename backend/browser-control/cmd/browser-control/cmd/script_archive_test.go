package cmd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestScriptArchiveDir(t *testing.T) {
	setup := func(t *testing.T) string {
		t.Helper()
		home := t.TempDir()
		t.Setenv("HOME", home)
		t.Setenv("BROWSER_CONTROL_SCRIPTS_DIR", "")
		t.Setenv("DOTFILES_DIR", "")
		t.Setenv("XDG_DATA_HOME", "")
		return home
	}

	t.Run("没有dotfiles目录时归档到用户数据目录", func(t *testing.T) {
		home := setup(t)
		if got, want := scriptArchiveDir(), filepath.Join(home, ".local", "share", "browser-control", "user-scripts"); got != want {
			t.Fatalf("dir = %q, want %q", got, want)
		}
	})

	t.Run("设置了XDG_DATA_HOME时使用它", func(t *testing.T) {
		setup(t)
		t.Setenv("XDG_DATA_HOME", "/data")
		if got := scriptArchiveDir(); got != "/data/browser-control/user-scripts" {
			t.Fatalf("dir = %q", got)
		}
	})

	t.Run("存在dotfiles目录时沿用dotfiles归档", func(t *testing.T) {
		home := setup(t)
		if err := os.Mkdir(filepath.Join(home, "dotfiles"), 0o700); err != nil {
			t.Fatal(err)
		}
		if got, want := scriptArchiveDir(), filepath.Join(home, "dotfiles", "user-scripts"); got != want {
			t.Fatalf("dir = %q, want %q", got, want)
		}
	})

	t.Run("显式环境变量优先", func(t *testing.T) {
		setup(t)
		t.Setenv("DOTFILES_DIR", "/df")
		if got := scriptArchiveDir(); got != "/df/user-scripts" {
			t.Fatalf("dir = %q", got)
		}
		t.Setenv("BROWSER_CONTROL_SCRIPTS_DIR", "/explicit")
		if got := scriptArchiveDir(); got != "/explicit" {
			t.Fatalf("dir = %q", got)
		}
	})
}
