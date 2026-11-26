package home

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ploenk42/striker/striker/internal/status"
)

// Repo is the working copy around the Striker directory: where Striker's own Claude starts.
func TestRepo(t *testing.T) {
	t.Setenv("STRIKER_HOME", filepath.Join("/Users", "p", "dev", "striker", "striker"))
	if got, want := Repo(), filepath.Join("/Users", "p", "dev", "striker"); got != want {
		t.Errorf("Repo() = %q, want %q", got, want)
	}
}

// /status names that working copy, so the LCARS mod can start Striker there.
func TestReportStrikerRepo(t *testing.T) {
	b, _ := json.Marshal(status.Report{StrikerRepo: "/Users/p/dev/striker"})
	if !strings.Contains(string(b), `"striker_repo":"/Users/p/dev/striker"`) {
		t.Errorf("report JSON lacks striker_repo: %s", b)
	}
}
