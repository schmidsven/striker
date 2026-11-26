package prs

import (
	"errors"
	"reflect"
	"testing"

	"github.com/ploenk42/striker/striker/internal/status"
)

type sent struct{ addr, text string }

func notifier(gh *fakeGH, out *[]sent) *Notifier {
	return &Notifier{GH: gh, Send: func(addr, text string) error { *out = append(*out, sent{addr, text}); return nil }}
}

var pr29 = status.PR{Number: 29, Title: "a", URL: "u29", Branch: "feature/a"}

func TestNoticeMerged(t *testing.T) {
	gh := &fakeGH{out: `{"state":"MERGED"}`}
	var got []sent
	notifier(gh, &got).Gone("o/r", pr29, []string{"t1"})
	want := []sent{{"t1", "[Striker] PR #29 (feature/a) in o/r ist gemergt. Steht er in deinem needs_you, trag ihn aus."}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sent = %+v, want %+v", got, want)
	}
	call := []string{"", "pr", "view", "29", "-R", "o/r", "--json", "state"}
	if len(gh.calls) != 1 || !reflect.DeepEqual(gh.calls[0], call) {
		t.Fatalf("gh calls = %q, want %q", gh.calls, call)
	}
}

func TestNoticeClosed(t *testing.T) {
	var got []sent
	notifier(&fakeGH{out: `{"state":"CLOSED"}`}, &got).Gone("o/r", pr29, []string{"t1"})
	want := []sent{{"t1", "[Striker] PR #29 (feature/a) in o/r ist geschlossen, nicht gemergt. Steht er in deinem needs_you, trag ihn aus."}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sent = %+v, want %+v", got, want)
	}
}

func TestNoticeStillOpen(t *testing.T) {
	var got []sent
	notifier(&fakeGH{out: `{"state":"OPEN"}`}, &got).Gone("o/r", pr29, []string{"t1"})
	if len(got) != 0 {
		t.Fatalf("sent for an open PR: %+v", got)
	}
}

func TestNoticeGhError(t *testing.T) {
	var got []sent
	notifier(&fakeGH{err: errors.New("gh: boom")}, &got).Gone("o/r", pr29, []string{"t1"})
	if len(got) != 0 {
		t.Fatalf("sent after gh error: %+v", got)
	}
}

func TestNoticeNoLeads(t *testing.T) {
	gh := &fakeGH{out: `{"state":"MERGED"}`}
	var got []sent
	notifier(gh, &got).Gone("o/r", pr29, nil)
	if len(got) != 0 || len(gh.calls) != 0 {
		t.Fatalf("no leads: sent %+v, gh calls %q", got, gh.calls)
	}
}

func TestNoticeTwoLeads(t *testing.T) {
	var got []sent
	notifier(&fakeGH{out: `{"state":"MERGED"}`}, &got).Gone("o/r", pr29, []string{"t1", "remote1/t2"})
	if len(got) != 2 || got[0].addr != "t1" || got[1].addr != "remote1/t2" {
		t.Fatalf("sent = %+v", got)
	}
}
