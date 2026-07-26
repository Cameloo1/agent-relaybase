package panes

import (
	"strings"
	"testing"
)

func TestViewportOffsetTranslationIsBottomRelativeAndClamped(t *testing.T) {
	tests := []struct {
		name        string
		lineCount   int
		height      int
		manager     int
		wantTop     int
		wantManager int
	}{
		{name: "follow bottom", lineCount: 20, height: 5, manager: 0, wantTop: 15, wantManager: 0},
		{name: "five older", lineCount: 20, height: 5, manager: 5, wantTop: 10, wantManager: 5},
		{name: "oldest clamp", lineCount: 20, height: 5, manager: 100, wantTop: 0, wantManager: 15},
		{name: "short content", lineCount: 3, height: 5, manager: 4, wantTop: 0, wantManager: 0},
		{name: "negative input", lineCount: 20, height: 5, manager: -2, wantTop: 15, wantManager: 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			top := TopYOffsetFromManagerOffset(test.lineCount, test.height, test.manager)
			if top != test.wantTop {
				t.Fatalf("top=%d, want %d", top, test.wantTop)
			}
			manager := ManagerOffsetFromTopYOffset(test.lineCount, test.height, top)
			if manager != test.wantManager {
				t.Fatalf("manager=%d, want %d", manager, test.wantManager)
			}
		})
	}
}

func TestProjectLogViewportUsesBubblesAsPureProjection(t *testing.T) {
	lines := make([]PaneLogLine, 0, 10)
	for index := 1; index <= 10; index++ {
		lines = append(lines, PaneLogLine{Sequence: int64(index), Text: string(rune('a' + index - 1)), Tone: LogToneNeutral})
	}

	projection := ProjectLogViewport(lines, 8, 3, 2)
	if projection.TopYOffset != 5 || projection.ManagerScrollOffset != 2 {
		t.Fatalf("unexpected offsets: %#v", projection)
	}
	if len(projection.Lines) != 3 || projection.Lines[0].Sequence != 6 || projection.Lines[2].Sequence != 8 {
		t.Fatalf("unexpected visible typed lines: %#v", projection.Lines)
	}
	if !strings.Contains(projection.Text, "f") || !strings.Contains(projection.Text, "h") {
		t.Fatalf("Bubbles viewport text omitted projected lines: %q", projection.Text)
	}

	if again := ProjectLogViewport(lines, 8, 3, 2); again.TopYOffset != projection.TopYOffset || again.ManagerScrollOffset != projection.ManagerScrollOffset {
		t.Fatalf("pure projection was not deterministic: first=%#v second=%#v", projection, again)
	}
}
