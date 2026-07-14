package components

type Rect struct {
	X      int
	Y      int
	Width  int
	Height int
}

func (r Rect) Valid() bool {
	return r.Width > 0 && r.Height > 0
}

func (r Rect) Contains(x int, y int) bool {
	return r.Valid() && x >= r.X && x < r.X+r.Width && y >= r.Y && y < r.Y+r.Height
}

func (r Rect) Translate(dx int, dy int) Rect {
	r.X += dx
	r.Y += dy
	return r
}

func (r Rect) Intersect(other Rect) (Rect, bool) {
	left := maxInt(r.X, other.X)
	top := maxInt(r.Y, other.Y)
	right := minInt(r.X+r.Width, other.X+other.Width)
	bottom := minInt(r.Y+r.Height, other.Y+other.Height)
	intersection := Rect{X: left, Y: top, Width: right - left, Height: bottom - top}
	return intersection, intersection.Valid()
}

func ClipAndTranslate(rect Rect, clip Rect, dx int, dy int) (Rect, bool) {
	clipped, ok := rect.Intersect(clip)
	if !ok {
		return Rect{}, false
	}
	return clipped.Translate(dx, dy), true
}

type HitKind string

const (
	HitPaneSurface        HitKind = "pane.surface"
	HitPaneLogs           HitKind = "pane.logs"
	HitPaneCopyLogs       HitKind = "pane.copy_logs"
	HitPaneRestart        HitKind = "pane.restart"
	HitCommandPalette     HitKind = "command_palette"
	HitCommandPaletteRow  HitKind = "command_palette.row"
	HitStartCompletion    HitKind = "start_completion"
	HitStartCompletionRow HitKind = "start_completion.row"
	HitHelpResult         HitKind = "help.result"
	HitHelpDetail         HitKind = "help.detail"
	HitRegisteredAppRow   HitKind = "registered_apps.row"
	HitPaneReopenRow      HitKind = "pane_reopen.row"
	HitResponse           HitKind = "response"
	HitComposer           HitKind = "composer"
	HitModal              HitKind = "modal"
	HitTransient          HitKind = "transient"
	HitThreadSwitcherRow  HitKind = "thread_switcher.row"
	HitCodePickerRow      HitKind = "code_picker.row"
)

type HitRegion struct {
	Rect   Rect
	Kind   HitKind
	PaneID string
	Index  int
}

type HitMap struct {
	regions []HitRegion
}

func (h *HitMap) Add(region HitRegion) bool {
	if h == nil || !region.Rect.Valid() || region.Kind == "" {
		return false
	}
	if (region.Kind == HitPaneSurface || region.Kind == HitPaneLogs || region.Kind == HitPaneCopyLogs || region.Kind == HitPaneRestart) && region.PaneID == "" {
		return false
	}
	h.regions = append(h.regions, region)
	return true
}

func (h HitMap) Regions() []HitRegion {
	return append([]HitRegion(nil), h.regions...)
}

func (h HitMap) Hit(x int, y int) (HitRegion, bool) {
	for index := len(h.regions) - 1; index >= 0; index-- {
		if h.regions[index].Rect.Contains(x, y) {
			return h.regions[index], true
		}
	}
	return HitRegion{}, false
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
