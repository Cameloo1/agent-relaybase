package usage

import "github.com/cameloo/relaybase/tui/internal/relaybaseclient"

type Status string

const (
	StatusClosed  Status = "closed"
	StatusLoading Status = "loading"
	StatusReady   Status = "ready"
	StatusEmpty   Status = "empty"
	StatusStale   Status = "stale"
	StatusError   Status = "error"
)

type Model struct {
	open     bool
	status   Status
	snapshot *relaybaseclient.AgentUsageSnapshot
	err      string
}

type Snapshot struct {
	Status Status
	Usage  *relaybaseclient.AgentUsageSnapshot
	Error  string
}

func New() Model { return Model{status: StatusClosed} }

func (m *Model) Open() {
	m.open = true
	m.status = StatusLoading
	m.err = ""
}

func (m *Model) Close()      { m.open, m.status, m.err = false, StatusClosed, "" }
func (m Model) IsOpen() bool { return m.open }

func (m *Model) Loading() {
	m.open = true
	if m.snapshot == nil {
		m.status = StatusLoading
	}
	m.err = ""
}

func (m *Model) Loaded(value *relaybaseclient.AgentUsageSnapshot) {
	// Request completion may arrive after Esc closed the modal. Async data is
	// never allowed to reacquire interaction ownership; the root model also
	// generation-checks completions before they reach this reducer.
	if !m.open {
		return
	}
	m.snapshot = value
	m.err = ""
	if value == nil || value.LastRequest == nil {
		m.status = StatusEmpty
	} else {
		m.status = StatusReady
	}
}

func (m *Model) Failed(err error) {
	if !m.open {
		return
	}
	m.err = err.Error()
	if m.snapshot != nil {
		m.status = StatusStale
	} else {
		m.status = StatusError
	}
}

func (m Model) Snapshot() *Snapshot {
	if !m.open {
		return nil
	}
	return &Snapshot{Status: m.status, Usage: m.snapshot, Error: m.err}
}
