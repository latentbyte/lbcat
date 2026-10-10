package browsercontrol

import (
	"strings"
	"testing"
)

func TestResolveBrowserAlias(t *testing.T) {
	connected := []string{"zen-11", "chrome-01", "chrome-02"}
	for _, test := range []struct {
		name, requested, want, err string
	}{
		{"精确 ID 原样返回", "chrome-02", "chrome-02", ""},
		{"浏览器名解析为唯一连接", "zen", "zen-11", ""},
		{"浏览器名忽略大小写", "Zen", "zen-11", ""},
		{"同名多个连接时报错", "chrome", "", "multiple chrome browsers connected: chrome-01, chrome-02"},
		{"未连接的值原样交给守护进程", "firefox-01", "firefox-01", ""},
		{"空值不选择", "", "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := ResolveBrowserAlias(test.requested, connected)
			if test.err != "" {
				if err == nil || !strings.Contains(err.Error(), test.err) {
					t.Fatalf("err = %v, want %q", err, test.err)
				}
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("got %q, %v; want %q", got, err, test.want)
			}
		})
	}
}
