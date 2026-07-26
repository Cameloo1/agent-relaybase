package views

import (
	"fmt"
	"strings"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/tui/styles"
)

func BenchmarkRenderAgentTranscriptLongThread(b *testing.B) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	items := make([]AgentTranscriptItem, 0, 512)
	for index := 0; index < 512; index++ {
		kind := "assistant"
		label := ""
		if index%3 == 1 {
			kind = "tool"
			label = "Inspected project"
		}
		items = append(items, AgentTranscriptItem{
			ID: fmt.Sprintf("item:%d", index), Kind: kind, State: "completed", Label: label,
			Output:   strings.Repeat(fmt.Sprintf("thread item %d has enough text to wrap inside the narrow Agent dock. ", index), 4),
			Sequence: int64(index + 1), UpdatedSequence: int64(index + 1),
		})
	}
	data := ShellData{AgentTranscript: items, TranscriptExpanded: map[string]bool{}}
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		_, _ = renderAgentTranscript(style, data, 44)
	}
}

func BenchmarkRenderAgentTranscriptExpandedTool(b *testing.B) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	lines := make([]string, 12_000)
	for index := range lines {
		lines[index] = fmt.Sprintf("tool output row %05d with enough content to wrap in the dock", index)
	}
	item := AgentTranscriptItem{
		ID: "tool:large", Kind: "tool", State: "completed", Label: "Inspected project",
		Output: strings.Join(lines, "\n"), OutputLineCount: len(lines), Sequence: 1, UpdatedSequence: 1,
	}
	data := ShellData{
		AgentTranscript:    []AgentTranscriptItem{item},
		TranscriptExpanded: map[string]bool{item.ID: true},
	}
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		_, _ = renderAgentTranscript(style, data, 44)
	}
}

func BenchmarkRenderAgentResponseLongThreadScroll(b *testing.B) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	items := make([]AgentTranscriptItem, 0, 512)
	for index := 0; index < 512; index++ {
		items = append(items, AgentTranscriptItem{
			ID: fmt.Sprintf("scroll:%d", index), Kind: "assistant", State: "completed",
			Output:   strings.Repeat(fmt.Sprintf("response %d remains readable while the transcript scrolls. ", index), 4),
			Sequence: int64(index + 1), UpdatedSequence: int64(index + 1),
		})
	}
	data := ShellData{AgentTranscript: items, ResponseOffset: 2_000, TranscriptCache: NewAgentTranscriptRenderCache()}
	_ = renderAgentResponseFrame(style, data, 44, 32)
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		_ = renderAgentResponseFrame(style, data, 44, 32)
	}
}

func BenchmarkRenderAgentResponseExpandedToolScroll(b *testing.B) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	lines := make([]string, 12_000)
	for index := range lines {
		lines[index] = fmt.Sprintf("expanded tool row %05d with enough content to wrap in the dock", index)
	}
	item := AgentTranscriptItem{
		ID: "tool:expanded-scroll", Kind: "tool", State: "completed", Label: "Read project output",
		Output: strings.Join(lines, "\n"), OutputLineCount: len(lines), Sequence: 1, UpdatedSequence: 1,
	}
	data := ShellData{
		AgentTranscript: []AgentTranscriptItem{item}, ResponseOffset: 10_000,
		TranscriptExpanded: map[string]bool{item.ID: true}, TranscriptCache: NewAgentTranscriptRenderCache(),
	}
	_ = renderAgentResponseFrame(style, data, 44, 32)
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		_ = renderAgentResponseFrame(style, data, 44, 32)
	}
}

func BenchmarkRenderAgentResponseLongThreadColdOpen(b *testing.B) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	items := make([]AgentTranscriptItem, 0, 512)
	for index := 0; index < 512; index++ {
		items = append(items, AgentTranscriptItem{
			ID: fmt.Sprintf("cold:%d", index), Kind: "assistant", State: "completed",
			Output:   strings.Repeat(fmt.Sprintf("cold response %d is indexed when the Agent pane opens. ", index), 4),
			Sequence: int64(index + 1), UpdatedSequence: int64(index + 1),
		})
	}
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		data := ShellData{AgentTranscript: items, ResponseOffset: 2_000, TranscriptCache: NewAgentTranscriptRenderCache()}
		_ = renderAgentResponseFrame(style, data, 44, 32)
	}
}

func BenchmarkRenderAgentResponseExpandedToolColdOpen(b *testing.B) {
	theme, _ := styles.ResolveTheme("dark", func(string) string { return "" })
	style := styles.New(theme)
	lines := make([]string, 12_000)
	for index := range lines {
		lines[index] = fmt.Sprintf("cold expanded tool row %05d with enough content to wrap", index)
	}
	item := AgentTranscriptItem{
		ID: "tool:cold", Kind: "tool", State: "completed", Label: "Read project output",
		Output: strings.Join(lines, "\n"), OutputLineCount: len(lines), Sequence: 1, UpdatedSequence: 1,
	}
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		data := ShellData{
			AgentTranscript: []AgentTranscriptItem{item}, ResponseOffset: 10_000,
			TranscriptExpanded: map[string]bool{item.ID: true}, TranscriptCache: NewAgentTranscriptRenderCache(),
		}
		_ = renderAgentResponseFrame(style, data, 44, 32)
	}
}
