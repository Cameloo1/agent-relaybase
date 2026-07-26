// Package layout projects an operator-console terminal into explicit regions.
// Rendering and hit testing consume the same projection.
package layout

import "github.com/cameloo/relaybase/tui/internal/tui/components"

const (
	minimumPaneHeightWithLog = 9
	minimumAgentWidth        = 36
	minimumWorkspaceWidth    = 80
)

type Options struct {
	AgentExpanded bool
}

type Mode string

const (
	Wide        Mode = "wide"
	Medium      Mode = "medium"
	Narrow      Mode = "narrow"
	Constrained Mode = "constrained"
)

type Metrics struct {
	Bounds         components.Rect
	Mode           Mode
	ResizeRequired bool
	Rail           components.Rect
	Panes          components.Rect
	Agent          components.Rect
	AgentDockable  bool
	AgentDocked    bool
	Composer       components.Rect
	PaletteAnchor  components.Rect
	Modal          components.Rect
}

// Compute projects the default operator shell, where the Agent surface is
// expanded whenever the terminal can preserve both sides of the dock.
func Compute(width, height, composerRows int) Metrics {
	return ComputeWithOptions(width, height, composerRows, Options{AgentExpanded: true})
}

// ComputeWithOptions is the only layout arithmetic for the operator shell.
// The Agent divider is part of its exact one-third allocation.
func ComputeWithOptions(width, height, composerRows int, options Options) Metrics {
	if width < 1 {
		width = 1
	}
	if height < 1 {
		height = 1
	}
	metrics := Metrics{Bounds: components.Rect{Width: width, Height: height}}
	if width < 40 || height < 18 {
		metrics.Mode = Constrained
		metrics.ResizeRequired = true
		metrics.Modal = metrics.Bounds
		return metrics
	}
	switch {
	case width >= 120 && height >= 32:
		metrics.Mode = Wide
	case width >= 80:
		metrics.Mode = Medium
	default:
		metrics.Mode = Narrow
	}
	if composerRows < 1 {
		composerRows = 1
	}
	if composerRows > 3 {
		composerRows = 3
	}
	railHeight := 1
	if metrics.Mode == Narrow {
		railHeight = 2
	}
	metrics.Composer = components.Rect{Y: height - composerRows - 2, Width: width, Height: composerRows + 2}

	agentWidth := width / 3
	workspaceWidth := width - agentWidth
	metrics.AgentDockable = agentWidth >= minimumAgentWidth && workspaceWidth >= minimumWorkspaceWidth
	if options.AgentExpanded && metrics.AgentDockable {
		metrics.AgentDocked = true
		metrics.Agent = components.Rect{
			X:      workspaceWidth,
			Width:  agentWidth,
			Height: metrics.Composer.Y,
		}
	} else {
		workspaceWidth = width
	}

	metrics.Rail = components.Rect{Width: workspaceWidth, Height: railHeight}
	metrics.Panes = components.Rect{
		Y:      metrics.Rail.Height,
		Width:  workspaceWidth,
		Height: metrics.Composer.Y - metrics.Rail.Height,
	}
	metrics.PaletteAnchor = components.Rect{Y: max(metrics.Rail.Height, metrics.Composer.Y-6), Width: width}
	modalWidth := width - 4
	modalHeight := min(height-4, max(8, height*2/3))
	metrics.Modal = components.Rect{X: max(0, (width-modalWidth)/2), Y: max(1, (height-modalHeight)/2), Width: modalWidth, Height: modalHeight}
	return metrics
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
func max(left, right int) int {
	if left > right {
		return left
	}
	return right
}
