package response

import (
	"strings"
	"testing"
)

func TestSafeMarkdownStripsTerminalActionsAndMakesLinksInert(t *testing.T) {
	rendered := (SafeMarkdownRenderer{}).Render("# Heading\n[click](javascript:alert(1))\nhttps://example.test/?token=secret\n\x1b]52;c;secret\a\u009bstill-not-text", 60)
	if strings.Contains(rendered.Text, "\x1b") || strings.Contains(rendered.Text, "secret") || strings.Contains(rendered.Text, "javascript:") {
		t.Fatalf("unsafe markdown survived: %q", rendered.Text)
	}
	if strings.Contains(rendered.Text, "\u009b") {
		t.Fatalf("C1 terminal control survived: %q", rendered.Text)
	}
	if !strings.Contains(rendered.Text, "URL:") || !strings.Contains(rendered.Text, "https://example.test/?token=[redacted]") {
		t.Fatalf("expected a useful but redacted inert destination: %q", rendered.Text)
	}
}

func TestSanitizeMarkdownShowsOnlySafeInertDestinations(t *testing.T) {
	sanitized := SanitizeMarkdown("[docs](https://user:pass@example.test/path?api_key=abc&mode=read#frag) mailto:hello@example.test?subject=Hi [bad](javascript:alert(1))")
	for _, forbidden := range []string{"user:pass", "abc", "#frag", "javascript:"} {
		if strings.Contains(sanitized, forbidden) {
			t.Fatalf("unsafe URL data survived: %q", sanitized)
		}
	}
	for _, expected := range []string{"docs [URL: https://example.test/path?api_key=[redacted]&mode=read]", "[URL: mailto:hello@example.test?subject=Hi]", "bad [URL: unavailable]"} {
		if !strings.Contains(sanitized, expected) {
			t.Fatalf("missing %q in %q", expected, sanitized)
		}
	}
}

func TestSanitizeTerminalTextRemovesCSI_OSC_C1AndKeepsLines(t *testing.T) {
	value := SanitizeTerminalText("one\n\x1b[31mtwo\x1b[0m\x1b]52;c;payload\a\u009bhidden")
	if value != "one\ntwohidden" {
		t.Fatalf("unexpected sanitized terminal text: %q", value)
	}
}

func TestResponseKeepsIndependentFollowState(t *testing.T) {
	model := New(40, 3)
	model.SetSource("one\ntwo\nthree\nfour\nfive")
	model.ScrollUp(2)
	if model.Following() {
		t.Fatal("manual upward scroll must disable follow")
	}
	model.SetSource("one\ntwo\nthree\nfour\nfive\nsix")
	if model.NewOutputCount() != 1 {
		t.Fatalf("expected unread indicator, got %d", model.NewOutputCount())
	}
	model.SetFollow(true)
	if !model.Following() || model.NewOutputCount() != 0 {
		t.Fatalf("expected explicit follow to clear indicator")
	}
}

func TestCodeBlocksUseSanitizedSourceOnly(t *testing.T) {
	blocks := CodeBlocks("```go\nfmt.Println(\"ok\")\n```\n\x1b]52;c;secret\a")
	if len(blocks) != 1 || strings.Contains(blocks[0], "\x1b") || blocks[0] != `fmt.Println("ok")` {
		t.Fatalf("unexpected sanitized code blocks: %#v", blocks)
	}
}
