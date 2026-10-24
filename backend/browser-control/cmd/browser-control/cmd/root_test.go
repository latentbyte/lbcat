package cmd

import (
	"reflect"
	"strings"
	"testing"
)

func TestBrowserPeersFiltersCLIConnections(t *testing.T) {
	t.Parallel()

	got := browserPeers([]string{"cli-28", "zen-09", "chrome-01", "cli-29"})
	want := []string{"zen-09", "chrome-01"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("browserPeers() = %#v, want %#v", got, want)
	}
}

func TestResolveBrowserIgnoresCLIConnections(t *testing.T) {
	t.Parallel()

	got, err := resolveBrowser([]string{"cli-28", "zen-09"})
	if err != nil {
		t.Fatalf("resolveBrowser() error = %v", err)
	}
	if got != "zen-09" {
		t.Fatalf("resolveBrowser() = %q, want zen-09", got)
	}
}

func TestResolveBrowserAcceptsNameAndEnvironment(t *testing.T) {
	peers := []string{"cli-01", "zen-11", "chrome-01", "chrome-02"}
	for _, test := range []struct {
		name, flag, env, want, err string
	}{
		{"环境变量按浏览器名选择", "", "zen", "zen-11", ""},
		{"参数优先于环境变量", "chrome-02", "zen", "chrome-02", ""},
		{"同名多个连接时要求精确 ID", "chrome", "", "", "multiple chrome browsers"},
		{"未指定且多个连接时提示环境变量", "", "", "", "BROWSER_CONTROL_BROWSER"},
	} {
		t.Run(test.name, func(t *testing.T) {
			previous := flagBrowser
			flagBrowser = test.flag
			t.Cleanup(func() { flagBrowser = previous })
			t.Setenv("BROWSER_CONTROL_BROWSER", test.env)
			got, err := resolveBrowser(peers)
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

func TestSessionHandleRoutesBrowser(t *testing.T) {
	peers := []string{"cli-01", "zen-11", "chrome-01"}
	for _, test := range []struct {
		name, flagSession, envSession, flagBrowser, envBrowser, wantBrowser, wantSession string
	}{
		{"会话前缀选择浏览器", "", "zen:ab12cd34", "", "", "zen-11", "ab12cd34"},
		{"参数会话优先于环境变量", "chrome:ff00ff00", "zen:ab12cd34", "", "", "chrome-01", "ff00ff00"},
		{"显式浏览器优先于会话前缀", "", "zen:ab12cd34", "chrome", "", "chrome-01", "ab12cd34"},
		{"浏览器环境变量优先于会话前缀", "", "zen:ab12cd34", "", "chrome", "chrome-01", "ab12cd34"},
		{"无前缀的旧会话保持原样", "", "0b8f-uuid", "zen", "", "zen-11", "0b8f-uuid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			previousSession, previousBrowser := flagSession, flagBrowser
			flagSession, flagBrowser = test.flagSession, test.flagBrowser
			t.Cleanup(func() { flagSession, flagBrowser = previousSession, previousBrowser })
			t.Setenv("BROWSER_CONTROL_SESSION", test.envSession)
			t.Setenv("BROWSER_CONTROL_BROWSER", test.envBrowser)
			got, err := resolveBrowser(peers)
			if err != nil || got != test.wantBrowser {
				t.Fatalf("resolveBrowser() = %q, %v; want %q", got, err, test.wantBrowser)
			}
			if id := sessionFromFlag(); id != test.wantSession {
				t.Fatalf("sessionFromFlag() = %q, want %q", id, test.wantSession)
			}
		})
	}
}
