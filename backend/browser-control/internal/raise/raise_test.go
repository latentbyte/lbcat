package raise

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
)

type fakeRaiser struct {
	name  string
	err   error
	calls *[]string
}

func (f fakeRaiser) Name() string { return f.name }

func (f fakeRaiser) Raise(context.Context, model.Tab, []model.Tab) error {
	*f.calls = append(*f.calls, f.name)
	return f.err
}

func TestWindow(t *testing.T) {
	t.Run("按顺序尝试，第一个成功的生效", func(t *testing.T) {
		var calls []string
		raisers := []Raiser{
			fakeRaiser{name: "precise", err: ErrNoWindow, calls: &calls},
			fakeRaiser{name: "app", calls: &calls},
			fakeRaiser{name: "never", calls: &calls},
		}
		name, err := Window(context.Background(), raisers, model.Tab{}, nil)
		if err != nil || name != "app" || strings.Join(calls, ",") != "precise,app" {
			t.Fatalf("name = %q, err = %v, calls = %v", name, err, calls)
		}
	})

	t.Run("全部失败时汇总每个错误", func(t *testing.T) {
		var calls []string
		raisers := []Raiser{
			fakeRaiser{name: "precise", err: ErrNoWindow, calls: &calls},
			fakeRaiser{name: "app", err: errors.New("app missing"), calls: &calls},
		}
		_, err := Window(context.Background(), raisers, model.Tab{}, nil)
		if !errors.Is(err, ErrNoWindow) || !strings.Contains(err.Error(), "app: app missing") {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("没有可用实现时什么也不做", func(t *testing.T) {
		if name, err := Window(context.Background(), nil, model.Tab{}, nil); name != "" || err != nil {
			t.Fatalf("name = %q, err = %v", name, err)
		}
	})
}

func TestMatchWindow(t *testing.T) {
	target := model.Tab{BrowserID: "zen-01", AppName: "Zen", ID: 116, WindowID: 631, Title: "Create app", Active: true}
	windows := []osWindow{
		{ID: 1, App: "Zen", Title: "Posts 2021"},
		{ID: 2, App: "Zen", Title: "Create app"},
		{ID: 3, App: "Google Chrome", Title: "Create app - Google Chrome"},
	}

	t.Run("按活动标签标题匹配同一应用的窗口", func(t *testing.T) {
		window, ok := matchWindow(target, []model.Tab{target}, windows)
		if !ok || window.ID != 2 {
			t.Fatalf("window = %+v, ok = %v", window, ok)
		}
	})

	t.Run("应用只有一个窗口时直接选中", func(t *testing.T) {
		chrome := model.Tab{BrowserID: "chrome-02", AppName: "Google Chrome", Title: "Other title", Active: true}
		window, ok := matchWindow(chrome, nil, windows)
		if !ok || window.ID != 3 {
			t.Fatalf("window = %+v, ok = %v", window, ok)
		}
	})

	t.Run("同应用另一窗口显示同名标签时放弃", func(t *testing.T) {
		twin := model.Tab{BrowserID: "zen-01", AppName: "Zen", ID: 7, WindowID: 19, Title: "Create app", Active: true}
		if window, ok := matchWindow(target, []model.Tab{target, twin}, windows); ok {
			t.Fatalf("matched ambiguous window %+v", window)
		}
	})

	t.Run("多个窗口标题都包含时放弃", func(t *testing.T) {
		short := target
		short.Title = "t"
		if window, ok := matchWindow(short, []model.Tab{short}, windows); ok {
			t.Fatalf("matched ambiguous window %+v", window)
		}
	})

	t.Run("标题为空且有多个窗口时放弃", func(t *testing.T) {
		untitled := target
		untitled.Title = ""
		if window, ok := matchWindow(untitled, nil, windows); ok {
			t.Fatalf("matched window %+v", window)
		}
	})
}

func TestAerospace(t *testing.T) {
	t.Run("列出窗口后聚焦匹配的窗口 ID", func(t *testing.T) {
		dir := t.TempDir()
		calls := filepath.Join(dir, "calls")
		script := filepath.Join(dir, "aerospace")
		body := `#!/bin/sh
echo "$*" >> "` + calls + `"
if [ "$1" = list-windows ]; then
  echo '[{"window-id":5,"app-name":"Zen","window-title":"Posts"},{"window-id":9,"app-name":"Zen","window-title":"Create app"}]'
fi
`
		if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
		tab := model.Tab{BrowserID: "zen-01", AppName: "Zen", WindowID: 631, Title: "Create app", Active: true}
		if err := (Aerospace{Path: script}).Raise(context.Background(), tab, []model.Tab{tab}); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(calls)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != "list-windows --all --json\nfocus --window-id 9\n" {
			t.Fatalf("calls = %q", got)
		}
	})
}
