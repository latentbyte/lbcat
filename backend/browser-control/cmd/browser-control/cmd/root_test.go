package cmd

import (
	"reflect"
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
