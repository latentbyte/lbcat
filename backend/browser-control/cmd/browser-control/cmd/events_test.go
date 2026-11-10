package cmd

import (
	"reflect"
	"testing"

	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
)

func TestParseEventTypes(t *testing.T) {
	t.Parallel()

	got, err := parseEventTypes("tab-focused, tab-removed, browser-connected")
	if err != nil {
		t.Fatalf("parseEventTypes() error = %v", err)
	}
	want := []model.EventType{model.EventTypeTabFocused, model.EventTypeTabRemoved, model.EventTypeBrowserConnected}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseEventTypes() = %#v, want %#v", got, want)
	}
}

func TestParseEventTypesRejectsUnknown(t *testing.T) {
	t.Parallel()

	if _, err := parseEventTypes("wat"); err == nil {
		t.Fatal("parseEventTypes() error = nil, want error")
	}
}
