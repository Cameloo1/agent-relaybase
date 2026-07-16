package model

import (
	"reflect"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/interaction"
)

func packageFixture(id string, name string, members ...string) relaybaseclient.AppPackageDefinition {
	return relaybaseclient.AppPackageDefinition{ID: id, Name: name, MemberAppIDs: members, Revision: 2}
}

func packageTestRoot(t *testing.T) RootModel {
	t.Helper()
	root := applyState(newTestModel(t), &relaybaseclient.RelaybaseState{Apps: []relaybaseclient.AppState{
		{ID: "notes", Name: "Notes", RuntimeStatus: "stopped", ManifestPath: `C:\work\notes\relaybase.app.json`},
		{ID: "worker", Name: "Worker", RuntimeStatus: "running", ManifestPath: `C:\work\worker\relaybase.app.json`},
	}})
	root.appPackagesKnown = true
	root.appPackages = []relaybaseclient.AppPackageDefinition{
		packageFixture("pkg_api", "API services", "worker"),
		packageFixture("pkg_web", "Web stack", "worker"),
	}
	return root
}

func TestPackagesCommandOpensDedicatedManagerUsingStableSelection(t *testing.T) {
	root := packageTestRoot(t)
	beforeMessages := len(root.assistantHistory)
	root, refresh := root.submitSlashCommand("/packages")
	if refresh == nil || !root.packageManagerVisible || root.packageManagerSurface != packageManagerSurfaceTable {
		t.Fatalf("/packages did not open manager popup: visible=%v surface=%s refresh=%v", root.packageManagerVisible, root.packageManagerSurface, refresh)
	}
	if root.interaction.Transient != interaction.TransientPackageManager || root.interaction.Owner() != interaction.OwnerTransient {
		t.Fatalf("package manager did not own its transient: %#v", root.interaction)
	}
	if len(root.assistantHistory) != beforeMessages {
		t.Fatalf("/packages printed legacy assistant output instead of opening the popup")
	}
	data := root.packageManagerDataForView()
	if data == nil || len(data.Table.Rows) != 2 || data.Table.Rows[0].ID != "pkg_api" || data.Table.PickerMode {
		t.Fatalf("unexpected package table projection: %#v", data)
	}

	root.packageManagerSelectedID = "pkg_web"
	updated, _ := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if root.packageManagerSurface != packageManagerSurfaceActions || root.packageManagerSelectedID != "pkg_web" {
		t.Fatalf("package action view lost stable selection: surface=%s selected=%q", root.packageManagerSurface, root.packageManagerSelectedID)
	}
	wantOrder := []packageManagerActionID{
		packageManagerActionLaunch, packageManagerActionInspect, packageManagerActionRetry, packageManagerActionAbort,
		packageManagerActionEdit, packageManagerActionRename, packageManagerActionDelete,
	}
	gotOrder := make([]packageManagerActionID, 0, len(root.packageManagerActions()))
	for _, action := range root.packageManagerActions() {
		gotOrder = append(gotOrder, action.ID)
		if !action.Enabled && strings.TrimSpace(action.DisabledReason) == "" {
			t.Fatalf("disabled package action %s has no textual reason", action.ID)
		}
	}
	if !reflect.DeepEqual(gotOrder, wantOrder) {
		t.Fatalf("package action order=%v want=%v", gotOrder, wantOrder)
	}

	root.packageManagerSelectedID = "pkg_web"
	root.upsertAppPackage(packageFixture("pkg_web", "A renamed stack", "worker"))
	if root.packageManagerSelectedID != "pkg_web" || root.selectedPackageDefinition().Name != "A renamed stack" || root.packageManagerSelectedIndex() != 0 {
		t.Fatalf("rename/re-sort lost stable package selection: selected=%q definition=%#v index=%d", root.packageManagerSelectedID, root.selectedPackageDefinition(), root.packageManagerSelectedIndex())
	}
}

func TestManageAddToPackagePickerEligibilityPreviewCancelAndSuccess(t *testing.T) {
	root := packageTestRoot(t)
	root.appPackages[0].MemberAppIDs = []string{"notes"}
	active := relaybaseclient.AppPackageRun{ID: "run-1", PackageID: "pkg_web", Status: "running"}
	root.appPackages[1].LastRun = &active
	root, _ = root.submitSlashCommand("/manage")
	updated, _ := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	actions := root.appManagerActions()
	if actions[len(actions)-1].ID != appManagerActionAddPackage {
		t.Fatalf("add-to-package is not final action: %#v", actions)
	}
	root.appManagerSelectedActionID = appManagerActionAddPackage
	updated, command := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if command != nil || root.appManagerSurface != appManagerSurfacePackagePicker || root.appManagerPendingAppID != "notes" {
		t.Fatalf("add-to-package did not open app-scoped picker: surface=%s app=%q command=%v", root.appManagerSurface, root.appManagerPendingAppID, command)
	}
	data := root.appManagerDataForView()
	if data.PackagePicker == nil || !data.PackagePicker.PickerMode || len(data.PackagePicker.Rows) != 2 {
		t.Fatalf("app picker did not reuse package table projection: %#v", data.PackagePicker)
	}
	if data.PackagePicker.Rows[0].Enabled || data.PackagePicker.Rows[0].DisabledReason != "already included" {
		t.Fatalf("already-included package was not explicit: %#v", data.PackagePicker.Rows[0])
	}
	if data.PackagePicker.Rows[1].Enabled || data.PackagePicker.Rows[1].DisabledReason != "run active" {
		t.Fatalf("active-run package was not blocked: %#v", data.PackagePicker.Rows[1])
	}

	root.appPackages[1].LastRun = nil
	root.appManagerPackageSelectedID = "pkg_web"
	updated, previewCmd := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if previewCmd == nil || root.appManagerPendingPackageID != "pkg_web" {
		t.Fatalf("eligible picker row did not request exact preview: pending=%q command=%v", root.appManagerPendingPackageID, previewCmd)
	}
	preview := &relaybaseclient.AppPackageChangePreview{PreviewID: "preview-1", CanApply: true}
	preview.Change.Kind = "add-member"
	preview.Package.ID = "pkg_web"
	preview.Package.CurrentName = "Web stack"
	preview.Package.CurrentRevision = 2
	preview.Package.ProposedRevision = 3
	preview.Package.CurrentMemberAppIDs = []string{"worker"}
	preview.Package.ProposedMemberAppIDs = []string{"worker", "notes"}
	updated, _ = root.Update(commands.AppPackageChangePreviewedMsg{PackageID: "pkg_web", Preview: preview})
	root = updated.(RootModel)
	if root.pendingConfirm == nil || root.pendingConfirm.PackageChangePreview == nil || root.interaction.Owner() != interaction.OwnerModal {
		t.Fatalf("package add preview did not use confirmation boundary: %#v owner=%s", root.pendingConfirm, root.interaction.Owner())
	}
	updated, _ = root.Update(keyPress("esc"))
	root = updated.(RootModel)
	if root.appManagerSurface != appManagerSurfacePackagePicker || root.appManagerPendingAppID != "notes" || root.appManagerPackageSelectedID != "pkg_web" {
		t.Fatalf("cancel lost picker recovery path: surface=%s app=%q package=%q", root.appManagerSurface, root.appManagerPendingAppID, root.appManagerPackageSelectedID)
	}

	root.appManagerPendingPackageID = "pkg_web"
	result := &relaybaseclient.AppPackageChangeResult{Updated: true, ChangeKind: "add-member", Package: packageFixture("pkg_web", "Web stack", "worker", "notes")}
	result.Package.Revision = 3
	updated, _ = root.Update(commands.AppPackageChangedMsg{PackageID: "pkg_web", Result: result})
	root = updated.(RootModel)
	if root.appManagerSurface != appManagerSurfaceActions || root.appManagerSelectedActionID != appManagerActionAddPackage || !strings.Contains(root.appManagerNotice, "No app was launched") {
		t.Fatalf("add success did not return to exact app action: surface=%s action=%s notice=%q", root.appManagerSurface, root.appManagerSelectedActionID, root.appManagerNotice)
	}
}

func TestPackageManagerEditOrderRenameDeleteAndActiveRunGates(t *testing.T) {
	root := packageTestRoot(t)
	root.packageManagerVisible = true
	root.interaction.OpenTransient(interaction.TransientPackageManager)
	root.packageManagerSelectedID = "pkg_web"
	root.packageManagerSurface = packageManagerSurfaceActions
	root.ensurePackageManagerActionSelection()

	active := relaybaseclient.AppPackageRun{ID: "run-1", PackageID: "pkg_web", Status: "running"}
	root.appPackages[1].LastRun = &active
	for _, action := range projectPackageManagerActions(root.appPackages[1], true) {
		if action.ID == packageManagerActionEdit || action.ID == packageManagerActionRename || action.ID == packageManagerActionDelete {
			if action.Enabled || !strings.Contains(action.DisabledReason, "active run") {
				t.Fatalf("active run did not block %s: %#v", action.ID, action)
			}
		}
	}
	root.appPackages[1].LastRun = nil
	root.packageManagerSelectedAction = packageManagerActionEdit
	updated, _ := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if root.packageManagerSurface != packageManagerSurfaceMembers || !reflect.DeepEqual(root.packageManagerMembers, []string{"worker"}) {
		t.Fatalf("membership editor did not copy ordered definition: surface=%s members=%v", root.packageManagerSurface, root.packageManagerMembers)
	}
	root.selectPackageMemberByID("notes")
	updated, _ = root.Update(keyPress(" "))
	root = updated.(RootModel)
	if !reflect.DeepEqual(root.packageManagerMembers, []string{"worker", "notes"}) {
		t.Fatalf("space did not add selected registered app: %v", root.packageManagerMembers)
	}
	updated, _ = root.Update(keyPress("ctrl+up"))
	root = updated.(RootModel)
	if !reflect.DeepEqual(root.packageManagerMembers, []string{"notes", "worker"}) {
		t.Fatalf("ctrl+up did not preserve explicit order: %v", root.packageManagerMembers)
	}
	updated, previewCmd := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if previewCmd == nil || root.packageManagerPendingID != "pkg_web" || root.packageManagerPendingAction != packageManagerActionEdit {
		t.Fatalf("membership edit did not request revision-bound preview: id=%q action=%s command=%v", root.packageManagerPendingID, root.packageManagerPendingAction, previewCmd)
	}

	root.packageManagerPendingID = ""
	root.packageManagerPendingAction = ""
	root.packageManagerSurface = packageManagerSurfaceActions
	root.packageManagerSelectedAction = packageManagerActionRename
	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if root.packageManagerSurface != packageManagerSurfaceName || root.packageManagerNameInput.Value() != "Web stack" {
		t.Fatalf("rename did not open dedicated name editor: surface=%s value=%q", root.packageManagerSurface, root.packageManagerNameInput.Value())
	}
	root.packageManagerNameInput.SetValue("Web workspace")
	updated, renameCmd := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if renameCmd == nil || root.packageManagerPendingAction != packageManagerActionRename {
		t.Fatalf("rename did not request preview: action=%s command=%v", root.packageManagerPendingAction, renameCmd)
	}

	root.packageManagerPendingID = ""
	root.packageManagerSurface = packageManagerSurfaceActions
	root.packageManagerSelectedAction = packageManagerActionDelete
	updated, deletePreview := root.Update(keyPress("enter"))
	root = updated.(RootModel)
	if deletePreview == nil || root.packageManagerPendingID != "pkg_web" || root.packageManagerPendingAction != packageManagerActionDelete {
		t.Fatalf("delete did not request daemon preview: id=%q action=%s command=%v", root.packageManagerPendingID, root.packageManagerPendingAction, deletePreview)
	}
	deleteEvidence := &relaybaseclient.AppPackageDeletePreview{PreviewID: "delete-1", CanDelete: true, HistoricalRunCount: 4}
	deleteEvidence.Package.ID = "pkg_web"
	deleteEvidence.Package.Name = "Web stack"
	deleteEvidence.Package.Revision = 2
	deleteEvidence.Package.MemberAppIDs = []string{"worker"}
	updated, _ = root.Update(commands.AppPackageDeletePreviewedMsg{PackageID: "pkg_web", Preview: deleteEvidence})
	root = updated.(RootModel)
	if root.pendingConfirm == nil || root.pendingConfirm.PackageDeletePreview == nil || !strings.Contains(strings.Join(root.pendingConfirm.Details, " "), "historical runs preserved: 4") {
		t.Fatalf("delete confirmation did not state retention boundary: %#v", root.pendingConfirm)
	}
}

func TestDeletePackageShortcutUsesRevisionBoundPreviewAndApply(t *testing.T) {
	root := packageTestRoot(t)
	root.packageManagerVisible = false

	root, previewCmd := root.submitSlashCommand("/delete-package 'Web stack'")
	if previewCmd == nil || root.pendingConfirm != nil || root.packageManagerPendingID != "pkg_web" || root.packageManagerPendingAction != packageManagerActionDelete || root.packageDeleteAutoConfirm {
		t.Fatalf("delete shortcut did not request a revision-bound preview: pending=%#v id=%q action=%s auto=%v command=%v", root.pendingConfirm, root.packageManagerPendingID, root.packageManagerPendingAction, root.packageDeleteAutoConfirm, previewCmd)
	}

	preview := &relaybaseclient.AppPackageDeletePreview{PreviewID: "delete-shortcut", CanDelete: true, HistoricalRunCount: 3}
	preview.Package.ID = root.appPackages[0].ID
	preview.Package.Name = root.appPackages[0].Name
	preview.Package.Revision = root.appPackages[0].Revision
	preview.Package.MemberAppIDs = append([]string(nil), root.appPackages[0].MemberAppIDs...)
	updated, applyCmd := root.Update(commands.AppPackageDeletePreviewedMsg{PackageID: "pkg_web", Preview: preview})
	root = updated.(RootModel)
	if applyCmd != nil || root.pendingConfirm == nil || root.pendingConfirm.PackageDeletePreview == nil {
		t.Fatalf("unconfirmed delete shortcut did not stop at evidence-backed confirmation: pending=%#v command=%v", root.pendingConfirm, applyCmd)
	}

	root = packageTestRoot(t)
	root.packageManagerVisible = false
	root, previewCmd = root.submitSlashCommand("/delete-package 'Web stack' --confirm")
	if previewCmd == nil || !root.packageDeleteAutoConfirm {
		t.Fatalf("explicit confirmation did not retain approval while requesting preview: auto=%v command=%v", root.packageDeleteAutoConfirm, previewCmd)
	}
	preview.Package.ID = root.appPackages[0].ID
	preview.Package.Name = root.appPackages[0].Name
	preview.Package.Revision = root.appPackages[0].Revision
	preview.Package.MemberAppIDs = append([]string(nil), root.appPackages[0].MemberAppIDs...)
	updated, applyCmd = root.Update(commands.AppPackageDeletePreviewedMsg{PackageID: "pkg_web", Preview: preview})
	root = updated.(RootModel)
	if applyCmd == nil || root.pendingConfirm != nil || root.packageDeleteAutoConfirm {
		t.Fatalf("confirmed shortcut did not advance from bound preview to apply: pending=%#v auto=%v command=%v", root.pendingConfirm, root.packageDeleteAutoConfirm, applyCmd)
	}
}

func TestManageShortTerminalShowsOverflowAndEndReachesFinalActions(t *testing.T) {
	root := packageTestRoot(t)
	root, _ = root.submitSlashCommand("/manage")
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 88, Height: 18})
	root = updated.(RootModel)
	updated, _ = root.Update(keyPress("enter"))
	root = updated.(RootModel)
	initial := root.Render()
	if !strings.Contains(initial, "more") || !strings.Contains(initial, "Actions 1") {
		t.Fatalf("short action viewport hid overflow without an indicator:\n%s", initial)
	}
	updated, _ = root.Update(keyPress("end"))
	root = updated.(RootModel)
	if root.appManagerSelectedActionID != appManagerActionAddPackage || root.appManagerActionOffset == 0 {
		t.Fatalf("End did not reach final action: action=%s offset=%d", root.appManagerSelectedActionID, root.appManagerActionOffset)
	}
	bottom := root.Render()
	if !strings.Contains(bottom, "Add to package") || !strings.Contains(bottom, "above") {
		t.Fatalf("final action was not visibly reachable with above indicator:\n%s", bottom)
	}
	updated, _ = root.Update(keyPress("up"))
	root = updated.(RootModel)
	if root.appManagerSelectedActionID != appManagerActionUnregister {
		t.Fatalf("unregister is not immediately reachable above final action: %s", root.appManagerSelectedActionID)
	}
}

func TestPackageRunDetailPagesWithKeyboardAndWheelWithoutBackgroundInput(t *testing.T) {
	root := packageTestRoot(t)
	members := make([]relaybaseclient.AppPackageRunMember, 0, 8)
	for index := 0; index < 8; index++ {
		members = append(members, relaybaseclient.AppPackageRunMember{Ordinal: index + 1, AppID: "app-" + string(rune('a'+index)), State: "started"})
	}
	run := &relaybaseclient.AppPackageRun{ID: "run-1", PackageID: "pkg_web", Status: "partial", Members: members}
	root.appPackages[1].LastRun = run
	root.packageManagerVisible = true
	root.interaction.OpenTransient(interaction.TransientPackageManager)
	root.packageManagerSelectedID = "pkg_web"
	root.packageManagerSurface = packageManagerSurfaceRun
	updated, _ := root.Update(tea.WindowSizeMsg{Width: 88, Height: 18})
	root = updated.(RootModel)
	updated, _ = root.Update(keyPress("end"))
	root = updated.(RootModel)
	wantEnd := len(members) - packageRunViewportRows(root.height)
	if root.packageManagerRunOffset != wantEnd {
		t.Fatalf("End run offset=%d want=%d", root.packageManagerRunOffset, wantEnd)
	}
	updated, _ = root.Update(keyPress("home"))
	root = updated.(RootModel)
	if root.packageManagerRunOffset != 0 {
		t.Fatalf("Home did not reset run offset: %d", root.packageManagerRunOffset)
	}
	updated, _ = root.Update(tea.MouseWheelMsg{X: 44, Y: 8, Button: tea.MouseWheelDown})
	root = updated.(RootModel)
	if root.packageManagerRunOffset == 0 || root.packageManagerSurface != packageManagerSurfaceRun {
		t.Fatalf("run-detail wheel did not scroll within modal: offset=%d surface=%s", root.packageManagerRunOffset, root.packageManagerSurface)
	}
	if root.appInventory.SelectedID() != "notes" {
		t.Fatalf("run-detail wheel changed background app selection: %q", root.appInventory.SelectedID())
	}
}

func TestPackageRefreshFailsClosedWhenEditedStableIDDisappears(t *testing.T) {
	root := packageTestRoot(t)
	root.packageManagerVisible = true
	root.interaction.OpenTransient(interaction.TransientPackageManager)
	root.packageManagerSelectedID = "pkg_web"
	root.packageManagerSurface = packageManagerSurfaceMembers
	root.packageManagerMembers = []string{"worker", "notes"}
	updated, _ := root.Update(commands.AppPackagesLoadedMsg{Packages: []relaybaseclient.AppPackageDefinition{packageFixture("pkg_api", "API services", "worker")}})
	root = updated.(RootModel)
	if root.packageManagerSurface != packageManagerSurfaceTable || root.packageManagerSelectedID != "pkg_api" || root.packageManagerMembers != nil {
		t.Fatalf("refresh retargeted a stale edit instead of failing closed: surface=%s selected=%q members=%v", root.packageManagerSurface, root.packageManagerSelectedID, root.packageManagerMembers)
	}
	if !strings.Contains(root.packageManagerNotice, "no longer exists") || !strings.Contains(root.packageManagerNotice, "without applying") {
		t.Fatalf("missing package recovery guidance is unclear: %q", root.packageManagerNotice)
	}
}
