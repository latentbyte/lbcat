package cmd

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestExtractUserDataDir(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		line string
		want string
	}{
		{
			name: "equals syntax",
			line: `/Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/Volumes/joda/apps/hzare/chromium --remote-debugging-port=9222`,
			want: `/Volumes/joda/apps/hzare/chromium`,
		},
		{
			name: "space separated quoted syntax",
			line: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir "/Users/test/Chrome Profile"`,
			want: `/Users/test/Chrome Profile`,
		},
		{
			name: "space separated single quoted syntax",
			line: `/usr/bin/chromium --user-data-dir '/tmp/chromium dev' --flag`,
			want: `/tmp/chromium dev`,
		},
		{
			name: "missing flag",
			line: `/Applications/Chromium.app/Contents/MacOS/Chromium --remote-debugging-port=9222`,
			want: ``,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := extractUserDataDir(tt.line); got != tt.want {
				t.Fatalf("extractUserDataDir() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestChromeProfileManifestDirsFromLines(t *testing.T) {
	t.Parallel()

	lines := []string{
		`/Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/Volumes/joda/apps/hzare/chromium --remote-debugging-port=9222`,
		`/Applications/Chromium.app/Contents/Frameworks/Chromium Framework.framework/Versions/145.0.7632.159/Helpers/Chromium Helper (Renderer).app/Contents/MacOS/Chromium Helper (Renderer) --type=renderer --user-data-dir=/Volumes/joda/apps/hzare/chromium --remote-debugging-port=9222`,
		`/Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir="/Volumes/joda/apps/hzare/chromium alt" --remote-debugging-port=9223`,
		`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/test/chrome`,
		`/usr/bin/ungoogled-chromium --user-data-dir='/srv/ungoogled profile'`,
	}

	want := []string{
		filepath.Clean(`/Volumes/joda/apps/hzare/chromium/NativeMessagingHosts`),
		filepath.Clean(`/Volumes/joda/apps/hzare/chromium alt/NativeMessagingHosts`),
		filepath.Clean(`/srv/ungoogled profile/NativeMessagingHosts`),
	}

	got := chromeProfileManifestDirsFromLines("chromium", lines)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("chromeProfileManifestDirsFromLines() = %#v, want %#v", got, want)
	}
}

func TestChromeProfileManifestDirsFromLinesIgnoresOtherBrowsers(t *testing.T) {
	t.Parallel()

	lines := []string{
		`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/test/chrome`,
		`/Applications/Chromium.app/Contents/MacOS/Chromium --user-data-dir=/Users/test/chromium`,
	}

	want := []string{
		filepath.Clean(`/Users/test/chrome/NativeMessagingHosts`),
	}

	got := chromeProfileManifestDirsFromLines("chrome", lines)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("chromeProfileManifestDirsFromLines() = %#v, want %#v", got, want)
	}
}

func TestFindDevChromeIDsInPreferences(t *testing.T) {
	t.Parallel()

	tmpDir := t.TempDir()
	distPath := filepath.Join(tmpDir, "dist")
	if err := os.MkdirAll(distPath, 0o755); err != nil {
		t.Fatalf("MkdirAll(dist) failed: %v", err)
	}

	prefsPath := filepath.Join(tmpDir, "Secure Preferences")
	prefs := `{
  "extensions": {
    "settings": {
      "jpdgdnbodkkeokfekmmabgecbgnjhgkj": {
        "location": 4,
        "path": "` + filepath.ToSlash(distPath) + `"
      },
      "otherdevextid": {
        "location": 4,
        "path": "/tmp/somewhere-else"
      },
      "storeextid": {
        "location": 1,
        "path": "` + filepath.ToSlash(distPath) + `"
      }
    }
  }
}`
	if err := os.WriteFile(prefsPath, []byte(prefs), 0o644); err != nil {
		t.Fatalf("WriteFile(Secure Preferences) failed: %v", err)
	}

	got, err := findDevChromeIDsInPreferences(prefsPath, []string{distPath})
	if err != nil {
		t.Fatalf("findDevChromeIDsInPreferences() error = %v", err)
	}

	want := []string{"jpdgdnbodkkeokfekmmabgecbgnjhgkj"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("findDevChromeIDsInPreferences() = %#v, want %#v", got, want)
	}
}
