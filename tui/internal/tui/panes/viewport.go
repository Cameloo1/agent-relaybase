package panes

import (
	"charm.land/bubbles/v2/viewport"
)

type LogViewportProjection struct {
	Text                string
	Lines               []PaneLogLine
	TopYOffset          int
	ManagerScrollOffset int
	TotalLines          int
	VisibleHeight       int
}

func ProjectLogViewport(lines []PaneLogLine, width int, height int, managerScrollOffset int) LogViewportProjection {
	width = maxInt(width, 1)
	height = maxInt(height, 1)
	texts := paneLogLineTexts(lines)
	model := viewport.New()
	model.SetWidth(width)
	model.SetHeight(height)
	model.SoftWrap = false
	model.FillHeight = true
	model.MouseWheelEnabled = false
	model.SetContentLines(texts)
	model.SetYOffset(TopYOffsetFromManagerOffset(len(lines), height, managerScrollOffset))

	top := model.YOffset()
	end := minInt(len(lines), top+height)
	visible := append([]PaneLogLine(nil), lines[top:end]...)
	return LogViewportProjection{
		Text:                model.View(),
		Lines:               visible,
		TopYOffset:          top,
		ManagerScrollOffset: ManagerOffsetFromTopYOffset(len(lines), height, top),
		TotalLines:          len(lines),
		VisibleHeight:       height,
	}
}

func TopYOffsetFromManagerOffset(lineCount int, visibleHeight int, managerScrollOffset int) int {
	lineCount = maxInt(lineCount, 0)
	visibleHeight = maxInt(visibleHeight, 1)
	maximumTop := maxInt(0, lineCount-visibleHeight)
	return clamp(maximumTop-maxInt(managerScrollOffset, 0), 0, maximumTop)
}

func ManagerOffsetFromTopYOffset(lineCount int, visibleHeight int, topYOffset int) int {
	lineCount = maxInt(lineCount, 0)
	visibleHeight = maxInt(visibleHeight, 1)
	maximumTop := maxInt(0, lineCount-visibleHeight)
	topYOffset = clamp(topYOffset, 0, maximumTop)
	return maximumTop - topYOffset
}
