package prs

import (
	"encoding/json"
	"strconv"

	"github.com/ploenk42/striker/striker/internal/issues"
	"github.com/ploenk42/striker/striker/internal/lead"
	"github.com/ploenk42/striker/striker/internal/status"
)

// Notifier tells a repo's leads that one of its PRs left the open list: Gone asks gh whether it was merged or
// closed and sends each lead a "[Striker] …" message, so a merge done on GitHub reaches the lead's needs_you.
// A PR still open (it only fell out of the list window), a failing gh or no lead sends nothing.
type Notifier struct {
	GH   issues.GH
	Send func(addr, text string) error
	Logf func(format string, args ...any)
}

func (n *Notifier) Gone(slug string, pr status.PR, leads []string) {
	if len(leads) == 0 {
		n.logf("prs: PR #%d in %s left the open list, no lead to tell", pr.Number, slug)
		return
	}
	out, err := n.GH.Run("", "pr", "view", strconv.Itoa(pr.Number), "-R", slug, "--json", "state")
	var v struct {
		State string `json:"state"`
	}
	if err == nil {
		err = json.Unmarshal(out, &v)
	}
	if err != nil {
		n.logf("prs: gh pr view %d -R %s: %v", pr.Number, slug, err)
		return
	}
	var what string
	switch v.State {
	case "MERGED":
		what = "ist gemergt"
	case "CLOSED":
		what = "ist geschlossen, nicht gemergt"
	default:
		return
	}
	text := lead.Message("PR #" + strconv.Itoa(pr.Number) + " (" + pr.Branch + ") in " + slug + " " + what +
		". Steht er in deinem needs_you, trag ihn aus.")
	for _, addr := range leads {
		if err := n.Send(addr, text); err != nil {
			n.logf("prs: send to %s: %v", addr, err)
		}
	}
}

func (n *Notifier) logf(format string, args ...any) {
	if n.Logf != nil {
		n.Logf(format, args...)
	}
}
