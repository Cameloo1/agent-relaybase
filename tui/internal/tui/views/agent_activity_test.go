package views

import (
	"fmt"
	"strings"
	"testing"

	"charm.land/lipgloss/v2"
	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
)

func TestRenderAgentTranscriptCompactsAndExpandsOneTool(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	output := []string{}
	for index := 1; index <= 8; index++ {
		output = append(output, fmt.Sprintf("line %d", index))
	}
	item := AgentTranscriptItem{ID: "tool:1", Kind: "tool", State: "completed", Label: "Inspected project", Output: strings.Join(output, "\n"), OutputLineCount: 8}
	compact, regions := renderAgentTranscript(style, ShellData{AgentTranscript: []AgentTranscriptItem{item}, TranscriptSelected: item.ID}, 80)
	plain := compactSnapshot(compact)
	if !strings.Contains(plain, "line 5") || strings.Contains(plain, "line 6") || !strings.Contains(plain, "+3 rows") {
		t.Fatalf("compact transcript = %q", plain)
	}
	if len(regions) != 1 || regions[0].Kind != components.HitAgentTranscript || regions[0].ItemID != item.ID {
		t.Fatalf("tool hit regions = %#v", regions)
	}
	expanded, _ := renderAgentTranscript(style, ShellData{AgentTranscript: []AgentTranscriptItem{item}, TranscriptExpanded: map[string]bool{item.ID: true}}, 80)
	if !strings.Contains(compactSnapshot(expanded), "line 8") {
		t.Fatalf("expanded transcript = %q", compactSnapshot(expanded))
	}
}

func TestOnlyLatestActiveTranscriptItemShimmers(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	items := []AgentTranscriptItem{
		{ID: "tool:1", Kind: "tool", State: "active", Label: "Reading files", Sequence: 1, UpdatedSequence: 1},
		{ID: "processing:2", Kind: "processing", State: "active", Label: "Reviewing tool result", Sequence: 2, UpdatedSequence: 2},
	}
	rendered, _ := renderAgentTranscript(style, ShellData{AgentTranscript: items, ActivityASCII: true, ActivityAnimations: true, ActivityFrame: 0}, 80)
	plain := compactSnapshot(rendered)
	if strings.Count(plain, "=..") != 1 || !strings.Contains(plain, "=.. Reviewing tool result") {
		t.Fatalf("shimmer projection = %q", plain)
	}

	toolOnly, _ := renderAgentTranscript(style, ShellData{
		AgentTranscript: []AgentTranscriptItem{items[0]}, ActivityASCII: true, ActivityAnimations: true,
	}, 80)
	if strings.Contains(compactSnapshot(toolOnly), "=..") {
		t.Fatalf("active tool incorrectly shimmered: %q", compactSnapshot(toolOnly))
	}
}

func TestRenderAgentTranscriptFitsNarrowAndWideWidths(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	data := ShellData{AgentTranscript: []AgentTranscriptItem{{ID: "1", Kind: "tool", State: "active", Label: "Inspecting a project with a deliberately long visible label"}}}
	for _, width := range []int{20, 40, 80} {
		rendered, _ := renderAgentTranscript(style, data, width)
		for _, line := range strings.Split(rendered, "\n") {
			if got := lipgloss.Width(line); got > width {
				t.Fatalf("width %d rendered line width %d: %q", width, got, line)
			}
		}
	}
}

func TestRenderAgentTranscriptWrapsCompleteConversationText(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	message := "This sentence is deliberately longer than the docked Agent pane, and its final words must remain visible after wrapping."
	data := ShellData{AgentTranscript: []AgentTranscriptItem{{
		ID: "assistant:1", Kind: "assistant", State: "completed", Output: message,
	}}}

	for _, width := range []int{28, 72} {
		rendered, _ := renderAgentTranscript(style, data, width)
		plain := compactSnapshot(rendered)
		if !strings.Contains(strings.Join(strings.Fields(plain), " "), "remain visible after wrapping.") {
			t.Fatalf("width %d truncated transcript tail: %q", width, plain)
		}
		for _, line := range strings.Split(rendered, "\n") {
			if got := lipgloss.Width(line); got > width {
				t.Fatalf("width %d rendered line width %d: %q", width, got, line)
			}
		}
	}
}

func TestRenderAgentTranscriptCompactsWrappedToolOutputByVisibleRows(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	output := "A single tool-result line that is intentionally long enough to wrap across considerably more than five visible terminal rows without losing its final words."
	item := AgentTranscriptItem{
		ID: "tool:wrapped", Kind: "tool", State: "completed", Label: "Inspected project",
		Output: output, OutputLineCount: 1,
	}

	compact, _ := renderAgentTranscript(style, ShellData{AgentTranscript: []AgentTranscriptItem{item}}, 24)
	plainCompact := compactSnapshot(compact)
	if !strings.Contains(plainCompact, "+") || strings.Contains(plainCompact, "final words.") {
		t.Fatalf("wrapped compact output did not expose a bounded remainder: %q", plainCompact)
	}
	expanded, _ := renderAgentTranscript(style, ShellData{
		AgentTranscript: []AgentTranscriptItem{item}, TranscriptExpanded: map[string]bool{item.ID: true},
	}, 24)
	if !strings.Contains(strings.Join(strings.Fields(compactSnapshot(expanded)), " "), "final words.") {
		t.Fatalf("expanded wrapped output lost its tail: %q", compactSnapshot(expanded))
	}
}

func TestVirtualizedLongThreadRendersOnlyVisibleWindow(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	items := make([]AgentTranscriptItem, 0, 512)
	for index := 0; index < 512; index++ {
		items = append(items, AgentTranscriptItem{
			ID: fmt.Sprintf("message:%03d", index), Kind: "assistant", State: "completed",
			Output:   fmt.Sprintf("message-%03d remains readable in the virtual transcript window", index),
			Sequence: int64(index + 1), UpdatedSequence: int64(index + 1),
		})
	}
	data := ShellData{AgentTranscript: items, TranscriptCache: NewAgentTranscriptRenderCache()}
	layout := layoutAgentTranscript(data, 44)
	offset := layout.Blocks[300].Start
	frame := renderAgentTranscriptViewport(style, data, 44, 12, offset)
	plain := compactSnapshot(frame.Text)
	if !strings.Contains(plain, "message-300") || strings.Contains(plain, "message-000") || strings.Contains(plain, "message-511") {
		t.Fatalf("virtual window rendered the wrong transcript range: %q", plain)
	}
	if got := len(strings.Split(frame.Text, "\n")); got != 12 {
		t.Fatalf("virtual window rows = %d, want 12", got)
	}
	if frame.TotalRows != layout.TotalRows || len(frame.Text) > 12*200 {
		t.Fatalf("virtual frame escaped bounds: total=%d want=%d bytes=%d", frame.TotalRows, layout.TotalRows, len(frame.Text))
	}
}

func TestVirtualizedExpandedToolRendersMiddleRowsAndHitRegion(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	lines := make([]string, 12_000)
	for index := range lines {
		lines[index] = fmt.Sprintf("tool-row-%05d", index)
	}
	item := AgentTranscriptItem{
		ID: "tool:large", Kind: "tool", State: "completed", Label: "Read project output",
		Output: strings.Join(lines, "\n"), OutputLineCount: len(lines), Sequence: 1, UpdatedSequence: 1,
	}
	data := ShellData{
		AgentTranscript: []AgentTranscriptItem{item}, TranscriptExpanded: map[string]bool{item.ID: true},
		TranscriptCache: NewAgentTranscriptRenderCache(),
	}
	frame := renderAgentTranscriptViewport(style, data, 44, 10, 5_001)
	plain := compactSnapshot(frame.Text)
	if !strings.Contains(plain, "tool-row-05000") || strings.Contains(plain, "tool-row-00000") {
		t.Fatalf("expanded virtual window did not seek to the requested output rows: %q", plain)
	}
	if len(frame.HitRegions) != 1 || frame.HitRegions[0].ItemID != item.ID || frame.HitRegions[0].Rect.Height > 9 {
		t.Fatalf("expanded virtual hit region = %#v", frame.HitRegions)
	}
	if got := len(strings.Split(frame.Text, "\n")); got != 10 {
		t.Fatalf("expanded virtual window rows = %d, want 10", got)
	}
}

func TestAgentTranscriptRowIndexMatchesWrapperAndBoundsWidths(t *testing.T) {
	for _, width := range []int{8, 20, 44} {
		for _, line := range []string{
			"ordinary words wrap on boundaries",
			"  indented words remain indented",
			"tabs\tbecome spaces",
			"supercalifragilisticexpialidocious",
			"Unicode café 世界 remains visible",
			"",
		} {
			if got, want := agentTranscriptLineRowCount(line, width), len(wrapAgentTranscriptLine(line, width)); got != want {
				t.Fatalf("width %d row count for %q = %d, want %d", width, line, got, want)
			}
		}
	}
	cache := NewAgentTranscriptRenderCache()
	item := AgentTranscriptItem{ID: "stable", Kind: "assistant", State: "completed", Output: "one two three", UpdatedSequence: 1}
	for width := 20; width < 30; width++ {
		_ = layoutAgentTranscript(ShellData{AgentTranscript: []AgentTranscriptItem{item}, TranscriptCache: cache}, width)
	}
	if len(cache.widths) != maxAgentTranscriptCachedWidths {
		t.Fatalf("cached widths = %d, want bounded %d", len(cache.widths), maxAgentTranscriptCachedWidths)
	}
	stableCache := NewAgentTranscriptRenderCache()
	first := layoutAgentTranscript(ShellData{AgentTranscript: []AgentTranscriptItem{{ID: "same", Kind: "assistant", State: "completed", Output: "abc", UpdatedSequence: 1}}, TranscriptCache: stableCache}, 20)
	second := layoutAgentTranscript(ShellData{AgentTranscript: []AgentTranscriptItem{{ID: "same", Kind: "assistant", State: "completed", Output: "xyz", UpdatedSequence: 1}}, TranscriptCache: stableCache}, 20)
	if first.Blocks[0].Output.lines[0] != "abc" || second.Blocks[0].Output.lines[0] != "xyz" {
		t.Fatalf("same-length content replacement reused stale cache: first=%q second=%q", first.Blocks[0].Output.lines, second.Blocks[0].Output.lines)
	}
}

func TestResponseOffsetForOversizedExpandedToolKeepsHeaderVisible(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	item := AgentTranscriptItem{
		ID: "tool:large", Kind: "tool", State: "completed", Label: "Read output",
		Output: strings.Repeat("line\n", 1_000), OutputLineCount: 1_000, Sequence: 1, UpdatedSequence: 1,
	}
	data := ShellData{
		Width: 160, Height: 40, ComposerRows: 1, AgentPaneExpanded: true, ResponseOffset: 500,
		AgentTranscript: []AgentTranscriptItem{item}, TranscriptExpanded: map[string]bool{item.ID: true},
		TranscriptCache: NewAgentTranscriptRenderCache(),
	}
	if got := ResponseOffsetForTranscriptItem(style, data, item.ID); got != 0 {
		t.Fatalf("oversized selected tool offset = %d, want its header at 0", got)
	}
}

func TestVirtualizedTranscriptMatchesBoundedFullProjection(t *testing.T) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	items := []AgentTranscriptItem{
		{ID: "user:1", Kind: "user", State: "completed", Output: "Please inspect this project.", Sequence: 1, UpdatedSequence: 1},
		{ID: "tool:1", Kind: "tool", State: "completed", Label: "Inspected project", Output: "one\ntwo\nthree\nfour\nfive\nsix", OutputLineCount: 6, Sequence: 2, UpdatedSequence: 3},
		{ID: "assistant:1", Kind: "assistant", State: "completed", Output: "The project is ready.", Sequence: 4, UpdatedSequence: 4},
	}
	data := ShellData{AgentTranscript: items, TranscriptSelected: "tool:1", TranscriptCache: NewAgentTranscriptRenderCache()}
	full, fullRegions := renderAgentTranscript(style, data, 60)
	layout := layoutAgentTranscript(data, 60)
	virtual := renderAgentTranscriptViewport(style, data, 60, layout.TotalRows, 0)
	if compactSnapshot(virtual.Text) != compactSnapshot(full) {
		t.Fatalf("virtual projection diverged from bounded transcript:\nvirtual=%q\nfull=%q", compactSnapshot(virtual.Text), compactSnapshot(full))
	}
	if len(virtual.HitRegions) != len(fullRegions) || len(virtual.HitRegions) != 1 || virtual.HitRegions[0].ItemID != "tool:1" {
		t.Fatalf("virtual/full hit regions differ: virtual=%#v full=%#v", virtual.HitRegions, fullRegions)
	}
}
