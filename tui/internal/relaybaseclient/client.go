package relaybaseclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

var ErrMissingToken = errors.New("relaybase auth token is missing")

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

type APIError struct {
	StatusCode int
	ErrorBody  RelaybaseError
}

func (e *APIError) Error() string {
	if e.ErrorBody.Message != "" {
		return e.ErrorBody.Message
	}
	return fmt.Sprintf("relaybase API error: status %d", e.StatusCode)
}

func New(baseURL string, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   strings.TrimSpace(token),
		http:    httpClient,
	}
}

func (c *Client) BaseURL() string {
	return c.baseURL
}

func (c *Client) HasToken() bool {
	return c.token != ""
}

func (c *Client) GetState(ctx context.Context) (*RelaybaseState, error) {
	var state RelaybaseState
	raw, err := c.getJSON(ctx, "/__hub/api/state", &state)
	if err != nil {
		return nil, err
	}
	state.Raw = raw
	return &state, nil
}

func (c *Client) OpenEvents(ctx context.Context) (*EventStream, error) {
	req, err := c.newRequest(ctx, http.MethodGet, "/__hub/api/events", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, decodeAPIError(resp)
	}
	return newEventStream(resp), nil
}

func (c *Client) RequestLifecycle(ctx context.Context, appID string, action string) (*LifecycleOperationResponse, error) {
	switch action {
	case "start", "stop", "restart":
	default:
		return nil, fmt.Errorf("unsupported lifecycle action: %s", action)
	}
	path := fmt.Sprintf("/__hub/api/apps/%s/%s?async=true", url.PathEscape(appID), action)
	var result LifecycleOperationResponse
	if _, err := c.postJSON(ctx, path, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) QueryLogs(ctx context.Context, appID string, query LogQuery) (*LogSnapshot, error) {
	values := url.Values{}
	if query.Limit > 0 {
		values.Set("limit", fmt.Sprintf("%d", query.Limit))
	}
	if query.Before != "" {
		values.Set("before", query.Before)
	}
	if query.After != "" {
		values.Set("after", query.After)
	}

	path := fmt.Sprintf("/__hub/api/apps/%s/logs", url.PathEscape(appID))
	if encoded := values.Encode(); encoded != "" {
		path += "?" + encoded
	}

	var snapshot LogSnapshot
	raw, err := c.getJSON(ctx, path, &snapshot)
	if err != nil {
		return nil, err
	}
	snapshot.Raw = raw
	return &snapshot, nil
}

func (c *Client) ExportLogs(ctx context.Context, request LogExportRequest) (*LogExportResult, error) {
	var response LogExportResponse
	if _, err := c.postJSON(ctx, "/__hub/api/logs/export", request, &response); err != nil {
		return nil, err
	}
	return &response.Export, nil
}

func (c *Client) ExportStatus(ctx context.Context, exportID string) (*LogExportResult, error) {
	var response LogExportResponse
	path := fmt.Sprintf("/__hub/api/exports/%s", url.PathEscape(exportID))
	if _, err := c.getJSON(ctx, path, &response); err != nil {
		return nil, err
	}
	return &response.Export, nil
}

func (c *Client) GetAgentConfig(ctx context.Context) (*AgentConfig, error) {
	var response struct {
		Agent struct {
			Config AgentConfig `json:"config"`
		} `json:"agent"`
	}
	if _, err := c.getJSON(ctx, "/__hub/api/agent/config", &response); err != nil {
		return nil, err
	}
	return &response.Agent.Config, nil
}

func (c *Client) UpdateAgentConfig(ctx context.Context, update AgentConfigUpdate) (*AgentConfig, error) {
	var response struct {
		Agent struct {
			Config AgentConfig `json:"config"`
		} `json:"agent"`
	}
	if _, err := c.putJSON(ctx, "/__hub/api/agent/config", update, &response); err != nil {
		return nil, err
	}
	return &response.Agent.Config, nil
}

func (c *Client) CreateAgentSession(ctx context.Context, request AgentSessionCreateRequest) (*AgentSession, error) {
	var response struct {
		Agent struct {
			Session AgentSession `json:"session"`
		} `json:"agent"`
	}
	if _, err := c.postJSON(ctx, "/__hub/api/agent/sessions", request, &response); err != nil {
		return nil, err
	}
	return &response.Agent.Session, nil
}

func (c *Client) ListAgentSessions(ctx context.Context) ([]AgentSession, error) {
	var response struct {
		Agent struct {
			Sessions []AgentSession `json:"sessions"`
		} `json:"agent"`
	}
	if _, err := c.getJSON(ctx, "/__hub/api/agent/sessions", &response); err != nil {
		return nil, err
	}
	return response.Agent.Sessions, nil
}

func (c *Client) GetActiveAgentSession(ctx context.Context) (*AgentSession, error) {
	var response struct {
		Agent struct {
			Session *AgentSession `json:"session"`
		} `json:"agent"`
	}
	if _, err := c.getJSON(ctx, "/__hub/api/agent/sessions/active", &response); err != nil {
		return nil, err
	}
	return response.Agent.Session, nil
}

func (c *Client) GetAgentSession(ctx context.Context, sessionID string) (*AgentSession, error) {
	var response struct {
		Agent struct {
			Session AgentSession `json:"session"`
		} `json:"agent"`
	}
	path := fmt.Sprintf("/__hub/api/agent/sessions/%s", url.PathEscape(sessionID))
	if _, err := c.getJSON(ctx, path, &response); err != nil {
		return nil, err
	}
	return &response.Agent.Session, nil
}

func (c *Client) ActivateAgentSession(ctx context.Context, sessionID string) (*AgentSession, error) {
	var response struct {
		Agent struct {
			Session AgentSession `json:"session"`
		} `json:"agent"`
	}
	path := fmt.Sprintf("/__hub/api/agent/sessions/%s/activate", url.PathEscape(sessionID))
	if _, err := c.postJSON(ctx, path, map[string]any{}, &response); err != nil {
		return nil, err
	}
	return &response.Agent.Session, nil
}

func (c *Client) UpdateAgentSession(ctx context.Context, sessionID string, request AgentSessionUpdateRequest) (*AgentSession, error) {
	var response struct {
		Agent struct {
			Session AgentSession `json:"session"`
		} `json:"agent"`
	}
	path := fmt.Sprintf("/__hub/api/agent/sessions/%s", url.PathEscape(sessionID))
	if _, err := c.patchJSON(ctx, path, request, &response); err != nil {
		return nil, err
	}
	return &response.Agent.Session, nil
}

func (c *Client) ClearAgentSession(ctx context.Context, sessionID string) (*AgentSessionClearResult, error) {
	var response struct {
		Agent struct {
			Session AgentSessionClearResult `json:"session"`
		} `json:"agent"`
	}
	path := fmt.Sprintf("/__hub/api/agent/sessions/%s/clear", url.PathEscape(sessionID))
	if _, err := c.postJSON(ctx, path, map[string]any{}, &response); err != nil {
		return nil, err
	}
	return &response.Agent.Session, nil
}

func (c *Client) ExportAgentSession(ctx context.Context, sessionID string, request AgentSessionExportRequest) (*AgentSessionExportResult, error) {
	var response struct {
		Agent struct {
			Export AgentSessionExportResult `json:"export"`
		} `json:"agent"`
	}
	format := request.Format
	if format == "" {
		format = "json"
	}
	path := fmt.Sprintf("/__hub/api/agent/sessions/%s/export?format=%s", url.PathEscape(sessionID), url.QueryEscape(format))
	if _, err := c.getJSON(ctx, path, &response); err != nil {
		return nil, err
	}
	return &response.Agent.Export, nil
}

func (c *Client) GetAgentSessionContextPreview(ctx context.Context, sessionID string) (*AgentThreadContextPreview, error) {
	var response struct {
		Agent struct {
			ContextPreview AgentThreadContextPreview `json:"contextPreview"`
		} `json:"agent"`
	}
	path := fmt.Sprintf("/__hub/api/agent/sessions/%s/context-preview", url.PathEscape(sessionID))
	if _, err := c.getJSON(ctx, path, &response); err != nil {
		return nil, err
	}
	return &response.Agent.ContextPreview, nil
}

func (c *Client) SendAgentMessage(ctx context.Context, sessionID string, request AgentMessageRequest) (*AgentMessageResult, error) {
	var response struct {
		Agent AgentMessageResult `json:"agent"`
	}
	path := fmt.Sprintf("/__hub/api/agent/sessions/%s/messages", url.PathEscape(sessionID))
	if _, err := c.postJSON(ctx, path, request, &response); err != nil {
		return nil, err
	}
	return &response.Agent, nil
}

func (c *Client) StreamAgentSessionEvents(ctx context.Context, sessionID string) (*AgentEventStream, error) {
	resp, err := c.openAgentSessionEventResponse(ctx, sessionID, 0)
	if err != nil {
		return nil, err
	}
	return newAgentEventStream(resp, func(reconnectContext context.Context, sequence int64) (*http.Response, error) {
		reconnected, reconnectErr := c.openAgentSessionEventResponse(reconnectContext, sessionID, sequence)
		return reconnected, reconnectErr
	}), nil
}

func (c *Client) openAgentSessionEventResponse(ctx context.Context, sessionID string, afterSequence int64) (*http.Response, error) {
	path := fmt.Sprintf("/__hub/api/agent/sessions/%s/events", url.PathEscape(sessionID))
	if afterSequence > 0 {
		path += "?afterSequence=" + strconv.FormatInt(afterSequence, 10)
	}
	req, err := c.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	if afterSequence > 0 {
		req.Header.Set("Last-Event-ID", strconv.FormatInt(afterSequence, 10))
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, decodeAPIError(resp)
	}
	return resp, nil
}

func (c *Client) ApproveAgentToolCall(ctx context.Context, approvalID string, request AgentApprovalResolutionRequest) (*AgentApproval, error) {
	return c.resolveAgentApproval(ctx, approvalID, "approve", request)
}

func (c *Client) RejectAgentToolCall(ctx context.Context, approvalID string, request AgentApprovalResolutionRequest) (*AgentApproval, error) {
	return c.resolveAgentApproval(ctx, approvalID, "reject", request)
}

func (c *Client) GetAgentDiagnostics(ctx context.Context) ([]AgentDiagnostic, error) {
	var response struct {
		Agent struct {
			Diagnostics []AgentDiagnostic `json:"diagnostics"`
		} `json:"agent"`
	}
	if _, err := c.getJSON(ctx, "/__hub/api/agent/diagnostics", &response); err != nil {
		return nil, err
	}
	return response.Agent.Diagnostics, nil
}

func (c *Client) resolveAgentApproval(ctx context.Context, approvalID string, action string, request AgentApprovalResolutionRequest) (*AgentApproval, error) {
	var response struct {
		Agent struct {
			Approval AgentApproval `json:"approval"`
		} `json:"agent"`
	}
	path := fmt.Sprintf("/__hub/api/agent/approvals/%s/%s", url.PathEscape(approvalID), action)
	if _, err := c.postJSON(ctx, path, request, &response); err != nil {
		return nil, err
	}
	return &response.Agent.Approval, nil
}

func (c *Client) DetectProject(ctx context.Context, request SetupDetectRequest) (*SetupDetectResult, error) {
	var result SetupDetectResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/detect", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) CreateSetupPlans(ctx context.Context, request SetupPlanRequest) (*SetupPlansResult, error) {
	var result SetupPlansResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/plans", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) PreviewSetupPlan(ctx context.Context, request SetupPlanRequest) (*SetupPlanPreview, error) {
	var result SetupPlanPreview
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/preview", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) ApplySetupPlan(ctx context.Context, request SetupApplyRequest) (*SetupApplyResult, error) {
	var result SetupApplyResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/apply", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) RegisterManifest(ctx context.Context, request RegisterManifestRequest) (*RegisterManifestResult, error) {
	var result RegisterManifestResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/register-manifest", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) PreviewRegistration(ctx context.Context, request RegistrationPreviewRequest) (*RegistrationSetupResult, error) {
	var result RegistrationSetupResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/register/preview", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) ApplyRegistration(ctx context.Context, request RegistrationApplyRequest) (*RegistrationSetupResult, error) {
	var result RegistrationSetupResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/register/apply", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) CancelRegistrationVerification(ctx context.Context, appID string) (*RegistrationVerificationCancelResult, error) {
	var result RegistrationVerificationCancelResult
	request := RegistrationVerificationCancelRequest{AppID: appID}
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/register/verification/cancel", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) PreviewRegistrationRepair(ctx context.Context, request RegistrationRepairPreviewRequest) (*RegistrationRepairPreviewResult, error) {
	var result RegistrationRepairPreviewResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/register/repair/preview", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) ApplyRegistrationRepair(ctx context.Context, request RegistrationRepairApplyRequest) (*RegistrationSetupResult, error) {
	var result RegistrationSetupResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/register/repair/apply", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) InspectManifest(ctx context.Context, request RegisterManifestRequest) (*ExistingManifestAnalysis, error) {
	var result ExistingManifestAnalysis
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/inspect-manifest", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) ValidateManifest(ctx context.Context, request RegisterManifestRequest) (*ExistingManifestAnalysis, error) {
	var result ExistingManifestAnalysis
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/validate-manifest", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) PreviewManifestPatch(ctx context.Context, request ManifestPatchRequest) (*ManifestPatchPlan, error) {
	var result ManifestPatchPlan
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/patch-manifest/preview", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) ApplyManifestPatch(ctx context.Context, request ManifestPatchRequest) (*ManifestPatchResult, error) {
	var result ManifestPatchResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/patch-manifest/apply", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) OpenProjectOrApp(ctx context.Context, request OpenProjectRequest) (*OpenProjectResult, error) {
	var result OpenProjectResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/open", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) ProveHealth(ctx context.Context, request ProveHealthRequest) (*ProveHealthResult, error) {
	var result ProveHealthResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/prove", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) RepairSetup(ctx context.Context, request RepairSetupRequest) (*RepairSetupResult, error) {
	var result RepairSetupResult
	if err := c.postSetupJSON(ctx, "/__hub/api/setup/repair", request, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) getJSON(ctx context.Context, path string, target any) (json.RawMessage, error) {
	req, err := c.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	return c.doJSON(req, target)
}

func (c *Client) postJSON(ctx context.Context, path string, payload any, target any) (json.RawMessage, error) {
	return c.writeJSON(ctx, http.MethodPost, path, payload, target)
}

func (c *Client) putJSON(ctx context.Context, path string, payload any, target any) (json.RawMessage, error) {
	return c.writeJSON(ctx, http.MethodPut, path, payload, target)
}

func (c *Client) patchJSON(ctx context.Context, path string, payload any, target any) (json.RawMessage, error) {
	return c.writeJSON(ctx, http.MethodPatch, path, payload, target)
}

func (c *Client) writeJSON(ctx context.Context, method string, path string, payload any, target any) (json.RawMessage, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := c.newRequest(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.doJSON(req, target)
}

func (c *Client) postSetupJSON(ctx context.Context, path string, payload any, target any) error {
	var response struct {
		Setup json.RawMessage `json:"setup"`
	}
	if _, err := c.postJSON(ctx, path, payload, &response); err != nil {
		return err
	}
	if len(response.Setup) == 0 {
		return nil
	}
	return json.Unmarshal(response.Setup, target)
}

func (c *Client) doJSON(req *http.Request, target any) (json.RawMessage, error) {
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, decodeAPIError(resp)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return raw, nil
	}
	if target != nil {
		if err := json.Unmarshal(raw, target); err != nil {
			return nil, err
		}
	}
	return raw, nil
}

func (c *Client) newRequest(ctx context.Context, method string, path string, body io.Reader) (*http.Request, error) {
	endpoint, err := url.JoinPath(c.baseURL, strings.TrimLeft(path, "/"))
	if err != nil {
		return nil, err
	}
	if strings.Contains(path, "?") {
		base, query, _ := strings.Cut(path, "?")
		endpoint, err = url.JoinPath(c.baseURL, strings.TrimLeft(base, "/"))
		if err != nil {
			return nil, err
		}
		endpoint += "?" + query
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	return req, nil
}

func decodeAPIError(resp *http.Response) error {
	raw, _ := io.ReadAll(resp.Body)
	apiError := RelaybaseErrorResponse{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &apiError)
	}
	normalized := apiError.RelaybaseError
	if normalized.Code == "" && len(apiError.Error) > 0 {
		_ = json.Unmarshal(apiError.Error, &normalized)
		if normalized.Code == "" {
			var legacyMessage string
			if err := json.Unmarshal(apiError.Error, &legacyMessage); err == nil {
				normalized.Message = legacyMessage
			}
		}
	}
	if normalized.Code == "" && apiError.Code != "" {
		normalized = RelaybaseError{
			Code:      apiError.Code,
			Message:   apiError.Message,
			Retryable: apiError.Recoverable != nil && *apiError.Recoverable,
		}
	}
	if normalized.Code == "" {
		normalized = RelaybaseError{
			Code:      "api_error",
			Message:   strings.TrimSpace(string(raw)),
			Retryable: resp.StatusCode >= 500,
		}
		if normalized.Message == "" {
			normalized.Message = resp.Status
		}
	}
	return &APIError{StatusCode: resp.StatusCode, ErrorBody: normalized}
}
