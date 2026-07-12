package interaction

import "testing"

func TestModalAndTransientRestoreFocusAndOwnInput(t *testing.T) {
	state := New()
	state.SetFocus(FocusComposer)
	state.OpenTransient(TransientHelp)
	if state.Owner() != OwnerTransient {
		t.Fatalf("expected transient owner, got %s", state.Owner())
	}
	state.CloseTransient()
	if state.Focus != FocusComposer {
		t.Fatalf("expected composer restoration, got %s", state.Focus)
	}
	state.OpenModal(ModalAgentApproval)
	state.SetFocus(FocusResponse)
	if state.Owner() != OwnerModal || state.Focus != FocusComposer {
		t.Fatalf("modal must block background focus: %#v", state)
	}
	state.CloseModal()
	if state.Focus != FocusComposer {
		t.Fatalf("expected composer restoration after modal, got %s", state.Focus)
	}
}
