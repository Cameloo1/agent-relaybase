package layout

import "testing"

func TestComputeSupportedSizesAreExactAndNonOverlapping(t *testing.T) {
	for _, size := range [][2]int{{160, 48}, {120, 32}, {100, 30}, {80, 24}, {60, 24}, {40, 18}} {
		metrics := Compute(size[0], size[1], 3)
		if metrics.ResizeRequired {
			t.Fatalf("%dx%d unexpectedly requires resize", size[0], size[1])
		}
		if metrics.Rail.Y != 0 || metrics.Composer.Y+metrics.Composer.Height != size[1] {
			t.Fatalf("%dx%d did not anchor rail/composer: %#v", size[0], size[1], metrics)
		}
		if metrics.Panes.Y+metrics.Panes.Height != metrics.Response.Y || metrics.Response.Y+metrics.Response.Height != metrics.Composer.Y {
			t.Fatalf("%dx%d regions overlap or leave a gap: %#v", size[0], size[1], metrics)
		}
	}
}

func TestComputeUsesOneRailRowUnlessNarrowNeedsTwo(t *testing.T) {
	for _, width := range []int{160, 120, 100, 80} {
		if got := Compute(width, 32, 1).Rail.Height; got != 1 {
			t.Fatalf("width %d rail height = %d, want 1", width, got)
		}
	}
	for _, width := range []int{79, 60, 40} {
		if got := Compute(width, 24, 1).Rail.Height; got != 2 {
			t.Fatalf("width %d rail height = %d, want 2", width, got)
		}
	}
}

func TestComputeConstrainedProjection(t *testing.T) {
	for _, size := range [][2]int{{39, 17}, {1, 1}} {
		metrics := Compute(size[0], size[1], 1)
		if !metrics.ResizeRequired || metrics.Mode != Constrained || metrics.Modal != metrics.Bounds {
			t.Fatalf("expected constrained recovery for %#v, got %#v", size, metrics)
		}
	}
}
