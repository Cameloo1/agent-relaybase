// Package layout projects an operator-console terminal into explicit regions.
// Rendering and hit testing consume the same projection.
package layout

import "github.com/cameloo/relaybase/tui/internal/tui/components"

const minimumPaneHeightWithLog = 9

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
	Response       components.Rect
	Composer       components.Rect
	PaletteAnchor  components.Rect
	Modal          components.Rect
}

// Compute is the only layout arithmetic for the operator shell.
func Compute(width, height, composerRows int) Metrics {
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
	metrics.Rail = components.Rect{Width: width, Height: railHeight}
	metrics.Composer = components.Rect{Y: height - composerRows - 2, Width: width, Height: composerRows + 2}
	available := metrics.Composer.Y - metrics.Rail.Height
	responseHeight := max(4, available/3)
	if metrics.Mode == Wide {
		// Wide terminals are the only layout that can display several pane rows
		// at once. Keep the response independently scrollable but compact so a
		// second row of app logs remains immediately inspectable.
		responseHeight = 5
	}
	if metrics.Mode == Narrow {
		responseHeight = max(3, available/3)
	}
	minimumResponseHeight := 3
	if metrics.Mode == Narrow {
		// At the minimum supported height, two response rows still preserve a
		// header and one independently scrollable output row while reserving a
		// complete metadata pane plus one visible log row.
		minimumResponseHeight = 2
	}
	if responseHeight > available-minimumPaneHeightWithLog {
		responseHeight = max(minimumResponseHeight, available-minimumPaneHeightWithLog)
	}
	metrics.Response = components.Rect{Y: metrics.Composer.Y - responseHeight, Width: width, Height: responseHeight}
	metrics.Panes = components.Rect{Y: metrics.Rail.Height, Width: width, Height: metrics.Response.Y - metrics.Rail.Height}
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
