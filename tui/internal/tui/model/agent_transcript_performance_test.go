package model

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/views"
)

func BenchmarkCtrlGScrollLongAgentTranscript(b *testing.B) {
	root := newTestModelWithPanesInStateDir(b.TempDir(), 3)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	root = updated.(RootModel)
	root.preferences.Layout.AgentPaneCollapsed = false
	root.responseFollow = false
	root.agentTranscript = make([]views.AgentTranscriptItem, 0, 512)
	for index := 0; index < 512; index++ {
		root.agentTranscript = append(root.agentTranscript, views.AgentTranscriptItem{
			ID: fmt.Sprintf("scroll:%d", index), Kind: "assistant", State: "completed",
			Output:   strings.Repeat(fmt.Sprintf("response %d remains readable while the dock scrolls. ", index), 4),
			Sequence: int64(index + 1), UpdatedSequence: int64(index + 1),
		})
	}
	root.responseOffset = 2_000
	_ = views.BuildShell(root.styles, root.shellData())
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		root.responseOffset = 2_000
		root.scrollResponse(3)
		_ = views.BuildShell(root.styles, root.shellData())
	}
}

func BenchmarkCtrlGScrollExpandedToolResult(b *testing.B) {
	root := newTestModelWithPanesInStateDir(b.TempDir(), 3)
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 160, Height: 40})
	root = updated.(RootModel)
	root.preferences.Layout.AgentPaneCollapsed = false
	root.responseFollow = false
	lines := make([]string, 12_000)
	for index := range lines {
		lines[index] = fmt.Sprintf("expanded tool row %05d remains virtualized", index)
	}
	root.agentTranscript = []views.AgentTranscriptItem{{
		ID: "tool:expanded", Kind: "tool", State: "completed", Label: "Read output",
		Output: strings.Join(lines, "\n"), OutputLineCount: len(lines), Sequence: 1, UpdatedSequence: 1,
	}}
	root.agentTranscriptExpanded["tool:expanded"] = true
	root.responseOffset = 5_000
	_ = views.BuildShell(root.styles, root.shellData())
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		root.responseOffset = 5_000
		root.scrollResponse(3)
		_ = views.BuildShell(root.styles, root.shellData())
	}
}
