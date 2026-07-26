package commands

import (
	"context"
	"sync/atomic"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/bootstrap"
	"github.com/cameloo/relaybase/tui/internal/preferences"
	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/panes"
)

type StateLoadedMsg struct {
	State      *relaybaseclient.RelaybaseState
	Generation uint64
}

type StateFailedMsg struct {
	Err        error
	Generation uint64
}

var stateFetchGeneration atomic.Uint64

type LogsLoadedMsg struct {
	Target   panes.LogTarget
	Snapshot *relaybaseclient.LogSnapshot
}

type LogsFailedMsg struct {
	Target panes.LogTarget
	Err    error
}

type PreferencesSavedMsg struct{}

type PreferencesSaveFailedMsg struct {
	Err error
}

type DaemonBootstrapStatusMsg struct {
	Result *bootstrap.DaemonResult
}

type DaemonBootstrapEnsureMsg struct {
	Result *bootstrap.DaemonResult
}

type DaemonBootstrapRestartMsg struct {
	Result *bootstrap.DaemonResult
}

type DaemonBootstrapFailedMsg struct {
	Action string
	Err    error
}

type LifecycleRequestedMsg struct {
	Action      string
	AppID       string
	OperationID string
}

type LifecycleRequestFailedMsg struct {
	Action string
	AppID  string
	Err    error
}

type AppUnregisterPreviewedMsg struct {
	AppID   string
	Preview *relaybaseclient.AppUnregisterPreview
}

type AppUnregisterPreviewFailedMsg struct {
	AppID string
	Err   error
}

type AppUnregisteredMsg struct {
	AppID  string
	Result *relaybaseclient.AppUnregisterResult
}

type AppUnregisterFailedMsg struct {
	AppID string
	Err   error
}

type AppRenamePreviewedMsg struct {
	AppID   string
	Preview *relaybaseclient.AppRenamePreview
}

type AppRenamePreviewFailedMsg struct {
	AppID string
	Err   error
}

type AppRenamedMsg struct {
	AppID  string
	Result *relaybaseclient.AppRenameResult
}

type AppRenameFailedMsg struct {
	AppID string
	Err   error
}

type LogsExportedMsg struct {
	Request relaybaseclient.LogExportRequest
	Result  *relaybaseclient.LogExportResult
}

type LogsExportFailedMsg struct {
	Request relaybaseclient.LogExportRequest
	Err     error
}

type SetupDetectCompletedMsg struct {
	Request relaybaseclient.SetupDetectRequest
	Result  *relaybaseclient.SetupDetectResult
}

type SetupPlansCompletedMsg struct {
	Request relaybaseclient.SetupPlanRequest
	Result  *relaybaseclient.SetupPlansResult
}

type SetupPreviewCompletedMsg struct {
	Request relaybaseclient.SetupPlanRequest
	Result  *relaybaseclient.SetupPlanPreview
}

type SetupApplyCompletedMsg struct {
	Request relaybaseclient.SetupApplyRequest
	Result  *relaybaseclient.SetupApplyResult
}

type SetupRegisterCompletedMsg struct {
	Request relaybaseclient.RegisterManifestRequest
	Result  *relaybaseclient.RegisterManifestResult
}

type SetupRegistrationPreviewCompletedMsg struct {
	Request relaybaseclient.RegistrationPreviewRequest
	Result  *relaybaseclient.RegistrationSetupResult
}

type SetupRegistrationApplyCompletedMsg struct {
	Request relaybaseclient.RegistrationApplyRequest
	Result  *relaybaseclient.RegistrationSetupResult
}

type SetupRegistrationCancelCompletedMsg struct {
	Result *relaybaseclient.RegistrationVerificationCancelResult
}

type SetupRegistrationRepairPreviewCompletedMsg struct {
	Request relaybaseclient.RegistrationRepairPreviewRequest
	Result  *relaybaseclient.RegistrationRepairPreviewResult
}

type SetupRegistrationRepairApplyCompletedMsg struct {
	Request relaybaseclient.RegistrationRepairApplyRequest
	Result  *relaybaseclient.RegistrationSetupResult
}

type SetupManifestInspectCompletedMsg struct {
	Request relaybaseclient.RegisterManifestRequest
	Result  *relaybaseclient.ExistingManifestAnalysis
}

type SetupManifestValidateCompletedMsg struct {
	Request relaybaseclient.RegisterManifestRequest
	Result  *relaybaseclient.ExistingManifestAnalysis
}

type SetupManifestPatchPreviewCompletedMsg struct {
	Request relaybaseclient.ManifestPatchRequest
	Result  *relaybaseclient.ManifestPatchPlan
}

type SetupManifestPatchApplyCompletedMsg struct {
	Request relaybaseclient.ManifestPatchRequest
	Result  *relaybaseclient.ManifestPatchResult
}

type SetupOpenCompletedMsg struct {
	Request relaybaseclient.OpenProjectRequest
	Result  *relaybaseclient.OpenProjectResult
}

type SetupProveCompletedMsg struct {
	Request relaybaseclient.ProveHealthRequest
	Result  *relaybaseclient.ProveHealthResult
}

type SetupRepairCompletedMsg struct {
	Request relaybaseclient.RepairSetupRequest
	Result  *relaybaseclient.RepairSetupResult
}

type SetupFailedMsg struct {
	Action string
	Err    error
}

type AgentConfigLoadedMsg struct {
	Config *relaybaseclient.AgentConfig
}

type AgentConfigFailedMsg struct {
	Err error
}

type AgentConfigUpdatedMsg struct {
	Config *relaybaseclient.AgentConfig
}

type AgentConfigUpdateFailedMsg struct {
	Err error
}

type AgentConfigReloadedMsg struct {
	Result *relaybaseclient.AgentConfigReloadResult
}

type AgentConfigReloadFailedMsg struct {
	Err error
}

type AgentProviderStatusLoadedMsg struct {
	Status *relaybaseclient.AgentProviderStatus
}

type AgentProviderStatusFailedMsg struct {
	Err error
}

type AgentProviderConnectionStartedMsg struct {
	Attempt *relaybaseclient.AgentProviderAttempt
}

type AgentProviderActionCompletedMsg struct {
	Action string
	Config *relaybaseclient.AgentConfig
}

type AgentProviderActionFailedMsg struct {
	Action string
	Err    error
}

type AgentProviderRevokePreviewLoadedMsg struct {
	Preview *relaybaseclient.AgentProviderRevokePreview
}

type AgentLegacyCredentialRemovalPreviewLoadedMsg struct {
	Preview *relaybaseclient.AgentLegacyCredentialRemovalPreview
}

type AgentLegacyCredentialRemovalCompletedMsg struct {
	Result *relaybaseclient.AgentLegacyCredentialRemovalResult
}

type AgentSecurityStatusLoadedMsg struct {
	Status *relaybaseclient.AgentSecurityStatus
}

type AgentSecurityRepairPreviewLoadedMsg struct {
	Preview *relaybaseclient.AgentSecurityRepairPreview
}

type AgentSecurityRepairOperationLoadedMsg struct {
	Operation *relaybaseclient.AgentSecurityRepairOperation
}

type AgentSecurityLatestOperationLoadedMsg struct {
	Operation *relaybaseclient.AgentSecurityRepairOperation
}

type AgentSecurityActionFailedMsg struct {
	Action string
	Err    error
}

type AgentDiagnosticsLoadedMsg struct {
	Diagnostics []relaybaseclient.AgentDiagnostic
}

type AgentDiagnosticsFailedMsg struct {
	Err error
}

type AgentUsageLoadedMsg struct {
	Usage      *relaybaseclient.AgentUsageSnapshot
	Generation uint64
}
type AgentUsageFailedMsg struct {
	Err        error
	Generation uint64
}

type AgentSessionCreatedMsg struct {
	Session *relaybaseclient.AgentSession
}

type AgentSessionCreateFailedMsg struct {
	Err error
}

type AgentActiveSessionLoadedMsg struct {
	Session *relaybaseclient.AgentSession
}

type AgentActiveSessionFailedMsg struct {
	Err error
}

type AgentSessionsListedMsg struct {
	Sessions []relaybaseclient.AgentSession
}

type AgentSessionsListFailedMsg struct {
	Err error
}

type AgentSessionActivatedMsg struct {
	Session *relaybaseclient.AgentSession
}

type AgentSessionActivateFailedMsg struct {
	SessionID string
	Err       error
}

type AgentSessionUpdatedMsg struct {
	Session *relaybaseclient.AgentSession
	Action  string
}

type AgentSessionUpdateFailedMsg struct {
	SessionID string
	Action    string
	Err       error
}

type AgentSessionClearedMsg struct {
	Result *relaybaseclient.AgentSessionClearResult
}

type AgentSessionClearFailedMsg struct {
	SessionID string
	Err       error
}

type AgentSessionExportedMsg struct {
	Result *relaybaseclient.AgentSessionExportResult
}

type AgentSessionExportFailedMsg struct {
	SessionID string
	Format    string
	Err       error
}

type AgentSessionContextPreviewLoadedMsg struct {
	Preview *relaybaseclient.AgentThreadContextPreview
}

type AgentSessionContextPreviewFailedMsg struct {
	SessionID string
	Err       error
}

type AgentMessageSentMsg struct {
	Result     *relaybaseclient.AgentMessageResult
	SessionID  string
	Generation uint64
}

type AgentMessageSendFailedMsg struct {
	Err        error
	SessionID  string
	Generation uint64
}

type AgentEventsConnectedMsg struct {
	Stream     *relaybaseclient.AgentEventStream
	SessionID  string
	Generation uint64
}

type AgentEventMsg struct {
	Stream     *relaybaseclient.AgentEventStream
	Event      relaybaseclient.AgentRunEvent
	SessionID  string
	Generation uint64
}

type AgentEventsDisconnectedMsg struct {
	Err        error
	SessionID  string
	Generation uint64
}

type AgentApprovalResolvedMsg struct {
	Approval *relaybaseclient.AgentApproval
	Status   string
}

type AgentApprovalResolveFailedMsg struct {
	ApprovalID string
	Status     string
	Err        error
}

func FetchStateCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	generation := stateFetchGeneration.Add(1)
	return func() tea.Msg {
		state, err := client.GetState(ctx)
		if err != nil {
			return StateFailedMsg{Err: err, Generation: generation}
		}
		return StateLoadedMsg{State: state, Generation: generation}
	}
}

func FetchAgentConfigCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		config, err := client.GetAgentConfig(ctx)
		if err != nil {
			return AgentConfigFailedMsg{Err: err}
		}
		return AgentConfigLoadedMsg{Config: config}
	}
}

func UpdateAgentConfigCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.AgentConfigUpdateRequest) tea.Cmd {
	return func() tea.Msg {
		config, err := client.UpdateAgentConfig(ctx, request)
		if err != nil {
			return AgentConfigUpdateFailedMsg{Err: err}
		}
		return AgentConfigUpdatedMsg{Config: config}
	}
}

func ReloadAgentConfigCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ReloadAgentConfig(ctx)
		if err != nil {
			return AgentConfigReloadFailedMsg{Err: err}
		}
		return AgentConfigReloadedMsg{Result: result}
	}
}

func FetchAgentProviderStatusCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		status, err := client.GetAgentProviderStatus(ctx)
		if err != nil {
			return AgentProviderStatusFailedMsg{Err: err}
		}
		return AgentProviderStatusLoadedMsg{Status: status}
	}
}

func StartAgentProviderConnectionCmd(ctx context.Context, client *relaybaseclient.Client, mode string) tea.Cmd {
	return func() tea.Msg {
		attempt, err := client.StartAgentProviderConnection(ctx, mode)
		if err != nil {
			return AgentProviderActionFailedMsg{Action: mode, Err: err}
		}
		return AgentProviderConnectionStartedMsg{Attempt: attempt}
	}
}

func DisconnectAgentProviderCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		result, err := client.DisconnectAgentProvider(ctx)
		if err != nil {
			return AgentProviderActionFailedMsg{Action: "disconnect", Err: err}
		}
		return AgentProviderActionCompletedMsg{Action: "disconnect", Config: &result.Config}
	}
}

func MigrateAgentProviderCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		result, err := client.MigrateAgentProvider(ctx)
		if err != nil {
			return AgentProviderActionFailedMsg{Action: "migrate", Err: err}
		}
		return AgentProviderActionCompletedMsg{Action: "migrate", Config: &result.Config}
	}
}

func ValidateAgentProviderCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ValidateAgentProvider(ctx)
		if err != nil {
			return AgentProviderActionFailedMsg{Action: "validation", Err: err}
		}
		return AgentProviderActionCompletedMsg{Action: "validate", Config: &result.Config}
	}
}

func PreviewAgentProviderRevokeCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		preview, err := client.PreviewAgentProviderRevoke(ctx)
		if err != nil {
			return AgentProviderActionFailedMsg{Action: "revoke", Err: err}
		}
		return AgentProviderRevokePreviewLoadedMsg{Preview: preview}
	}
}

func PreviewLegacyAgentCredentialRemovalCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		preview, err := client.PreviewLegacyAgentCredentialRemoval(ctx)
		if err != nil {
			return AgentProviderActionFailedMsg{Action: "legacy cleanup preview", Err: err}
		}
		return AgentLegacyCredentialRemovalPreviewLoadedMsg{Preview: preview}
	}
}

func ApplyLegacyAgentCredentialRemovalCmd(ctx context.Context, client *relaybaseclient.Client, previewID string) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ApplyLegacyAgentCredentialRemoval(ctx, previewID)
		if err != nil {
			return AgentProviderActionFailedMsg{Action: "legacy cleanup", Err: err}
		}
		return AgentLegacyCredentialRemovalCompletedMsg{Result: result}
	}
}

func DiagnoseAgentSecurityCmd(ctx context.Context, client *relaybaseclient.Client, online bool) tea.Cmd {
	return func() tea.Msg {
		status, err := client.DiagnoseAgentSecurity(ctx, online)
		if err != nil {
			return AgentSecurityActionFailedMsg{Action: "security check", Err: err}
		}
		return AgentSecurityStatusLoadedMsg{Status: status}
	}
}

func PreviewAgentSecurityRepairCmd(
	ctx context.Context,
	client *relaybaseclient.Client,
	request relaybaseclient.AgentSecurityRepairPreviewRequest,
) tea.Cmd {
	return func() tea.Msg {
		preview, err := client.PreviewAgentSecurityRepair(ctx, request)
		if err != nil {
			return AgentSecurityActionFailedMsg{Action: "repair preview", Err: err}
		}
		return AgentSecurityRepairPreviewLoadedMsg{Preview: preview}
	}
}

func ApplyAgentSecurityRepairCmd(
	ctx context.Context,
	client *relaybaseclient.Client,
	previewID string,
	idempotencyKey string,
	confirmation string,
) tea.Cmd {
	return func() tea.Msg {
		operation, err := client.ApplyAgentSecurityRepair(ctx, previewID, idempotencyKey, confirmation)
		if err != nil {
			return AgentSecurityActionFailedMsg{Action: "repair apply", Err: err}
		}
		return AgentSecurityRepairOperationLoadedMsg{Operation: operation}
	}
}

func FetchLatestAgentSecurityRepairOperationCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		operation, err := client.GetLatestAgentSecurityRepairOperation(ctx)
		if err != nil {
			return AgentSecurityActionFailedMsg{Action: "repair receipt recovery", Err: err}
		}
		return AgentSecurityLatestOperationLoadedMsg{Operation: operation}
	}
}

func FetchAgentDiagnosticsCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		diagnostics, err := client.GetAgentDiagnostics(ctx)
		if err != nil {
			return AgentDiagnosticsFailedMsg{Err: err}
		}
		return AgentDiagnosticsLoadedMsg{Diagnostics: diagnostics}
	}
}

func FetchAgentUsageCmd(ctx context.Context, client *relaybaseclient.Client, generation uint64) tea.Cmd {
	return func() tea.Msg {
		value, err := client.GetActiveAgentUsage(ctx)
		if err != nil {
			return AgentUsageFailedMsg{Err: err, Generation: generation}
		}
		return AgentUsageLoadedMsg{Usage: value, Generation: generation}
	}
}

func CreateAgentSessionCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.AgentSessionCreateRequest) tea.Cmd {
	return func() tea.Msg {
		session, err := client.CreateAgentSession(ctx, request)
		if err != nil {
			return AgentSessionCreateFailedMsg{Err: err}
		}
		return AgentSessionCreatedMsg{Session: session}
	}
}

func FetchActiveAgentSessionCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		session, err := client.GetActiveAgentSession(ctx)
		if err != nil {
			return AgentActiveSessionFailedMsg{Err: err}
		}
		return AgentActiveSessionLoadedMsg{Session: session}
	}
}

func ListAgentSessionsCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		sessions, err := client.ListAgentSessions(ctx)
		if err != nil {
			return AgentSessionsListFailedMsg{Err: err}
		}
		return AgentSessionsListedMsg{Sessions: sessions}
	}
}

func ActivateAgentSessionCmd(ctx context.Context, client *relaybaseclient.Client, sessionID string) tea.Cmd {
	return func() tea.Msg {
		session, err := client.ActivateAgentSession(ctx, sessionID)
		if err != nil {
			return AgentSessionActivateFailedMsg{SessionID: sessionID, Err: err}
		}
		return AgentSessionActivatedMsg{Session: session}
	}
}

func UpdateAgentSessionCmd(ctx context.Context, client *relaybaseclient.Client, sessionID string, request relaybaseclient.AgentSessionUpdateRequest, action string) tea.Cmd {
	return func() tea.Msg {
		session, err := client.UpdateAgentSession(ctx, sessionID, request)
		if err != nil {
			return AgentSessionUpdateFailedMsg{SessionID: sessionID, Action: action, Err: err}
		}
		return AgentSessionUpdatedMsg{Session: session, Action: action}
	}
}

func ClearAgentSessionCmd(ctx context.Context, client *relaybaseclient.Client, sessionID string) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ClearAgentSession(ctx, sessionID)
		if err != nil {
			return AgentSessionClearFailedMsg{SessionID: sessionID, Err: err}
		}
		return AgentSessionClearedMsg{Result: result}
	}
}

func ExportAgentSessionCmd(ctx context.Context, client *relaybaseclient.Client, sessionID string, request relaybaseclient.AgentSessionExportRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ExportAgentSession(ctx, sessionID, request)
		if err != nil {
			return AgentSessionExportFailedMsg{SessionID: sessionID, Format: request.Format, Err: err}
		}
		return AgentSessionExportedMsg{Result: result}
	}
}

func FetchAgentSessionContextPreviewCmd(ctx context.Context, client *relaybaseclient.Client, sessionID string) tea.Cmd {
	return func() tea.Msg {
		preview, err := client.GetAgentSessionContextPreview(ctx, sessionID)
		if err != nil {
			return AgentSessionContextPreviewFailedMsg{SessionID: sessionID, Err: err}
		}
		return AgentSessionContextPreviewLoadedMsg{Preview: preview}
	}
}

func SendAgentMessageCmd(ctx context.Context, client *relaybaseclient.Client, sessionID string, request relaybaseclient.AgentMessageRequest, generation uint64) tea.Cmd {
	return func() tea.Msg {
		result, err := client.SendAgentMessage(ctx, sessionID, request)
		if err != nil {
			return AgentMessageSendFailedMsg{Err: err, SessionID: sessionID, Generation: generation}
		}
		return AgentMessageSentMsg{Result: result, SessionID: sessionID, Generation: generation}
	}
}

func ConnectAgentEventsCmd(ctx context.Context, client *relaybaseclient.Client, sessionID string, generation uint64) tea.Cmd {
	return func() tea.Msg {
		stream, err := client.StreamAgentSessionEvents(ctx, sessionID)
		if err != nil {
			return AgentEventsDisconnectedMsg{Err: err, SessionID: sessionID, Generation: generation}
		}
		return AgentEventsConnectedMsg{Stream: stream, SessionID: sessionID, Generation: generation}
	}
}

func NextAgentEventCmd(ctx context.Context, stream *relaybaseclient.AgentEventStream, sessionID string, generation uint64) tea.Cmd {
	return func() tea.Msg {
		event, err := stream.Next(ctx)
		if err != nil {
			return AgentEventsDisconnectedMsg{Err: err, SessionID: sessionID, Generation: generation}
		}
		return AgentEventMsg{Stream: stream, Event: event, SessionID: sessionID, Generation: generation}
	}
}

func ApproveAgentApprovalCmd(ctx context.Context, client *relaybaseclient.Client, approvalID string, requests ...relaybaseclient.AgentApprovalResolutionRequest) tea.Cmd {
	return func() tea.Msg {
		request := relaybaseclient.AgentApprovalResolutionRequest{}
		if len(requests) > 0 {
			request = requests[0]
		}
		approval, err := client.ApproveAgentToolCall(ctx, approvalID, request)
		if err != nil {
			return AgentApprovalResolveFailedMsg{ApprovalID: approvalID, Status: "approved", Err: err}
		}
		return AgentApprovalResolvedMsg{Approval: approval, Status: "approved"}
	}
}

func RejectAgentApprovalCmd(ctx context.Context, client *relaybaseclient.Client, approvalID string, reason string) tea.Cmd {
	return func() tea.Msg {
		approval, err := client.RejectAgentToolCall(ctx, approvalID, relaybaseclient.AgentApprovalResolutionRequest{Reason: reason})
		if err != nil {
			return AgentApprovalResolveFailedMsg{ApprovalID: approvalID, Status: "rejected", Err: err}
		}
		return AgentApprovalResolvedMsg{Approval: approval, Status: "rejected"}
	}
}

func FetchLogsCmd(ctx context.Context, client *relaybaseclient.Client, target panes.LogTarget) tea.Cmd {
	return func() tea.Msg {
		snapshot, err := client.QueryLogs(ctx, target.AppID, relaybaseclient.LogQuery{
			Limit:  target.Limit,
			Before: target.Before,
		})
		if err != nil {
			return LogsFailedMsg{Target: target, Err: err}
		}
		return LogsLoadedMsg{Target: target, Snapshot: snapshot}
	}
}

func FetchLogsBatchCmd(ctx context.Context, client *relaybaseclient.Client, targets []panes.LogTarget) tea.Cmd {
	if len(targets) == 0 {
		return nil
	}
	cmds := make([]tea.Cmd, 0, len(targets))
	for _, target := range targets {
		cmds = append(cmds, FetchLogsCmd(ctx, client, target))
	}
	return tea.Batch(cmds...)
}

func SavePreferencesCmd(store preferences.Store, prefs preferences.Preferences) tea.Cmd {
	return func() tea.Msg {
		if err := store.Save(prefs); err != nil {
			return PreferencesSaveFailedMsg{Err: err}
		}
		return PreferencesSavedMsg{}
	}
}

func DaemonBootstrapStatusCmd(ctx context.Context, client *bootstrap.Client) tea.Cmd {
	return func() tea.Msg {
		result, err := client.Status(ctx)
		if err != nil {
			return DaemonBootstrapFailedMsg{Action: "daemon status", Err: err}
		}
		return DaemonBootstrapStatusMsg{Result: result}
	}
}

func DaemonBootstrapEnsureCmd(ctx context.Context, client *bootstrap.Client) tea.Cmd {
	return func() tea.Msg {
		result, err := client.Ensure(ctx)
		if err != nil {
			return DaemonBootstrapFailedMsg{Action: "daemon repair", Err: err}
		}
		return DaemonBootstrapEnsureMsg{Result: result}
	}
}

func DaemonBootstrapRestartCmd(ctx context.Context, client *bootstrap.Client) tea.Cmd {
	return func() tea.Msg {
		result, err := client.Restart(ctx)
		if err != nil {
			return DaemonBootstrapFailedMsg{Action: "daemon restart", Err: err}
		}
		return DaemonBootstrapRestartMsg{Result: result}
	}
}

func LifecycleRequestCmd(ctx context.Context, client *relaybaseclient.Client, appID string, action string) tea.Cmd {
	return func() tea.Msg {
		result, err := client.RequestLifecycle(ctx, appID, action)
		if err != nil {
			return LifecycleRequestFailedMsg{Action: action, AppID: appID, Err: err}
		}
		return LifecycleRequestedMsg{Action: action, AppID: appID, OperationID: result.OperationID}
	}
}

func LifecycleRequestBatchCmd(ctx context.Context, client *relaybaseclient.Client, appIDs []string, action string) tea.Cmd {
	if len(appIDs) == 0 {
		return nil
	}
	cmds := make([]tea.Cmd, 0, len(appIDs))
	for _, appID := range appIDs {
		cmds = append(cmds, LifecycleRequestCmd(ctx, client, appID, action))
	}
	return tea.Batch(cmds...)
}

func PreviewAppUnregisterCmd(ctx context.Context, client *relaybaseclient.Client, appID string) tea.Cmd {
	return func() tea.Msg {
		preview, err := client.PreviewAppUnregister(ctx, appID)
		if err != nil {
			return AppUnregisterPreviewFailedMsg{AppID: appID, Err: err}
		}
		return AppUnregisterPreviewedMsg{AppID: appID, Preview: preview}
	}
}

func UnregisterAppCmd(ctx context.Context, client *relaybaseclient.Client, appID string) tea.Cmd {
	return func() tea.Msg {
		result, err := client.UnregisterApp(ctx, appID)
		if err != nil {
			return AppUnregisterFailedMsg{AppID: appID, Err: err}
		}
		return AppUnregisteredMsg{AppID: appID, Result: result}
	}
}

func PreviewAppRenameCmd(ctx context.Context, client *relaybaseclient.Client, appID string, name string) tea.Cmd {
	return func() tea.Msg {
		preview, err := client.PreviewAppRename(ctx, appID, name)
		if err != nil {
			return AppRenamePreviewFailedMsg{AppID: appID, Err: err}
		}
		return AppRenamePreviewedMsg{AppID: appID, Preview: preview}
	}
}

func RenameAppCmd(ctx context.Context, client *relaybaseclient.Client, appID string, previewID string) tea.Cmd {
	return func() tea.Msg {
		result, err := client.RenameApp(ctx, appID, previewID)
		if err != nil {
			return AppRenameFailedMsg{AppID: appID, Err: err}
		}
		return AppRenamedMsg{AppID: appID, Result: result}
	}
}

func ExportLogsCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.LogExportRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ExportLogs(ctx, request)
		if err != nil {
			return LogsExportFailedMsg{Request: request, Err: err}
		}
		return LogsExportedMsg{Request: request, Result: result}
	}
}

func SetupDetectCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.SetupDetectRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.DetectProject(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "detect setup", Err: err}
		}
		return SetupDetectCompletedMsg{Request: request, Result: result}
	}
}

func SetupPlansCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.SetupPlanRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.CreateSetupPlans(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "create setup plans", Err: err}
		}
		return SetupPlansCompletedMsg{Request: request, Result: result}
	}
}

func SetupPreviewCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.SetupPlanRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.PreviewSetupPlan(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "preview setup plan", Err: err}
		}
		return SetupPreviewCompletedMsg{Request: request, Result: result}
	}
}

func SetupApplyCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.SetupApplyRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ApplySetupPlan(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "apply setup plan", Err: err}
		}
		return SetupApplyCompletedMsg{Request: request, Result: result}
	}
}

func SetupRegisterManifestCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.RegisterManifestRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.RegisterManifest(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "register manifest", Err: err}
		}
		return SetupRegisterCompletedMsg{Request: request, Result: result}
	}
}

func SetupRegistrationPreviewCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.RegistrationPreviewRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.PreviewRegistration(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "preview registration", Err: err}
		}
		return SetupRegistrationPreviewCompletedMsg{Request: request, Result: result}
	}
}

func SetupRegistrationApplyCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.RegistrationApplyRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ApplyRegistration(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "apply registration", Err: err}
		}
		return SetupRegistrationApplyCompletedMsg{Request: request, Result: result}
	}
}

func SetupRegistrationCancelCmd(ctx context.Context, client *relaybaseclient.Client, appID string) tea.Cmd {
	return func() tea.Msg {
		result, err := client.CancelRegistrationVerification(ctx, appID)
		if err != nil {
			return SetupFailedMsg{Action: "cancel registration verification", Err: err}
		}
		return SetupRegistrationCancelCompletedMsg{Result: result}
	}
}

func SetupRegistrationRepairPreviewCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.RegistrationRepairPreviewRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.PreviewRegistrationRepair(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "preview registration repair", Err: err}
		}
		return SetupRegistrationRepairPreviewCompletedMsg{Request: request, Result: result}
	}
}

func SetupRegistrationRepairApplyCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.RegistrationRepairApplyRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ApplyRegistrationRepair(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "apply registration repair", Err: err}
		}
		return SetupRegistrationRepairApplyCompletedMsg{Request: request, Result: result}
	}
}

func SetupInspectManifestCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.RegisterManifestRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.InspectManifest(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "inspect manifest", Err: err}
		}
		return SetupManifestInspectCompletedMsg{Request: request, Result: result}
	}
}

func SetupValidateManifestCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.RegisterManifestRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ValidateManifest(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "validate manifest", Err: err}
		}
		return SetupManifestValidateCompletedMsg{Request: request, Result: result}
	}
}

func SetupPreviewManifestPatchCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.ManifestPatchRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.PreviewManifestPatch(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "preview manifest patch", Err: err}
		}
		return SetupManifestPatchPreviewCompletedMsg{Request: request, Result: result}
	}
}

func SetupApplyManifestPatchCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.ManifestPatchRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ApplyManifestPatch(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "apply manifest patch", Err: err}
		}
		return SetupManifestPatchApplyCompletedMsg{Request: request, Result: result}
	}
}

func SetupOpenCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.OpenProjectRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.OpenProjectOrApp(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "open setup target", Err: err}
		}
		return SetupOpenCompletedMsg{Request: request, Result: result}
	}
}

func SetupProveCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.ProveHealthRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ProveHealth(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "prove setup health", Err: err}
		}
		return SetupProveCompletedMsg{Request: request, Result: result}
	}
}

func SetupRepairCmd(ctx context.Context, client *relaybaseclient.Client, request relaybaseclient.RepairSetupRequest) tea.Cmd {
	return func() tea.Msg {
		result, err := client.RepairSetup(ctx, request)
		if err != nil {
			return SetupFailedMsg{Action: "repair setup", Err: err}
		}
		return SetupRepairCompletedMsg{Request: request, Result: result}
	}
}
