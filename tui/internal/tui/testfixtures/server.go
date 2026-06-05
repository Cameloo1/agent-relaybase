package testfixtures

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

func NewStateServer(body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__hub/api/state" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
}

type TerminalSize struct {
	Name   string
	Width  int
	Height int
}

func IsolatedStateDir(t testing.TB) string {
	t.Helper()
	return t.TempDir()
}

func TerminalSizes() []TerminalSize {
	return []TerminalSize{
		{Name: "compact", Width: 80, Height: 24},
		{Name: "standard", Width: 120, Height: 40},
		{Name: "narrow", Width: 52, Height: 24},
	}
}

func GroupedFrontendBackendState() *relaybaseclient.RelaybaseState {
	components := []relaybaseclient.AppComponent{
		{
			AppID:       "notes-web",
			GroupID:     "notes",
			Role:        "frontend",
			PaneLabel:   "frontend",
			PaneOrder:   10,
			DisplayName: "Notes",
			Status:      "running",
			Route: relaybaseclient.RouteInfo{
				HumanURL:  "http://notes.localhost:7777",
				AgentURL:  "http://127.0.0.1:7777",
				Reachable: true,
			},
			PID:  101,
			Port: 18001,
		},
		{
			AppID:       "notes-api",
			GroupID:     "notes",
			Role:        "backend",
			PaneLabel:   "backend",
			PaneOrder:   20,
			DisplayName: "Notes API",
			Status:      "running",
			PID:         102,
			Port:        18002,
		},
	}
	return &relaybaseclient.RelaybaseState{
		APIVersion: "v1",
		Apps: []relaybaseclient.AppState{
			{ID: "notes-web", Name: "Notes Web", RuntimeStatus: "running", PID: 101, Port: 18001},
			{ID: "notes-api", Name: "Notes API", RuntimeStatus: "running", PID: 102, Port: 18002},
		},
		Groups: []relaybaseclient.AppGroup{
			{
				GroupID:         "notes",
				DisplayName:     "Notes",
				Components:      components,
				AggregateStatus: "running",
			},
		},
		Components: components,
		GeneratedAt: "2026-06-01T00:00:00.000Z",
	}
}

func SampleLogs() []relaybaseclient.LogEvent {
	return []relaybaseclient.LogEvent{
		{Sequence: 1, AppID: "notes-web", GroupID: "notes", ComponentRole: "frontend", Stream: "stdout", Message: "frontend ready"},
		{Sequence: 2, AppID: "notes-api", GroupID: "notes", ComponentRole: "backend", Stream: "stdout", Message: "backend ready"},
	}
}

func NewFakeDaemonServer(state *relaybaseclient.RelaybaseState, logs []relaybaseclient.LogEvent) *httptest.Server {
	if state == nil {
		state = GroupedFrontendBackendState()
	}
	if logs == nil {
		logs = SampleLogs()
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/__hub/api/state":
			writeJSON(w, state)
		case r.URL.Path == "/__hub/api/events":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte("id: 1\n"))
			_, _ = w.Write([]byte("event: daemon.ready\n"))
			_, _ = w.Write([]byte(`data: {"type":"daemon.ready","sequence":1}` + "\n\n"))
		case strings.HasPrefix(r.URL.Path, "/__hub/api/apps/") && strings.HasSuffix(r.URL.Path, "/logs"):
			writeJSON(w, relaybaseclient.LogSnapshot{
				Events: logs,
				Page: relaybaseclient.LogPage{
					Limit:          len(logs),
					OldestSequence: 1,
					NewestSequence: int64(len(logs)),
				},
			})
		case strings.HasPrefix(r.URL.Path, "/__hub/api/apps/") &&
			(strings.HasSuffix(r.URL.Path, "/start") || strings.HasSuffix(r.URL.Path, "/stop") || strings.HasSuffix(r.URL.Path, "/restart")):
			action := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
			writeJSON(w, relaybaseclient.LifecycleOperationResponse{OperationID: "op-fixture-" + action})
		case r.URL.Path == "/__hub/api/logs/export":
			writeJSON(w, relaybaseclient.LogExportResponse{
				Export: relaybaseclient.LogExportResult{
					ExportID:   "export-fixture-1",
					Status:     "completed",
					Format:     "log",
					OutputPath: "fixture.log",
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
}

func writeJSON(w http.ResponseWriter, value any) {
	if err := json.NewEncoder(w).Encode(value); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
