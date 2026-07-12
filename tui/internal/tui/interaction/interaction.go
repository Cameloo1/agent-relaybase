// Package interaction centralizes input ownership for the operator console.
package interaction

type PrimaryFocus string
type TransientKind string
type ModalKind string
type Owner string

const (
	FocusPanes               PrimaryFocus  = "panes"
	FocusResponse            PrimaryFocus  = "response"
	FocusComposer            PrimaryFocus  = "composer"
	TransientNone            TransientKind = ""
	TransientCommandPalette  TransientKind = "command_palette"
	TransientThreadSwitcher  TransientKind = "thread_switcher"
	TransientHelp            TransientKind = "help"
	TransientResponseDetails TransientKind = "response_details"
	TransientCodePicker      TransientKind = "code_picker"
	TransientDiagnostics     TransientKind = "diagnostics"
	ModalNone                ModalKind     = ""
	ModalAgentApproval       ModalKind     = "agent_approval"
	ModalConfirmation        ModalKind     = "confirmation"
	ModalQuitConfirmation    ModalKind     = "quit_confirmation"
	ModalNotice              ModalKind     = "notice"
	ModalUsage               ModalKind     = "usage"
	OwnerModal               Owner         = "modal"
	OwnerTransient           Owner         = "transient"
	OwnerPanes               Owner         = "panes"
	OwnerResponse            Owner         = "response"
	OwnerComposer            Owner         = "composer"
	OwnerGlobal              Owner         = "global"
)

type State struct {
	Focus         PrimaryFocus
	PreviousFocus PrimaryFocus
	Transient     TransientKind
	Modal         ModalKind
}

func New() State { return State{Focus: FocusPanes} }

func (s *State) SetFocus(focus PrimaryFocus) {
	if focus == "" || s.Modal != ModalNone || s.Transient != TransientNone {
		return
	}
	s.Focus = focus
}

func (s *State) OpenTransient(kind TransientKind) {
	if kind == TransientNone || s.Modal != ModalNone {
		return
	}
	s.PreviousFocus = s.Focus
	s.Transient = kind
}

func (s *State) CloseTransient() {
	if s.Transient == TransientNone {
		return
	}
	s.Transient = TransientNone
	if s.PreviousFocus != "" {
		s.Focus = s.PreviousFocus
	}
}

func (s *State) OpenModal(kind ModalKind) {
	if kind == ModalNone {
		return
	}
	s.PreviousFocus = s.Focus
	s.Modal = kind
}

func (s *State) CloseModal() {
	if s.Modal == ModalNone {
		return
	}
	s.Modal = ModalNone
	if s.PreviousFocus != "" {
		s.Focus = s.PreviousFocus
	}
}

func (s State) Owner() Owner {
	if s.Modal != ModalNone {
		return OwnerModal
	}
	if s.Transient != TransientNone {
		return OwnerTransient
	}
	switch s.Focus {
	case FocusResponse:
		return OwnerResponse
	case FocusComposer:
		return OwnerComposer
	case FocusPanes:
		return OwnerPanes
	default:
		return OwnerGlobal
	}
}
