package layout

import (
	"fmt"
	"testing"
)

func TestMinimumHeightThreeRowComposerKeepsScrollablePaneGeometry(t *testing.T) {
	tests := []struct {
		width          int
		responseHeight int
	}{
		{width: 40, responseHeight: 2},
		{width: 80, responseHeight: 3},
	}
	for _, test := range tests {
		t.Run(fmt.Sprintf("%dx18", test.width), func(t *testing.T) {
			metrics := Compute(test.width, 18, 3)
			if metrics.ResizeRequired {
				t.Fatalf("%dx18 unexpectedly requires resize", test.width)
			}
			if metrics.Composer.Height != 5 || metrics.Response.Height != test.responseHeight || metrics.Panes.Height < minimumPaneHeightWithLog {
				t.Fatalf("%dx18 did not reserve composer/response/pane geometry: %#v", test.width, metrics)
			}
			if metrics.Rail.Y != 0 || metrics.Panes.Y != metrics.Rail.Height ||
				metrics.Panes.Y+metrics.Panes.Height != metrics.Response.Y ||
				metrics.Response.Y+metrics.Response.Height != metrics.Composer.Y ||
				metrics.Composer.Y+metrics.Composer.Height != 18 {
				t.Fatalf("%dx18 regions are not exact and contiguous: %#v", test.width, metrics)
			}
		})
	}
}
