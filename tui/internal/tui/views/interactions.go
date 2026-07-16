package views

import (
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/components"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
)

func transformBodyRegion(region components.HitRegion, frame bodyViewportFrame, width int, bodyTop int) (components.HitRegion, bool) {
	clip := components.Rect{X: 0, Y: frame.Offset, Width: width, Height: frame.ContentHeight}
	transformed, ok := components.ClipAndTranslate(region.Rect, clip, 0, bodyTop+frame.IndicatorRows-frame.Offset)
	if !ok {
		return components.HitRegion{}, false
	}
	region.Rect = transformed
	return region, true
}

func paneHitRegions(style styles.Styles, data ShellData) []components.HitRegion {
	if data.Confirmation != nil || data.ContextMenu != nil || data.AppManager != nil || data.PackageManager != nil || data.RegistrationRepairs != nil || data.PaneReopen != nil || data.Help != nil || data.ShowHelp || data.DiagnosticsOpen || data.ResponseDetails || strings.TrimSpace(data.SetupPanel) != "" {
		return nil
	}
	if data.ConnectionStatus != "connected" || !hasRenderableState(data) {
		return nil
	}
	prefixY := 0
	if diagnosticsSummary(data.Diagnostics) != "" && !data.OperatorConsole {
		prefixY++
	}
	if data.FocusedPane != nil {
		return paneRegionsForRendered(style, *data.FocusedPane, 0, prefixY, contentWidth(data.Width), maxInt(data.PaneLayout.Height, 8), data.ClipboardWriteReady, data.ConnectionStatus == "connected")
	}
	if len(data.Panes) == 0 {
		return nil
	}
	if len(data.AssistantHistory) > 0 {
		prefixY += lipgloss.Height(renderAssistantHistory(data.AssistantHistory)) + 1
	}
	if data.PageCount > 1 && !data.OperatorConsole {
		prefixY += 2
	}
	columns := maxInt(data.PaneLayout.Columns, 1)
	regions := []components.HitRegion{}
	y := prefixY
	for start := 0; start < len(data.Panes); start += columns {
		end := minInt(start+columns, len(data.Panes))
		x := 0
		rowHeight := 0
		for _, pane := range data.Panes[start:end] {
			width := data.PaneLayout.PaneWidth
			height := data.PaneLayout.PaneHeight
			rendered := renderPane(style, pane, width, height, data.ClipboardWriteReady, data.ConnectionStatus == "connected")
			regions = append(regions, paneRegionsForRendered(style, pane, x, y, width, height, data.ClipboardWriteReady, data.ConnectionStatus == "connected")...)
			x += lipgloss.Width(rendered)
			rowHeight = maxInt(rowHeight, lipgloss.Height(rendered))
		}
		y += rowHeight
	}
	return regions
}

func paneRegionsForRendered(style styles.Styles, pane panes.PaneSnapshot, x int, y int, width int, height int, clipboardReady bool, lifecycleReady bool) []components.HitRegion {
	width = maxInt(width, 8)
	height = maxInt(height, 6)
	rendered := renderPane(style, pane, width, height, clipboardReady, lifecycleReady)
	contentX := x + style.Pane.GetBorderLeftSize() + style.Pane.GetPaddingLeft()
	contentY := y + style.Pane.GetBorderTopSize() + style.Pane.GetPaddingTop()
	line := 2
	if pane.RouteLabel != "" {
		line++
	}
	if pane.PID > 0 || pane.Port > 0 {
		line++
	}
	controlLine := line
	line++
	if pane.LastError != "" {
		line++
	}
	line, logBudget := paneLogGeometry(style, pane, height)
	innerWidth := maxInt(1, width-4)
	regions := []components.HitRegion{{
		Rect:   components.Rect{X: x, Y: y, Width: lipgloss.Width(rendered), Height: lipgloss.Height(rendered)},
		Kind:   components.HitPaneSurface,
		PaneID: pane.ID,
	}}
	if logBudget > 0 {
		regions = append(regions, components.HitRegion{
			Rect:   components.Rect{X: contentX, Y: contentY + line, Width: innerWidth, Height: logBudget},
			Kind:   components.HitPaneLogs,
			PaneID: pane.ID,
		})
	}
	if clipboardReady && (len(pane.LogLineModels) > 0 || len(pane.LogLines) > 0) {
		regions = append(regions, components.HitRegion{
			Rect:   components.Rect{X: contentX, Y: contentY + controlLine, Width: 3, Height: 1},
			Kind:   components.HitPaneCopyLogs,
			PaneID: pane.ID,
		})
	}
	regions = append(regions, components.HitRegion{
		Rect:   components.Rect{X: contentX + 4, Y: contentY + controlLine, Width: 3, Height: 1},
		Kind:   components.HitPaneRestart,
		PaneID: pane.ID,
	})
	return regions
}

func commandPaletteHitRegions(data CommandPaletteData, rendered string, width int) []components.HitRegion {
	if rendered == "" {
		return nil
	}
	regions := make([]components.HitRegion, 0, len(data.Matches)+1)
	regions = append(regions, components.HitRegion{
		Rect: components.Rect{X: 0, Y: 0, Width: maxInt(1, width), Height: lipgloss.Height(rendered)},
		Kind: components.HitCommandPalette,
	})
	for index := range data.Matches {
		regions = append(regions, components.HitRegion{
			Rect:  components.Rect{X: 1, Y: 1 + index, Width: maxInt(1, width-2), Height: 1},
			Kind:  components.HitCommandPaletteRow,
			Index: index,
		})
	}
	return regions
}

func startCompletionHitRegions(data StartCompletionData, rendered string, width int) []components.HitRegion {
	if rendered == "" {
		return nil
	}
	regions := []components.HitRegion{{
		Rect: components.Rect{X: 0, Y: 0, Width: maxInt(1, width), Height: lipgloss.Height(rendered)},
		Kind: components.HitStartCompletion,
	}}
	// Palette border, title, and table header precede the first app row.
	for index := range data.Items {
		regions = append(regions, components.HitRegion{
			Rect:  components.Rect{X: 1, Y: 3 + index, Width: maxInt(1, width-2), Height: 1},
			Kind:  components.HitStartCompletionRow,
			Index: index,
		})
	}
	return regions
}

func helpHitRegions(data ShellData) []components.HitRegion {
	if data.Help == nil || len(data.Help.Matches) == 0 {
		return nil
	}
	width := contentWidth(data.Width)
	height := maxInt(8, data.Height-8)
	resultRows := minInt(8, maxInt(3, height/3))
	selected := clampInt(data.Help.Selected, 0, len(data.Help.Matches)-1)
	start := clampInt(selected-resultRows/2, 0, maxInt(0, len(data.Help.Matches)-resultRows))
	end := minInt(len(data.Help.Matches), start+resultRows)
	resultWidth := width
	if width >= 80 {
		resultWidth = width / 2
	}
	regions := make([]components.HitRegion, 0, end-start+1)
	for index := start; index < end; index++ {
		regions = append(regions, components.HitRegion{
			Rect:  components.Rect{X: 0, Y: 3 + index - start, Width: maxInt(1, resultWidth), Height: 1},
			Kind:  components.HitHelpResult,
			Index: index,
		})
	}
	detailHeight := maxInt(4, height-7)
	if width >= 80 {
		regions = append(regions, components.HitRegion{
			Rect: components.Rect{X: width / 2, Y: 3, Width: maxInt(1, width-width/2), Height: detailHeight},
			Kind: components.HitHelpDetail,
		})
		return regions
	}
	regions = append(regions, components.HitRegion{
		Rect: components.Rect{X: 0, Y: 4 + end - start, Width: maxInt(1, width), Height: detailHeight},
		Kind: components.HitHelpDetail,
	})
	return regions
}

func registeredAppHitRegions(data ShellData) []components.HitRegion {
	if data.AppManager == nil {
		return nil
	}
	if data.AppManager.Surface == "rename-editor" || data.AppManager.Surface == "package-create" {
		return nil
	}
	if data.AppManager.Surface == "package-picker" {
		table := data.AppManager.PackagePicker
		if table == nil {
			return nil
		}
		rows := packageTableViewportRows(data)
		start := clampInt(table.Offset, 0, maxInt(0, len(table.Rows)-rows))
		end := minInt(len(table.Rows), start+rows)
		regions := make([]components.HitRegion, 0, end-start)
		for index := start; index < end; index++ {
			regions = append(regions, components.HitRegion{Rect: components.Rect{X: 0, Y: 5 + index - start, Width: maxInt(1, contentWidth(data.Width)), Height: 1}, Kind: components.HitPackageRow, Index: index})
		}
		return regions
	}
	if data.AppManager.Surface == "actions" {
		rows := appManagerActionViewportRows(data)
		start := clampInt(data.AppManager.ActionOffset, 0, maxInt(0, len(data.AppManager.Actions)-rows))
		end := minInt(len(data.AppManager.Actions), start+rows)
		regions := make([]components.HitRegion, 0, end-start)
		for index := start; index < end; index++ {
			regions = append(regions, components.HitRegion{
				Rect: components.Rect{X: 0, Y: appManagerActionStartY(data) + index - start, Width: maxInt(1, contentWidth(data.Width)), Height: 1},
				Kind: components.HitAppManagerAction, Index: index,
			})
		}
		return regions
	}
	if len(data.AppManager.Items) == 0 {
		return nil
	}
	rows := appManagerTableViewportRows(data)
	start := clampInt(data.AppManager.Offset, 0, maxInt(0, len(data.AppManager.Items)-rows))
	end := minInt(len(data.AppManager.Items), start+rows)
	regions := make([]components.HitRegion, 0, end-start)
	for index := start; index < end; index++ {
		regions = append(regions, components.HitRegion{
			Rect:  components.Rect{X: 0, Y: 5 + index - start, Width: maxInt(1, contentWidth(data.Width)), Height: 1},
			Kind:  components.HitRegisteredAppRow,
			Index: index,
		})
	}
	return regions
}

func packageManagerHitRegions(data ShellData) []components.HitRegion {
	manager := data.PackageManager
	if manager == nil {
		return nil
	}
	width := maxInt(1, contentWidth(data.Width))
	switch manager.Surface {
	case "table":
		rows := packageTableViewportRows(data)
		start := clampInt(manager.Table.Offset, 0, maxInt(0, len(manager.Table.Rows)-rows))
		end := minInt(len(manager.Table.Rows), start+rows)
		regions := make([]components.HitRegion, 0, end-start)
		for index := start; index < end; index++ {
			regions = append(regions, components.HitRegion{Rect: components.Rect{X: 0, Y: 5 + index - start, Width: width, Height: 1}, Kind: components.HitPackageRow, Index: index})
		}
		return regions
	case "actions":
		rows := packageActionViewportRows(data)
		start := clampInt(manager.ActionOffset, 0, maxInt(0, len(manager.Actions)-rows))
		end := minInt(len(manager.Actions), start+rows)
		regions := make([]components.HitRegion, 0, end-start)
		for index := start; index < end; index++ {
			regions = append(regions, components.HitRegion{Rect: components.Rect{X: 0, Y: packageManagerActionStartY(data) + index - start, Width: width, Height: 1}, Kind: components.HitPackageAction, Index: index})
		}
		return regions
	case "members":
		rows := packageMemberViewportRows(data)
		start := clampInt(manager.MemberOffset, 0, maxInt(0, len(manager.Members)-rows))
		end := minInt(len(manager.Members), start+rows)
		regions := make([]components.HitRegion, 0, end-start)
		for index := start; index < end; index++ {
			regions = append(regions, components.HitRegion{Rect: components.Rect{X: 0, Y: packageManagerMemberStartY(data) + index - start, Width: width, Height: 1}, Kind: components.HitPackageMember, Index: index})
		}
		return regions
	default:
		return nil
	}
}

func paneReopenHitRegions(data ShellData) []components.HitRegion {
	if data.PaneReopen == nil || len(data.PaneReopen.Items) == 0 {
		return nil
	}
	rows := paneReopenViewportRows(data)
	start := clampInt(data.PaneReopen.Offset, 0, maxInt(0, len(data.PaneReopen.Items)-rows))
	end := minInt(len(data.PaneReopen.Items), start+rows)
	regions := make([]components.HitRegion, 0, end-start)
	for index := start; index < end; index++ {
		regions = append(regions, components.HitRegion{
			Rect:  components.Rect{X: 0, Y: 5 + index - start, Width: maxInt(1, contentWidth(data.Width)), Height: 1},
			Kind:  components.HitPaneReopenRow,
			Index: index,
		})
	}
	return regions
}
