package layout

import (
	"fmt"
	"testing"
)

func TestMinimumHeightThreeRowComposerKeepsScrollablePaneGeometry(t *testing.T) {
	for _, width := range []int{40, 80, 119, 160} {
		t.Run(fmt.Sprintf("%dx18", width), func(t *testing.T) {
			metrics := Compute(width, 18, 3)
			if metrics.ResizeRequired {
				t.Fatalf("%dx18 unexpectedly requires resize", width)
			}
			if metrics.Composer.Height != 5 || metrics.Panes.Height < minimumPaneHeightWithLog {
				t.Fatalf("%dx18 did not reserve composer/pane geometry: %#v", width, metrics)
			}
			if metrics.Rail.Y != 0 || metrics.Panes.Y != metrics.Rail.Height ||
				metrics.Panes.Y+metrics.Panes.Height != metrics.Composer.Y ||
				metrics.Composer.Y+metrics.Composer.Height != 18 {
				t.Fatalf("%dx18 regions are not exact and contiguous: %#v", width, metrics)
			}
		})
	}
}
