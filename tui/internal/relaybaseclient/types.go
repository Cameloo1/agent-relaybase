package relaybaseclient

import (
	"bytes"
	"encoding/json"
)

type RelaybaseState struct {
	Apps        []AppState      `json:"apps"`
	Groups      []AppGroup      `json:"groups,omitempty"`
	Components  []AppComponent  `json:"components,omitempty"`
	Diagnostics []Diagnostic    `json:"diagnostics,omitempty"`
	APIVersion  string          `json:"apiVersion,omitempty"`
	GeneratedAt string          `json:"generatedAt,omitempty"`
	Raw         json.RawMessage `json:"-"`
}

type AppState struct {
	ID             string          `json:"id"`
	Name           string          `json:"name,omitempty"`
	RuntimeStatus  string          `json:"runtimeStatus,omitempty"`
	ReadinessState string          `json:"readinessState,omitempty"`
	Route          string          `json:"route,omitempty"`
	CWD            string          `json:"cwd,omitempty"`
	ManifestPath   string          `json:"manifestPath,omitempty"`
	PID            int             `json:"pid,omitempty"`
	Port           int             `json:"port,omitempty"`
	LastError      string          `json:"lastError,omitempty"`
	Raw            json.RawMessage `json:"-"`
}

type AppGroup struct {
	GroupID         string         `json:"groupId"`
	DisplayName     string         `json:"displayName,omitempty"`
	Components      []AppComponent `json:"components,omitempty"`
	AggregateStatus string         `json:"aggregateStatus,omitempty"`
}

type AppComponent struct {
	AppID         string    `json:"appId"`
	GroupID       string    `json:"groupId,omitempty"`
	Role          string    `json:"role,omitempty"`
	PaneLabel     string    `json:"paneLabel,omitempty"`
	PaneOrder     int       `json:"paneOrder,omitempty"`
	DisplayName   string    `json:"displayName,omitempty"`
	Route         RouteInfo `json:"route,omitempty"`
	PID           int       `json:"pid,omitempty"`
	Port          int       `json:"port,omitempty"`
	Status        string    `json:"status,omitempty"`
	LastError     string    `json:"lastError,omitempty"`
	AggregateHint string    `json:"aggregateHint,omitempty"`
}

type RouteInfo struct {
	HumanURL  string          `json:"humanUrl,omitempty"`
	AgentURL  string          `json:"agentUrl,omitempty"`
	Reachable bool            `json:"reachable,omitempty"`
	Health    json.RawMessage `json:"health,omitempty"`
}

func (r RouteInfo) Label() string {
	if r.HumanURL != "" {
		return r.HumanURL
	}
	if r.AgentURL != "" {
		return r.AgentURL
	}
	return ""
}

type Diagnostic struct {
	Code     string          `json:"code"`
	Severity string          `json:"severity,omitempty"`
	Message  string          `json:"message"`
	Detail   json.RawMessage `json:"detail,omitempty"`
}

type DaemonEvent struct {
	ID            string          `json:"id,omitempty"`
	Sequence      int64           `json:"sequence,omitempty"`
	Type          string          `json:"type"`
	At            string          `json:"at,omitempty"`
	AppID         string          `json:"appId,omitempty"`
	GroupID       string          `json:"groupId,omitempty"`
	OperationID   string          `json:"operationId,omitempty"`
	CorrelationID string          `json:"correlationId,omitempty"`
	Data          json.RawMessage `json:"data,omitempty"`
}

type RelaybaseError struct {
	Code          string          `json:"code"`
	Message       string          `json:"message"`
	Detail        json.RawMessage `json:"detail,omitempty"`
	Retryable     bool            `json:"retryable"`
	UserAction    string          `json:"userAction,omitempty"`
	CorrelationID string          `json:"correlationId"`
}

type RelaybaseErrorResponse struct {
	Error          json.RawMessage `json:"error,omitempty"`
	RelaybaseError RelaybaseError  `json:"relaybaseError"`
	Code           string          `json:"code,omitempty"`
	Message        string          `json:"message,omitempty"`
	Recoverable    *bool           `json:"recoverable,omitempty"`
}

type LifecycleOperationResponse struct {
	OperationID string `json:"operationId"`
}

type AppUnregisterBlocker struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type AppUnregisterPackageReference struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type AppUnregisterIdentity struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	ProjectDirectory string `json:"projectDirectory"`
	ManifestPath     string `json:"manifestPath,omitempty"`
}

type AppUnregisterPreserved struct {
	ProjectFiles     bool `json:"projectFiles"`
	Manifest         bool `json:"manifest"`
	Logs             bool `json:"logs"`
	OperationHistory bool `json:"operationHistory"`
}

type AppUnregisterPreview struct {
	App               AppUnregisterIdentity           `json:"app"`
	RuntimeStatus     string                          `json:"runtimeStatus"`
	CanUnregister     bool                            `json:"canUnregister"`
	Blockers          []AppUnregisterBlocker          `json:"blockers"`
	PackageReferences []AppUnregisterPackageReference `json:"packageReferences"`
	Preserved         AppUnregisterPreserved          `json:"preserved"`
}

type AppUnregisterPreviewResponse struct {
	Preview AppUnregisterPreview `json:"preview"`
}

type AppUnregisterResult struct {
	Unregistered  bool                   `json:"unregistered"`
	App           AppUnregisterIdentity  `json:"app"`
	RuntimeStatus string                 `json:"runtimeStatus"`
	Preserved     AppUnregisterPreserved `json:"preserved"`
}

type AppUnregisterResultResponse struct {
	Result AppUnregisterResult `json:"result"`
}

type AppRenameBlocker struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type AppRenameChange struct {
	Field  string `json:"field"`
	Before string `json:"before"`
	After  string `json:"after"`
}

type AppRenameManifest struct {
	Path                string            `json:"path,omitempty"`
	SourceRevision      string            `json:"sourceRevision,omitempty"`
	Changes             []AppRenameChange `json:"changes"`
	DisplayNameBehavior string            `json:"displayNameBehavior"`
	DisplayName         string            `json:"displayName,omitempty"`
}

type AppRenamePreserved struct {
	StableAppID      string `json:"stableAppId"`
	Route            string `json:"route"`
	RunningProcess   bool   `json:"runningProcess"`
	Packages         bool   `json:"packages"`
	Logs             bool   `json:"logs"`
	OperationHistory bool   `json:"operationHistory"`
	Automation       bool   `json:"automation"`
}

type AppRenamePreview struct {
	PreviewID string `json:"previewId,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
	Noop      bool   `json:"noop"`
	CanRename bool   `json:"canRename"`
	App       struct {
		ID           string `json:"id"`
		CurrentName  string `json:"currentName"`
		ProposedName string `json:"proposedName"`
	} `json:"app"`
	RuntimeStatus    string             `json:"runtimeStatus"`
	Manifest         AppRenameManifest  `json:"manifest"`
	Blockers         []AppRenameBlocker `json:"blockers"`
	Preserved        AppRenamePreserved `json:"preserved"`
	RecoveryGuidance string             `json:"recoveryGuidance"`
}

type AppRenamePreviewResponse struct {
	Preview AppRenamePreview `json:"preview"`
}

type AppRenameResult struct {
	Renamed bool `json:"renamed"`
	App     struct {
		ID      string `json:"id"`
		OldName string `json:"oldName"`
		NewName string `json:"newName"`
	} `json:"app"`
	ManifestPath  string             `json:"manifestPath"`
	RuntimeStatus string             `json:"runtimeStatus"`
	Preserved     AppRenamePreserved `json:"preserved"`
}

type AppRenameResultResponse struct {
	Result AppRenameResult `json:"result"`
}

type LogQuery struct {
	Limit  int
	Before string
	After  string
}

type LogSnapshot struct {
	ID          string          `json:"id,omitempty"`
	AppID       string          `json:"appId,omitempty"`
	Logs        []string        `json:"logs,omitempty"`
	Events      []LogEvent      `json:"events,omitempty"`
	Page        LogPage         `json:"page,omitempty"`
	Diagnostics []Diagnostic    `json:"diagnostics,omitempty"`
	StreamURL   string          `json:"streamUrl,omitempty"`
	Raw         json.RawMessage `json:"-"`
}

type LogPage struct {
	Limit          int    `json:"limit,omitempty"`
	Before         Cursor `json:"before,omitempty"`
	After          Cursor `json:"after,omitempty"`
	NextBefore     Cursor `json:"nextBefore,omitempty"`
	HasMore        bool   `json:"hasMore,omitempty"`
	HasOlder       bool   `json:"hasOlder,omitempty"`
	HasNewer       bool   `json:"hasNewer,omitempty"`
	OldestSequence int64  `json:"oldestSequence,omitempty"`
	NewestSequence int64  `json:"newestSequence,omitempty"`
}

type Cursor string

func (c *Cursor) UnmarshalJSON(data []byte) error {
	var text string
	if err := json.Unmarshal(data, &text); err == nil {
		*c = Cursor(text)
		return nil
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return err
	}

	switch typed := value.(type) {
	case json.Number:
		*c = Cursor(typed.String())
	case nil:
		*c = ""
	default:
		*c = Cursor(string(data))
	}
	return nil
}

type LogEvent struct {
	Sequence      int64  `json:"sequence,omitempty"`
	Timestamp     string `json:"timestamp,omitempty"`
	At            string `json:"at,omitempty"`
	AppID         string `json:"appId,omitempty"`
	GroupID       string `json:"groupId,omitempty"`
	ComponentRole string `json:"componentRole,omitempty"`
	Stream        string `json:"stream,omitempty"`
	Source        string `json:"source,omitempty"`
	Level         string `json:"level,omitempty"`
	Message       string `json:"message"`
	Line          string `json:"line,omitempty"`
	Redacted      bool   `json:"redacted,omitempty"`
}

func (e LogEvent) DisplayLine() string {
	message := e.Message
	if message == "" {
		message = e.Line
	}
	if e.Stream == "" {
		return message
	}
	return "[" + e.Stream + "] " + message
}

type LogExportRequest struct {
	Scope         string   `json:"scope"`
	AppID         string   `json:"appId,omitempty"`
	GroupID       string   `json:"groupId,omitempty"`
	ComponentRole string   `json:"componentRole,omitempty"`
	PaneIDs       []string `json:"paneIds,omitempty"`
	Format        string   `json:"format,omitempty"`
	StartTime     string   `json:"startTime,omitempty"`
	EndTime       string   `json:"endTime,omitempty"`
	Limit         int      `json:"limit,omitempty"`
	Destination   string   `json:"destination,omitempty"`
	Redact        *bool    `json:"redact,omitempty"`
}

type LogExportResult struct {
	ExportID           string          `json:"exportId"`
	Status             string          `json:"status"`
	Format             string          `json:"format,omitempty"`
	OutputPath         string          `json:"outputPath,omitempty"`
	IncludedApps       []string        `json:"includedApps,omitempty"`
	IncludedGroups     []string        `json:"includedGroups,omitempty"`
	IncludedComponents []string        `json:"includedComponents,omitempty"`
	StartedAt          string          `json:"startedAt,omitempty"`
	CompletedAt        string          `json:"completedAt,omitempty"`
	SizeBytes          int64           `json:"sizeBytes,omitempty"`
	RedactionReport    json.RawMessage `json:"redactionReport,omitempty"`
	Error              *RelaybaseError `json:"error,omitempty"`
}

type LogExportResponse struct {
	Export LogExportResult `json:"export"`
}

type SetupDiagnostic struct {
	Code       string          `json:"code"`
	Severity   string          `json:"severity,omitempty"`
	Message    string          `json:"message"`
	Detail     json.RawMessage `json:"detail,omitempty"`
	UserAction string          `json:"userAction,omitempty"`
}

type ComponentSetupMetadata struct {
	AppID         string `json:"appId,omitempty"`
	Name          string `json:"name,omitempty"`
	Command       string `json:"command,omitempty"`
	CWD           string `json:"cwd,omitempty"`
	HealthURL     string `json:"healthUrl,omitempty"`
	GroupID       string `json:"groupId,omitempty"`
	ComponentRole string `json:"componentRole,omitempty"`
	DisplayName   string `json:"displayName,omitempty"`
	PaneLabel     string `json:"paneLabel,omitempty"`
	PaneOrder     int    `json:"paneOrder,omitempty"`
}

type SetupConfirmation struct {
	Confirmed bool   `json:"confirmed,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

type SetupDetectRequest struct {
	CWD              string `json:"cwd,omitempty"`
	CurrentDirectory string `json:"currentDirectory,omitempty"`
}

type ExistingManifestAnalysis struct {
	Path        string            `json:"path"`
	Exists      bool              `json:"exists"`
	Valid       bool              `json:"valid"`
	App         *SetupAppRecord   `json:"app,omitempty"`
	Manifest    json.RawMessage   `json:"manifest,omitempty"`
	Diagnostics []SetupDiagnostic `json:"diagnostics,omitempty"`
	Error       string            `json:"error,omitempty"`
}

type ExistingSetupArtifactAnalysis struct {
	Path         string            `json:"path"`
	Exists       bool              `json:"exists"`
	Kind         string            `json:"kind"`
	Valid        bool              `json:"valid"`
	PlanID       string            `json:"planId,omitempty"`
	Architecture string            `json:"architecture,omitempty"`
	Diagnostics  []SetupDiagnostic `json:"diagnostics,omitempty"`
	Error        string            `json:"error,omitempty"`
}

type SetupDetectResult struct {
	CWD                   string                         `json:"cwd"`
	PackageManager        string                         `json:"packageManager,omitempty"`
	PackageCommand        string                         `json:"packageCommand,omitempty"`
	Framework             string                         `json:"framework,omitempty"`
	AppKind               string                         `json:"appKind,omitempty"`
	Scripts               map[string]string              `json:"scripts,omitempty"`
	EnvFiles              []string                       `json:"envFiles,omitempty"`
	PortEnvKeys           []string                       `json:"portEnvKeys,omitempty"`
	DetectedPorts         []int                          `json:"detectedPorts,omitempty"`
	HealthCandidates      []string                       `json:"healthCandidates,omitempty"`
	DockerComposeFiles    []string                       `json:"dockerComposeFiles,omitempty"`
	MCPHints              []string                       `json:"mcpHints,omitempty"`
	MonorepoHints         []string                       `json:"monorepoHints,omitempty"`
	ExistingManifest      *ExistingManifestAnalysis      `json:"existingManifest,omitempty"`
	ExistingLaunchWrapper *ExistingSetupArtifactAnalysis `json:"existingLaunchWrapper,omitempty"`
	ExistingSetupProfile  *ExistingSetupArtifactAnalysis `json:"existingSetupProfile,omitempty"`
	PrimaryRuntime        *RuntimeDetectionResult        `json:"primaryRuntime,omitempty"`
	RuntimeMatrix         *RuntimeMatrixSnapshot         `json:"runtimeMatrix,omitempty"`
	Diagnostics           []SetupDiagnostic              `json:"diagnostics,omitempty"`
}

type SetupPlanRequest struct {
	CWD               string                   `json:"cwd,omitempty"`
	CurrentDirectory  string                   `json:"currentDirectory,omitempty"`
	SelectedPlanID    string                   `json:"selectedPlanId,omitempty"`
	Profile           string                   `json:"profile,omitempty"`
	RuntimePreference string                   `json:"runtimePreference,omitempty"`
	CommandHint       string                   `json:"commandHint,omitempty"`
	PortStrategyHint  string                   `json:"portStrategyHint,omitempty"`
	EnvStrategy       string                   `json:"envStrategy,omitempty"`
	MCPInstall        bool                     `json:"mcpInstall,omitempty"`
	ComponentMetadata ComponentSetupMetadata   `json:"componentMetadata,omitempty"`
	Components        []ComponentSetupMetadata `json:"components,omitempty"`
	Docker            json.RawMessage          `json:"docker,omitempty"`
}

type SetupPlanChoice struct {
	ID                            string                   `json:"id"`
	Label                         string                   `json:"label,omitempty"`
	Architecture                  string                   `json:"architecture,omitempty"`
	Score                         int                      `json:"score,omitempty"`
	Framework                     string                   `json:"framework,omitempty"`
	PackageManager                string                   `json:"packageManager,omitempty"`
	PortStrategies                []string                 `json:"portStrategies,omitempty"`
	RuntimeID                     string                   `json:"runtimeId,omitempty"`
	RuntimeConfidence             string                   `json:"runtimeConfidence,omitempty"`
	RuntimeStartCommandCandidates []StartCommandCandidate  `json:"runtimeStartCommandCandidates,omitempty"`
	RuntimePortStrategies         []PortBindingStrategy    `json:"runtimePortStrategies,omitempty"`
	RuntimeHealthCandidates       []RuntimeHealthCandidate `json:"runtimeHealthCandidates,omitempty"`
	SetupQuestions                []SetupQuestion          `json:"setupQuestions,omitempty"`
	RepairCandidates              []RepairCandidate        `json:"repairCandidates,omitempty"`
	Reasons                       []string                 `json:"reasons,omitempty"`
	Risks                         []string                 `json:"risks,omitempty"`
	RecoverySteps                 []string                 `json:"recoverySteps,omitempty"`
	RequiresInput                 []string                 `json:"requiresInput,omitempty"`
}

type RuntimeDiagnostic struct {
	Code       string          `json:"code"`
	Severity   string          `json:"severity,omitempty"`
	Message    string          `json:"message"`
	Detail     json.RawMessage `json:"detail,omitempty"`
	UserAction string          `json:"userAction,omitempty"`
}

type StartCommandCandidate struct {
	ID               string   `json:"id"`
	Label            string   `json:"label,omitempty"`
	Command          []string `json:"command,omitempty"`
	CommandPreview   string   `json:"commandPreview,omitempty"`
	WorkingDirectory string   `json:"workingDirectory,omitempty"`
	RequiresTool     string   `json:"requiresTool,omitempty"`
	Confidence       string   `json:"confidence,omitempty"`
	Reasons          []string `json:"reasons,omitempty"`
	Risks            []string `json:"risks,omitempty"`
}

type PortBindingStrategy struct {
	ID          string              `json:"id"`
	Confidence  string              `json:"confidence,omitempty"`
	Env         map[string]string   `json:"env,omitempty"`
	Args        []string            `json:"args,omitempty"`
	WrapperKind string              `json:"wrapperKind,omitempty"`
	Diagnostics []RuntimeDiagnostic `json:"diagnostics,omitempty"`
}

type RuntimeHealthCandidate struct {
	Path       string `json:"path"`
	Confidence string `json:"confidence,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

type SetupQuestion struct {
	ID       string                `json:"id"`
	Prompt   string                `json:"prompt"`
	Required bool                  `json:"required"`
	Choices  []SetupQuestionChoice `json:"choices,omitempty"`
}

type SetupQuestionChoice struct {
	ID     string `json:"id"`
	Label  string `json:"label,omitempty"`
	Detail string `json:"detail,omitempty"`
}

type RepairCandidate struct {
	ID               string              `json:"id"`
	Label            string              `json:"label,omitempty"`
	AppliesTo        string              `json:"appliesTo,omitempty"`
	PreviewOnly      bool                `json:"previewOnly,omitempty"`
	ApprovalRequired bool                `json:"approvalRequired,omitempty"`
	Diagnostics      []RuntimeDiagnostic `json:"diagnostics,omitempty"`
}

type RuntimeDetectionResult struct {
	Runtime                string                   `json:"runtime"`
	Label                  string                   `json:"label,omitempty"`
	Tier                   int                      `json:"tier,omitempty"`
	Confidence             string                   `json:"confidence,omitempty"`
	DetectionFiles         []string                 `json:"detectionFiles,omitempty"`
	BuildToolIndicators    []string                 `json:"buildToolIndicators,omitempty"`
	ServerIndicators       []string                 `json:"serverIndicators,omitempty"`
	StartCommandCandidates []StartCommandCandidate  `json:"startCommandCandidates,omitempty"`
	PortStrategies         []PortBindingStrategy    `json:"portStrategies,omitempty"`
	HealthCandidates       []RuntimeHealthCandidate `json:"healthCandidates,omitempty"`
	Questions              []SetupQuestion          `json:"questions,omitempty"`
	RepairCandidates       []RepairCandidate        `json:"repairCandidates,omitempty"`
	Diagnostics            []RuntimeDiagnostic      `json:"diagnostics,omitempty"`
}

type RuntimeMatrixSnapshot struct {
	Version        int                      `json:"version"`
	GeneratedAt    string                   `json:"generatedAt,omitempty"`
	PrimaryRuntime string                   `json:"primaryRuntime,omitempty"`
	Runtimes       []RuntimeDetectionResult `json:"runtimes,omitempty"`
	Questions      []SetupQuestion          `json:"questions,omitempty"`
	Diagnostics    []RuntimeDiagnostic      `json:"diagnostics,omitempty"`
}

type FileDiff struct {
	Path         string   `json:"path"`
	BeforeExists bool     `json:"beforeExists"`
	AfterExists  bool     `json:"afterExists"`
	Changed      bool     `json:"changed"`
	Hunks        []string `json:"hunks,omitempty"`
}

type FileWritePreview struct {
	Path    string   `json:"path"`
	Action  string   `json:"action"`
	Reason  string   `json:"reason,omitempty"`
	Preview string   `json:"preview,omitempty"`
	Diff    FileDiff `json:"diff"`
}

type SetupApprovalRisk struct {
	Code             string `json:"code"`
	Severity         string `json:"severity,omitempty"`
	Message          string `json:"message"`
	RequiresApproval bool   `json:"requiresApproval"`
}

type FileWritePlan struct {
	Root             string              `json:"root"`
	Writes           []FileWritePreview  `json:"writes,omitempty"`
	ApprovalRequired bool                `json:"approvalRequired"`
	Risks            []SetupApprovalRisk `json:"risks,omitempty"`
}

type SetupPlan struct {
	ID           string             `json:"id"`
	Label        string             `json:"label,omitempty"`
	Architecture string             `json:"architecture,omitempty"`
	Score        int                `json:"score,omitempty"`
	Manifest     json.RawMessage    `json:"manifest,omitempty"`
	Choice       SetupPlanChoice    `json:"choice"`
	Writes       []FileWritePreview `json:"writes,omitempty"`
}

type SetupPlansResult struct {
	CWD         string            `json:"cwd"`
	Choices     []SetupPlanChoice `json:"choices,omitempty"`
	Diagnostics []SetupDiagnostic `json:"diagnostics,omitempty"`
}

type SetupPlanPreview struct {
	CWD            string            `json:"cwd"`
	SelectedPlan   SetupPlan         `json:"selectedPlan"`
	ComponentPlans []SetupPlan       `json:"componentPlans,omitempty"`
	Choices        []SetupPlanChoice `json:"choices,omitempty"`
	FileWritePlan  FileWritePlan     `json:"fileWritePlan"`
	Diagnostics    []SetupDiagnostic `json:"diagnostics,omitempty"`
}

type SetupApplyRequest struct {
	SetupPlanRequest
	Repair       bool               `json:"repair,omitempty"`
	Confirm      bool               `json:"confirm,omitempty"`
	Confirmation *SetupConfirmation `json:"confirmation,omitempty"`
}

type SetupAppliedFile struct {
	Path   string `json:"path"`
	Action string `json:"action"`
}

type SetupAppRecord struct {
	ID           string          `json:"id"`
	Name         string          `json:"name,omitempty"`
	Command      string          `json:"command,omitempty"`
	CWD          string          `json:"cwd,omitempty"`
	Protocol     string          `json:"protocol,omitempty"`
	HealthURL    string          `json:"healthUrl,omitempty"`
	UpstreamPort int             `json:"upstreamPort,omitempty"`
	ManifestPath string          `json:"manifestPath,omitempty"`
	Relaybase    json.RawMessage `json:"relaybase,omitempty"`
}

type SetupApplyResult struct {
	CWD           string             `json:"cwd"`
	SelectedPlan  SetupPlanChoice    `json:"selectedPlan"`
	AppliedFiles  []SetupAppliedFile `json:"appliedFiles,omitempty"`
	RegisteredApp *SetupAppRecord    `json:"registeredApp,omitempty"`
	Verification  json.RawMessage    `json:"verification,omitempty"`
	ReportPath    string             `json:"reportPath,omitempty"`
	EventsPath    string             `json:"eventsPath,omitempty"`
	Diagnostics   []SetupDiagnostic  `json:"diagnostics,omitempty"`
}

type ManifestPatchRequest struct {
	CWD          string             `json:"cwd,omitempty"`
	ManifestPath string             `json:"manifestPath,omitempty"`
	Patch        map[string]any     `json:"patch"`
	Confirm      bool               `json:"confirm,omitempty"`
	Confirmation *SetupConfirmation `json:"confirmation,omitempty"`
}

type ManifestPatchPlan struct {
	CWD             string            `json:"cwd"`
	ManifestPath    string            `json:"manifestPath"`
	Manifest        json.RawMessage   `json:"manifest,omitempty"`
	PatchedManifest json.RawMessage   `json:"patchedManifest,omitempty"`
	FileWritePlan   FileWritePlan     `json:"fileWritePlan"`
	Diagnostics     []SetupDiagnostic `json:"diagnostics,omitempty"`
}

type ManifestPatchResult struct {
	CWD          string            `json:"cwd"`
	ManifestPath string            `json:"manifestPath"`
	App          SetupAppRecord    `json:"app"`
	File         SetupAppliedFile  `json:"file"`
	Diagnostics  []SetupDiagnostic `json:"diagnostics,omitempty"`
}

type RegisterManifestRequest struct {
	CWD          string `json:"cwd,omitempty"`
	ManifestPath string `json:"manifestPath"`
	Mode         string `json:"mode,omitempty"`
}

type RegisterManifestResult struct {
	App          SetupAppRecord `json:"app"`
	ManifestPath string         `json:"manifestPath"`
}

type RegistrationPreviewRequest struct {
	Path             string `json:"path"`
	CWD              string `json:"cwd,omitempty"`
	Mode             string `json:"mode,omitempty"`
	VerificationMode string `json:"verificationMode"`
}

type RegistrationVerificationIntent struct {
	Mode              string   `json:"mode"`
	WillStart         bool     `json:"willStart"`
	WillStop          bool     `json:"willStop"`
	ExpectedMaximumMS int      `json:"expectedMaximumMs"`
	HealthCandidates  []string `json:"healthCandidates,omitempty"`
}

type RegistrationVerificationFailure struct {
	Code              string   `json:"code"`
	Boundary          string   `json:"boundary"`
	Message           string   `json:"message"`
	RecommendedAction string   `json:"recommendedAction"`
	ProcessRunning    bool     `json:"processRunning"`
	BackendPortOpen   *bool    `json:"backendPortOpen,omitempty"`
	Retryable         bool     `json:"retryable"`
	LogExcerpt        []string `json:"logExcerpt,omitempty"`
}

type RegistrationRepairOption struct {
	ID                      string   `json:"id"`
	Kind                    string   `json:"kind"`
	Label                   string   `json:"label"`
	Recommended             bool     `json:"recommended"`
	Reason                  string   `json:"reason"`
	SetupPlanID             string   `json:"setupPlanId,omitempty"`
	StructuredInputRequired []string `json:"structuredInputRequired,omitempty"`
}

type RegistrationRepairPreviewRequest struct {
	AppID    string `json:"appId"`
	RepairID string `json:"repairId"`
}

type RegistrationRepairPreviewResult struct {
	PreviewID          string                         `json:"previewId"`
	AppID              string                         `json:"appId"`
	RepairID           string                         `json:"repairId"`
	Repair             RegistrationRepairOption       `json:"repair"`
	SelectedPlan       *SetupPlan                     `json:"selectedPlan,omitempty"`
	FileWritePlan      FileWritePlan                  `json:"fileWritePlan"`
	LaunchCommand      string                         `json:"launchCommand,omitempty"`
	Approval           RegistrationApproval           `json:"approval"`
	VerificationIntent RegistrationVerificationIntent `json:"verificationIntent"`
	Actions            []string                       `json:"actions,omitempty"`
}

type RegistrationRepairApplyRequest struct {
	PreviewID    string             `json:"previewId"`
	Confirm      bool               `json:"confirm"`
	Confirmation *SetupConfirmation `json:"confirmation,omitempty"`
}

type RegistrationVerificationResult struct {
	Status       string                           `json:"status"`
	AssignedPort int                              `json:"assignedPort,omitempty"`
	Health       json.RawMessage                  `json:"health,omitempty"`
	Stop         json.RawMessage                  `json:"stop,omitempty"`
	Failure      *RegistrationVerificationFailure `json:"failure,omitempty"`
	Repairs      []RegistrationRepairOption       `json:"repairs,omitempty"`
}

type RegistrationApproval struct {
	Required  bool   `json:"required"`
	PreviewID string `json:"previewId,omitempty"`
}

type RegistrationSetupResult struct {
	SchemaVersion      int                             `json:"schemaVersion"`
	Status             string                          `json:"status"`
	Code               string                          `json:"code,omitempty"`
	Message            string                          `json:"message"`
	ProjectRoot        string                          `json:"projectRoot"`
	ManifestPath       string                          `json:"manifestPath"`
	ManifestState      string                          `json:"manifestState"`
	PreviewID          string                          `json:"previewId,omitempty"`
	App                *SetupAppRecord                 `json:"app,omitempty"`
	FileWritePlan      *FileWritePlan                  `json:"fileWritePlan,omitempty"`
	Questions          []SetupQuestion                 `json:"questions,omitempty"`
	Risks              []SetupApprovalRisk             `json:"risks,omitempty"`
	Approval           RegistrationApproval            `json:"approval"`
	Registered         bool                            `json:"registered"`
	Started            bool                            `json:"started"`
	FilesWritten       bool                            `json:"filesWritten"`
	RetrySafe          bool                            `json:"retrySafe"`
	Actions            []string                        `json:"actions,omitempty"`
	Diagnostics        []SetupDiagnostic               `json:"diagnostics,omitempty"`
	VerificationIntent RegistrationVerificationIntent  `json:"verificationIntent"`
	Verification       *RegistrationVerificationResult `json:"verification,omitempty"`
}

type RegistrationApplyRequest struct {
	PreviewID        string             `json:"previewId"`
	Confirm          bool               `json:"confirm"`
	Confirmation     *SetupConfirmation `json:"confirmation,omitempty"`
	SelectedRepairID string             `json:"selectedRepairId,omitempty"`
}

type RegistrationVerificationCancelRequest struct {
	AppID string `json:"appId"`
}

type RegistrationVerificationCancelResult struct {
	AppID     string `json:"appId"`
	Cancelled bool   `json:"cancelled"`
	Status    string `json:"status"`
	Message   string `json:"message"`
}

type OpenProjectRequest struct {
	CWD              string             `json:"cwd,omitempty"`
	CurrentDirectory string             `json:"currentDirectory,omitempty"`
	NoBrowser        bool               `json:"noBrowser,omitempty"`
	Confirm          bool               `json:"confirm,omitempty"`
	Confirmation     *SetupConfirmation `json:"confirmation,omitempty"`
}

type OpenProjectPlan struct {
	CWD              string              `json:"cwd"`
	ApprovalRequired bool                `json:"approvalRequired"`
	Risks            []SetupApprovalRisk `json:"risks,omitempty"`
}

type OpenProjectResult struct {
	Plan   OpenProjectPlan `json:"plan"`
	Result json.RawMessage `json:"result,omitempty"`
}

type ProveHealthRequest struct {
	CWD              string             `json:"cwd,omitempty"`
	CurrentDirectory string             `json:"currentDirectory,omitempty"`
	AppID            string             `json:"appId,omitempty"`
	LifecycleProof   bool               `json:"lifecycleProof,omitempty"`
	Confirm          bool               `json:"confirm,omitempty"`
	Confirmation     *SetupConfirmation `json:"confirmation,omitempty"`
}

type ProveHealthResult struct {
	CWD    string          `json:"cwd"`
	Result json.RawMessage `json:"result,omitempty"`
}

type RepairSetupRequest struct {
	SetupPlanRequest
	Reason string `json:"reason,omitempty"`
}

type RepairSetupPlan struct {
	CWD              string                 `json:"cwd"`
	Choices          []SetupPlanChoice      `json:"choices,omitempty"`
	Previews         []SetupPlanPreview     `json:"previews,omitempty"`
	RuntimeMatrix    *RuntimeMatrixSnapshot `json:"runtimeMatrix,omitempty"`
	RepairCandidates []RepairCandidate      `json:"repairCandidates,omitempty"`
	Diagnostics      []SetupDiagnostic      `json:"diagnostics,omitempty"`
}

type RepairSetupResult struct {
	Plan RepairSetupPlan `json:"plan"`
}

type AgentProviderConfig struct {
	Provider           string            `json:"provider"`
	ModelSlug          string            `json:"modelSlug,omitempty"`
	APIKeySource       AgentAPIKeySource `json:"apiKeySource"`
	HTTPRefererEnvVar  string            `json:"httpRefererEnvVar,omitempty"`
	TitleEnvVar        string            `json:"titleEnvVar,omitempty"`
	RemoteModelEnabled bool              `json:"remoteModelEnabled"`
}

type AgentAPIKeySource struct {
	Type       string `json:"type"`
	EnvVar     string `json:"envVar"`
	Configured bool   `json:"configured"`
}

type AgentBudgets struct {
	DailyLimitUSD   float64 `json:"dailyLimitUsd,omitempty"`
	MonthlyLimitUSD float64 `json:"monthlyLimitUsd,omitempty"`
	SessionLimitUSD float64 `json:"sessionLimitUsd,omitempty"`
}

type AgentConfig struct {
	Enabled              bool                `json:"enabled"`
	Provider             AgentProviderConfig `json:"provider"`
	ToolAllowlist        []string            `json:"toolAllowlist,omitempty"`
	ApprovalPolicy       string              `json:"approvalPolicy,omitempty"`
	SetupFileWritePolicy string              `json:"setupFileWritePolicy,omitempty"`
	AllowBrowserOpen     bool                `json:"allowBrowserOpen,omitempty"`
	AllowCopyRoute       bool                `json:"allowCopyRoute,omitempty"`
	Budgets              *AgentBudgets       `json:"budgets,omitempty"`
	UpdatedAt            string              `json:"updatedAt,omitempty"`
}

type AgentConfigUpdate struct {
	Enabled          *bool                      `json:"enabled,omitempty"`
	Provider         *AgentProviderConfigUpdate `json:"provider,omitempty"`
	ToolAllowlist    []string                   `json:"toolAllowlist,omitempty"`
	ApprovalPolicy   string                     `json:"approvalPolicy,omitempty"`
	AllowBrowserOpen *bool                      `json:"allowBrowserOpen,omitempty"`
	AllowCopyRoute   *bool                      `json:"allowCopyRoute,omitempty"`
	Budgets          *AgentBudgets              `json:"budgets,omitempty"`
}

type AgentProviderConfigUpdate struct {
	ModelSlug          string `json:"modelSlug,omitempty"`
	APIKeyEnvVar       string `json:"apiKeyEnvVar,omitempty"`
	RemoteModelEnabled *bool  `json:"remoteModelEnabled,omitempty"`
	HTTPRefererEnvVar  string `json:"httpRefererEnvVar,omitempty"`
	TitleEnvVar        string `json:"titleEnvVar,omitempty"`
}

type TerminalCapabilities struct {
	Clipboard   string `json:"clipboard,omitempty"`
	BrowserOpen string `json:"browserOpen,omitempty"`
	ColorDepth  string `json:"colorDepth,omitempty"`
}

type TuiAgentContext struct {
	SelectedPaneID         string                `json:"selectedPaneId,omitempty"`
	SelectedAppID          string                `json:"selectedAppId,omitempty"`
	SelectedGroupID        string                `json:"selectedGroupId,omitempty"`
	SelectedComponentRole  string                `json:"selectedComponentRole,omitempty"`
	CurrentRoute           string                `json:"currentRoute,omitempty"`
	CurrentPage            int                   `json:"currentPage,omitempty"`
	CurrentCWD             string                `json:"currentCwd,omitempty"`
	AuthorizedProjectRoots []string              `json:"authorizedProjectRoots,omitempty"`
	DaemonHasZeroApps      bool                  `json:"daemonHasZeroApps"`
	SetupWizardState       string                `json:"setupWizardState,omitempty"`
	CurrentSetupPlanID     string                `json:"currentSetupPlanId,omitempty"`
	Diagnostics            []AgentDiagnostic     `json:"diagnostics"`
	TerminalCapabilities   *TerminalCapabilities `json:"terminalCapabilities,omitempty"`
}

type AgentSetupPlanReference struct {
	SetupPlanID  string `json:"setupPlanId"`
	CWD          string `json:"cwd"`
	Label        string `json:"label,omitempty"`
	Architecture string `json:"architecture,omitempty"`
	Risk         string `json:"risk,omitempty"`
}

type AgentSetupContext struct {
	CWD              string                    `json:"cwd,omitempty"`
	SelectedPlan     *AgentSetupPlanReference  `json:"selectedPlan,omitempty"`
	Preview          *SetupPlanPreview         `json:"preview,omitempty"`
	Repair           *RepairSetupResult        `json:"repair,omitempty"`
	ExistingManifest *ExistingManifestAnalysis `json:"existingManifest,omitempty"`
}

type AgentThreadPrivacy struct {
	Mode                          string `json:"mode"`
	AdvancedRedactedDetailEnabled bool   `json:"advancedRedactedDetailEnabled"`
}

type AgentThreadSummary struct {
	GeneratedAt            string `json:"generatedAt,omitempty"`
	MessageCount           int    `json:"messageCount,omitempty"`
	RunCount               int    `json:"runCount,omitempty"`
	EventCount             int    `json:"eventCount,omitempty"`
	PendingApprovalCount   int    `json:"pendingApprovalCount,omitempty"`
	RecoveredApprovalCount int    `json:"recoveredApprovalCount,omitempty"`
	LastEventSequence      int64  `json:"lastEventSequence,omitempty"`
	LastUserMessage        string `json:"lastUserMessage,omitempty"`
	LastAssistantMessage   string `json:"lastAssistantMessage,omitempty"`
	LastDiagnosticCode     string `json:"lastDiagnosticCode,omitempty"`
}

type AgentThreadContextPreview struct {
	SessionID        string                  `json:"sessionId"`
	Active           bool                    `json:"active"`
	Title            string                  `json:"title,omitempty"`
	Summary          AgentThreadSummary      `json:"summary"`
	Privacy          AgentThreadPrivacy      `json:"privacy"`
	RecentMessages   []AgentMessage          `json:"recentMessages,omitempty"`
	PendingApprovals []AgentApproval         `json:"pendingApprovals,omitempty"`
	RecallPolicy     AgentThreadRecallPolicy `json:"recallPolicy"`
}

type AgentThreadRecallPolicy struct {
	Scope              string `json:"scope"`
	IncludesRawSecrets bool   `json:"includesRawSecrets"`
	IncludesRawLogs    bool   `json:"includesRawLogs"`
	IncludesRawDiffs   bool   `json:"includesRawDiffs"`
	ExtraModelCalls    bool   `json:"extraModelCalls"`
}

type AgentSession struct {
	ID                     string              `json:"id"`
	Title                  string              `json:"title,omitempty"`
	TitleSource            string              `json:"titleSource,omitempty"`
	CreatedAt              string              `json:"createdAt,omitempty"`
	UpdatedAt              string              `json:"updatedAt,omitempty"`
	LastActiveAt           string              `json:"lastActiveAt,omitempty"`
	DeletedAt              string              `json:"deletedAt,omitempty"`
	DeletedReason          string              `json:"deletedReason,omitempty"`
	Summary                *AgentThreadSummary `json:"summary,omitempty"`
	Privacy                *AgentThreadPrivacy `json:"privacy,omitempty"`
	RecoveredApprovalCount int                 `json:"recoveredApprovalCount,omitempty"`
	Context                *TuiAgentContext    `json:"context,omitempty"`
	Setup                  *AgentSetupContext  `json:"setup,omitempty"`
	Messages               []AgentMessage      `json:"messages,omitempty"`
	Runs                   []AgentRun          `json:"runs,omitempty"`
}

type AgentMessage struct {
	ID        string           `json:"id"`
	SessionID string           `json:"sessionId"`
	Role      string           `json:"role"`
	Content   string           `json:"content"`
	CreatedAt string           `json:"createdAt"`
	RunID     string           `json:"runId,omitempty"`
	Context   *TuiAgentContext `json:"context,omitempty"`
}

type AgentRun struct {
	ID          string           `json:"id"`
	SessionID   string           `json:"sessionId"`
	Status      string           `json:"status"`
	CreatedAt   string           `json:"createdAt"`
	StartedAt   string           `json:"startedAt,omitempty"`
	CompletedAt string           `json:"completedAt,omitempty"`
	ModelSlug   string           `json:"modelSlug,omitempty"`
	Provider    string           `json:"provider,omitempty"`
	Diagnostic  *AgentDiagnostic `json:"diagnostic,omitempty"`
	Usage       json.RawMessage  `json:"usage,omitempty"`
	Events      []AgentRunEvent  `json:"events,omitempty"`
}

type AgentRunEvent struct {
	ID        string          `json:"id"`
	Sequence  int64           `json:"sequence"`
	SessionID string          `json:"sessionId"`
	RunID     string          `json:"runId,omitempty"`
	Type      string          `json:"type"`
	At        string          `json:"at,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

type AgentDiagnostic struct {
	ID         string          `json:"id,omitempty"`
	Severity   string          `json:"severity,omitempty"`
	Code       string          `json:"code"`
	Message    string          `json:"message"`
	CheckedAt  string          `json:"checkedAt,omitempty"`
	UserAction string          `json:"userAction,omitempty"`
	Detail     json.RawMessage `json:"detail,omitempty"`
}

type AgentApproval struct {
	ID                    string                      `json:"id"`
	SessionID             string                      `json:"sessionId"`
	RunID                 string                      `json:"runId"`
	ToolCallID            string                      `json:"toolCallId,omitempty"`
	ToolName              string                      `json:"toolName,omitempty"`
	Status                string                      `json:"status"`
	CreatedAt             string                      `json:"createdAt"`
	ResolvedAt            string                      `json:"resolvedAt,omitempty"`
	Action                string                      `json:"action"`
	Target                string                      `json:"target,omitempty"`
	Risk                  string                      `json:"risk,omitempty"`
	ExpectedResult        string                      `json:"expectedResult,omitempty"`
	Arguments             json.RawMessage             `json:"arguments,omitempty"`
	ArgumentsHash         string                      `json:"argumentsHash,omitempty"`
	RecoveryState         string                      `json:"recoveryState,omitempty"`
	RawArgumentsPersisted bool                        `json:"rawArgumentsPersisted,omitempty"`
	Context               *TuiAgentContext            `json:"context,omitempty"`
	Preview               *AgentApprovalPreview       `json:"preview,omitempty"`
	FileWrite             *AgentFileWriteApproval     `json:"fileWrite,omitempty"`
	ManifestPatch         *AgentManifestPatchApproval `json:"manifestPatch,omitempty"`
	OpenRoute             *AgentOpenRouteApproval     `json:"openRoute,omitempty"`
	Diagnostic            *AgentDiagnostic            `json:"diagnostic,omitempty"`
}

type AgentApprovalPreview struct {
	Action                  string                  `json:"action"`
	Target                  string                  `json:"target,omitempty"`
	CurrentStatus           string                  `json:"currentStatus,omitempty"`
	ExpectedResult          string                  `json:"expectedResult,omitempty"`
	Risk                    string                  `json:"risk,omitempty"`
	Arguments               json.RawMessage         `json:"arguments,omitempty"`
	FileWrites              json.RawMessage         `json:"fileWrites,omitempty"`
	ManifestFieldsChanged   []string                `json:"manifestFieldsChanged,omitempty"`
	EnvKeysChanged          []string                `json:"envKeysChanged,omitempty"`
	RuntimeID               string                  `json:"runtimeId,omitempty"`
	RuntimeLabel            string                  `json:"runtimeLabel,omitempty"`
	RuntimeConfidence       string                  `json:"runtimeConfidence,omitempty"`
	SelectedCommand         *SelectedCommandPreview `json:"selectedCommand,omitempty"`
	PortStrategy            string                  `json:"portStrategy,omitempty"`
	PortStrategyCandidates  []string                `json:"portStrategyCandidates,omitempty"`
	SetupQuestions          []string                `json:"setupQuestions,omitempty"`
	HealthRoute             string                  `json:"healthRoute,omitempty"`
	MayIncludeSensitiveData bool                    `json:"mayIncludeSensitiveData,omitempty"`
}

type SelectedCommandPreview struct {
	Argv    []string `json:"argv,omitempty"`
	Preview string   `json:"preview,omitempty"`
}

type AgentFileWriteApproval struct {
	Kind          string        `json:"kind"`
	SetupPlanID   string        `json:"setupPlanId,omitempty"`
	FileWritePlan FileWritePlan `json:"fileWritePlan"`
	Risk          string        `json:"risk,omitempty"`
}

type AgentManifestPatchApproval struct {
	Kind              string            `json:"kind"`
	ManifestPatchPlan ManifestPatchPlan `json:"manifestPatchPlan"`
	Risk              string            `json:"risk,omitempty"`
}

type AgentOpenRouteApproval struct {
	Kind  string `json:"kind"`
	AppID string `json:"appId,omitempty"`
	Route string `json:"route"`
	Risk  string `json:"risk,omitempty"`
}

type TuiProposedAction struct {
	Kind              string                  `json:"kind"`
	Target            TuiProposedActionTarget `json:"target,omitempty"`
	Route             string                  `json:"route,omitempty"`
	Color             string                  `json:"color,omitempty"`
	RequiresApproval  bool                    `json:"requiresApproval,omitempty"`
	UnavailableReason string                  `json:"unavailableReason,omitempty"`
}

type TuiProposedActionTarget struct {
	PaneID        string `json:"paneId,omitempty"`
	AppID         string `json:"appId,omitempty"`
	GroupID       string `json:"groupId,omitempty"`
	ComponentRole string `json:"componentRole,omitempty"`
}

type AgentSessionCreateRequest struct {
	Title   string           `json:"title,omitempty"`
	Context *TuiAgentContext `json:"context,omitempty"`
}

type AgentSessionUpdateRequest struct {
	Title   string              `json:"title,omitempty"`
	Context *TuiAgentContext    `json:"context,omitempty"`
	Active  *bool               `json:"active,omitempty"`
	Privacy *AgentThreadPrivacy `json:"privacy,omitempty"`
}

type AgentSessionClearResult struct {
	SessionID string `json:"sessionId"`
	Cleared   bool   `json:"cleared"`
}

type AgentSessionExportRequest struct {
	Format string `json:"format,omitempty"`
}

type AgentSessionExportResult struct {
	ExportID        string          `json:"exportId"`
	Status          string          `json:"status"`
	Format          string          `json:"format"`
	OutputPath      string          `json:"outputPath"`
	SessionID       string          `json:"sessionId"`
	MessageCount    int             `json:"messageCount,omitempty"`
	AuditEventCount int             `json:"auditEventCount,omitempty"`
	GeneratedAt     string          `json:"generatedAt,omitempty"`
	RedactionReport json.RawMessage `json:"redactionReport,omitempty"`
}

type AgentMessageRequest struct {
	Content string           `json:"content"`
	Context *TuiAgentContext `json:"context,omitempty"`
}

type AgentMessageResult struct {
	Message     AgentMessage      `json:"message"`
	Run         AgentRun          `json:"run"`
	Diagnostics []AgentDiagnostic `json:"diagnostics,omitempty"`
}

type AgentApprovalResolutionRequest struct {
	Reason    string          `json:"reason,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
	Reconfirm bool            `json:"reconfirm,omitempty"`
	Resume    bool            `json:"resume,omitempty"`
}
