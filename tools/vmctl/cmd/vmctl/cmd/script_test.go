package cmd

import (
	"strings"
	"testing"
)

func TestScriptPushAllRequiresExplicitPath(t *testing.T) {
	t.Parallel()

	err := scriptPushAllCmd.Args(scriptPushAllCmd, nil)
	if err == nil {
		t.Fatal("expected missing path arg to fail")
	}
	if !strings.Contains(err.Error(), "accepts 1 arg(s), received 0") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestParsePushResponse(t *testing.T) {
	t.Parallel()

	resp, err := parsePushResponse([]byte(`{"data":{"uuid":"abc-123","isNew":true,"errors":["warn"]}}`))
	if err != nil {
		t.Fatalf("parsePushResponse returned error: %v", err)
	}
	if resp.Data.UUID != "abc-123" {
		t.Fatalf("expected uuid abc-123, got %s", resp.Data.UUID)
	}
	if !resp.Data.IsNew {
		t.Fatal("expected isNew to be true")
	}
	if len(resp.Data.Errors) != 1 {
		t.Fatalf("expected 1 error, got %d", len(resp.Data.Errors))
	}
}

func TestCollectPushStatsCountsCreatedAndUpdated(t *testing.T) {
	t.Parallel()

	stats := collectPushStats([]pushResult{
		{Success: true, IsNew: true},
		{Success: true, IsNew: false},
		{Success: true, IsNew: false},
		{Success: false},
	})
	if stats.Created != 1 {
		t.Fatalf("expected 1 created result, got %d", stats.Created)
	}
	if stats.Updated != 2 {
		t.Fatalf("expected 2 updated results, got %d", stats.Updated)
	}
	if stats.Completed != 3 {
		t.Fatalf("expected 3 completed results, got %d", stats.Completed)
	}
	if stats.Failed != 1 {
		t.Fatalf("expected 1 failed result, got %d", stats.Failed)
	}
}
