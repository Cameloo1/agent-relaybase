package panes

import (
	"fmt"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/layout"
)

func TestMinimumHeightComposerBandKeepsAFullMetadataPaneLogRow(t *testing.T) {
	for _, width := range []int{40, 80} {
		t.Run(fmt.Sprintf("%dx18", width), func(t *testing.T) {
			metrics := layout.Compute(width, 18, 3)
			manager := NewManager()
			manager.Resize(metrics.Panes.Width, metrics.Panes.Height)
			manager.ApplyState(&relaybaseclient.RelaybaseState{Components: []relaybaseclient.AppComponent{{
				AppID:       "service-api",
				GroupID:     "service",
				Role:        "backend",
				PaneLabel:   "backend",
				DisplayName: "Service",
				Status:      "running",
				Route:       relaybaseclient.RouteInfo{HumanURL: "http://service-api.localhost:7777", Reachable: true},
				PID:         4200,
				Port:        8400,
			}}})
			manager.AppendLog(relaybaseclient.LogEvent{
				Sequence:      1,
				AppID:         "service-api",
				GroupID:       "service",
				ComponentRole: "backend",
				Stream:        "stdout",
				Message:       "visible minimum-height log",
			})

			page := manager.CurrentPagePanes()
			if CalculatePageCapacity(metrics.Panes.Width, metrics.Panes.Height) < 1 || len(page) != 1 {
				t.Fatalf("%dx18 minimum-height page has no usable pane: capacity=%d panes=%d", width, CalculatePageCapacity(metrics.Panes.Width, metrics.Panes.Height), len(page))
			}
			if manager.Layout().PaneHeight < 9 || len(page[0].LogLineModels) != 1 || page[0].LogLineModels[0].Text != "[stdout] visible minimum-height log" {
				t.Fatalf("%dx18 pane lost its visible log projection: layout=%#v pane=%#v", width, manager.Layout(), page[0])
			}
		})
	}
}
