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

func TestAppListTransientIsDistinctFromHelp(t *testing.T) {
	state := New()
	state.SetFocus(FocusResponse)
	state.OpenTransient(TransientAppList)
	if state.Transient != TransientAppList || state.Transient == TransientHelp || state.Owner() != OwnerTransient {
		t.Fatalf("app list must own a distinct transient: %#v", state)
	}
	state.CloseTransient()
	if state.Focus != FocusResponse {
		t.Fatalf("expected response focus restoration, got %s", state.Focus)
	}
}

func TestPaneReopenTransientIsDedicatedAndRestoresFocus(t *testing.T) {
	state := New()
	state.SetFocus(FocusComposer)
	state.OpenTransient(TransientPaneReopen)
	if state.Transient != TransientPaneReopen || state.Transient == TransientAppList || state.Transient == TransientHelp || state.Owner() != OwnerTransient {
		t.Fatalf("pane reopen must own a dedicated transient: %#v", state)
	}
	state.CloseTransient()
	if state.Focus != FocusComposer {
		t.Fatalf("expected composer focus restoration, got %s", state.Focus)
	}
}
