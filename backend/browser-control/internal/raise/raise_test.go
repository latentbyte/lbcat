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

func (f fakeRaiser) Locate(context.Context, model.Tab, []model.Tab) (func(context.Context) error, error) {
	*f.calls = append(*f.calls, "locate "+f.name)
	if f.err != nil {
		return nil, f.err
	}
	return func(context.Context) error {
		*f.calls = append(*f.calls, "raise "+f.name)
		return nil
	}, nil
}

func TestWindow(t *testing.T) {
	t.Run("先定位窗口，再让浏览器聚焦，最后抬起窗口；第一个定位成功的生效", func(t *testing.T) {
		var calls []string
		raisers := []Raiser{
			fakeRaiser{name: "precise", err: ErrNoWindow, calls: &calls},
			fakeRaiser{name: "app", calls: &calls},
			fakeRaiser{name: "never", calls: &calls},
		}
		focus := func() error { calls = append(calls, "focus"); return nil }
		name, err := Window(context.Background(), raisers, model.Tab{}, nil, focus)
		if err != nil || name != "app" || strings.Join(calls, ",") != "locate precise,locate app,focus,raise app" {
			t.Fatalf("name = %q, err = %v, calls = %v", name, err, calls)
		}
	})

	t.Run("都定位不到时仍然聚焦标签并汇总每个错误", func(t *testing.T) {
		var calls []string
		raisers := []Raiser{
			fakeRaiser{name: "precise", err: ErrNoWindow, calls: &calls},
			fakeRaiser{name: "app", err: errors.New("app missing"), calls: &calls},
		}
		focus := func() error { calls = append(calls, "focus"); return nil }
		_, err := Window(context.Background(), raisers, model.Tab{}, nil, focus)
		if !errors.Is(err, ErrNoWindow) || !strings.Contains(err.Error(), "app: app missing") || calls[len(calls)-1] != "focus" {
			t.Fatalf("err = %v, calls = %v", err, calls)
		}
	})

	t.Run("浏览器聚焦失败时不抬起窗口", func(t *testing.T) {
		var calls []string
		failed := errors.New("tab gone")
		_, err := Window(context.Background(), []Raiser{fakeRaiser{name: "app", calls: &calls}}, model.Tab{}, nil, func() error { return failed })
		if !errors.Is(err, failed) || strings.Join(calls, ",") != "locate app" {
			t.Fatalf("err = %v, calls = %v", err, calls)
		}
	})

	t.Run("没有可用实现时只聚焦标签", func(t *testing.T) {
		focused := false
		name, err := Window(context.Background(), nil, model.Tab{}, nil, func() error { focused = true; return nil })
		if name != "" || err != nil || !focused {
			t.Fatalf("name = %q, err = %v, focused = %v", name, err, focused)
		}
	})
}

func TestMatchWindow(t *testing.T) {
	target := model.Tab{BrowserID: "zen-01", AppName: "Zen", ID: 116, WindowID: 631, Title: "Create app"}
	shown := model.Tab{BrowserID: "zen-01", AppName: "Zen", ID: 78, WindowID: 631, Title: "LBCat Agent Window", Active: true}
	other := model.Tab{BrowserID: "zen-01", AppName: "Zen", ID: 7, WindowID: 19, Title: "Weather report", Active: true}
	windows := []osWindow{
		{ID: 1, App: "Zen", Title: "Weather report"},
		{ID: 2, App: "Zen", Title: "LBCat Agent Window"},
		{ID: 3, App: "Google Chrome", Title: "Create app - Google Chrome"},
	}

	t.Run("按目标窗口当前活动标签的标题匹配同一应用的窗口", func(t *testing.T) {
		window, ok := matchWindow(target, []model.Tab{target, shown, other}, windows)
		if !ok || window.ID != 2 {
			t.Fatalf("window = %+v, ok = %v", window, ok)
		}
	})

	t.Run("应用只有一个窗口时直接选中", func(t *testing.T) {
		chrome := model.Tab{BrowserID: "chrome-02", AppName: "Google Chrome", Title: "Other title"}
		window, ok := matchWindow(chrome, nil, windows)
		if !ok || window.ID != 3 {
			t.Fatalf("window = %+v, ok = %v", window, ok)
		}
	})

	t.Run("同应用另一窗口显示同名标签时放弃", func(t *testing.T) {
		twin := other
		twin.Title = shown.Title
		if window, ok := matchWindow(target, []model.Tab{target, shown, twin}, windows); ok {
			t.Fatalf("matched ambiguous window %+v", window)
		}
	})

	t.Run("多个窗口标题都包含时放弃", func(t *testing.T) {
		short := shown
		short.Title = "t"
		if window, ok := matchWindow(target, []model.Tab{target, short, other}, windows); ok {
			t.Fatalf("matched ambiguous window %+v", window)
		}
	})

	t.Run("窗口管理器暂时报告空标题时放弃", func(t *testing.T) {
		blank := []osWindow{{ID: 1, App: "Zen"}, {ID: 2, App: "Zen"}}
		if window, ok := matchWindow(target, []model.Tab{target, shown, other}, blank); ok {
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
  echo '[{"window-id":5,"app-name":"Zen","window-title":"Weather report"},{"window-id":9,"app-name":"Zen","window-title":"Create app"}]'
fi
`
		if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
		tab := model.Tab{BrowserID: "zen-01", AppName: "Zen", WindowID: 631, Title: "Create app", Active: true}
		raiseWindow, err := (Aerospace{Path: script}).Locate(context.Background(), tab, []model.Tab{tab})
		if err != nil {
			t.Fatal(err)
		}
		if err := raiseWindow(context.Background()); err != nil {
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
