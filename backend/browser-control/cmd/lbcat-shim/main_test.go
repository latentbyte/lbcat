package main

import "testing"

func TestMatchBrowserNameComet(t *testing.T) {
	t.Parallel()

	got := matchBrowserName("/Applications/Comet.app/Contents/MacOS/Comet")
	if got != "comet" {
		t.Fatalf("matchBrowserName(Comet) = %q, want comet", got)
	}
}
