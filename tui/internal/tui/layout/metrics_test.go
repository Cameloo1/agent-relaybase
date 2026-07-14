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
		if metrics.Panes.Y != metrics.Rail.Height || metrics.Panes.Y+metrics.Panes.Height != metrics.Composer.Y {
			t.Fatalf("%dx%d workspace regions overlap or leave a gap: %#v", size[0], size[1], metrics)
		}
		if metrics.AgentDocked {
			if metrics.Agent.X != metrics.Panes.Width || metrics.Agent.X+metrics.Agent.Width != size[0] || metrics.Agent.Height != metrics.Composer.Y {
				t.Fatalf("%dx%d Agent dock is not exact: %#v", size[0], size[1], metrics)
			}
		} else if metrics.Panes.Width != size[0] || metrics.Agent.Valid() {
			t.Fatalf("%dx%d fallback did not retain the full workspace: %#v", size[0], size[1], metrics)
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

func TestComputeAgentDockUsesExactOneThirdIncludingDivider(t *testing.T) {
	for _, width := range []int{119, 120, 121, 159, 160, 161, 200} {
		metrics := Compute(width, 40, 1)
		if !metrics.AgentDockable || !metrics.AgentDocked {
			t.Fatalf("width %d should support the Agent dock: %#v", width, metrics)
		}
		if metrics.Agent.Width != width/3 || metrics.Panes.Width != width-width/3 || metrics.Agent.X != metrics.Panes.Width {
			t.Fatalf("width %d did not use the exact one-third split: %#v", width, metrics)
		}
		if metrics.Agent.Width+metrics.Panes.Width != width {
			t.Fatalf("width %d left a gap or overlap: %#v", width, metrics)
		}
	}
}

func TestComputeAgentDockFallsBackOrCollapsesWithoutShrinkingWorkspace(t *testing.T) {
	fallback := Compute(118, 32, 1)
	if fallback.AgentDockable || fallback.AgentDocked || fallback.Panes.Width != 118 || fallback.Agent.Valid() {
		t.Fatalf("118 columns should use modal fallback: %#v", fallback)
	}
	collapsed := ComputeWithOptions(160, 40, 1, Options{AgentExpanded: false})
	if !collapsed.AgentDockable || collapsed.AgentDocked || collapsed.Panes.Width != 160 || collapsed.Agent.Valid() {
		t.Fatalf("collapsed dock should return the full workspace: %#v", collapsed)
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
