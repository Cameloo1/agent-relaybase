package setupwizard

import (
	"strings"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

func TestNoAppsRendersCurrentDirectoryActions(t *testing.T) {
	state := NoApps("C:/project")
	rendered := state.Render()
	for _, expected := range []string{
		"No Apps Registered",
		"cwd: C:/project",
		"/configure current folder --dry-run",
		"/register <manifest-path>",
		"/configure <path> --dry-run",
		"relaybase serve",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("expected %q in no-apps render:\n%s", expected, rendered)
		}
	}
}

func TestNoAppsWithoutCurrentDirectoryDisablesCurrentFolder(t *testing.T) {
	rendered := NoApps("").Render()
	if !strings.Contains(rendered, "unavailable: trusted current-directory context is unavailable") {
		t.Fatalf("expected unavailable current-folder reason:\n%s", rendered)
	}
}

func TestPreviewRendersChoicesDiffsAndRedactsSecretLikeValues(t *testing.T) {
	state := FromPreview(&relaybaseclient.SetupPlanPreview{
		CWD: "C:/project",
		SelectedPlan: relaybaseclient.SetupPlan{
			ID:       "framework-port-flag",
			Label:    "Framework port flag wrapper",
			Manifest: []byte(`{"id":"selection-web","name":"Selection Web","command":"npm run dev","healthUrl":"/health"}`),
			Choice: relaybaseclient.SetupPlanChoice{
				ID:                "framework-port-flag",
				RuntimeID:         "python",
				RuntimeConfidence: "high",
				PortStrategies:    []string{"explicit_host_port_flags", "generated_launch_wrapper"},
				RuntimeStartCommandCandidates: []relaybaseclient.StartCommandCandidate{
					{ID: "python.uvicorn", Label: "FastAPI/Uvicorn", CommandPreview: "python -m uvicorn main:app --host HOST --port PORT"},
				},
				RuntimePortStrategies: []relaybaseclient.PortBindingStrategy{
					{ID: "explicit_host_port_flags", Confidence: "high", Args: []string{"--host", "HOST", "--port", "PORT"}},
				},
				RuntimeHealthCandidates: []relaybaseclient.RuntimeHealthCandidate{{Path: "/healthz", Confidence: "medium"}},
				SetupQuestions: []relaybaseclient.SetupQuestion{
					{ID: "python.module", Prompt: "Which ASGI module should Relaybase run?", Required: true},
				},
			},
		},
		Choices: []relaybaseclient.SetupPlanChoice{
			{
				ID:                "framework-port-flag",
				Label:             "Framework port flag wrapper",
				Architecture:      "generated_launch_wrapper",
				RuntimeID:         "python",
				RuntimeConfidence: "high",
				PortStrategies:    []string{"explicit_host_port_flags", "generated_launch_wrapper"},
				RuntimeStartCommandCandidates: []relaybaseclient.StartCommandCandidate{
					{ID: "python.uvicorn", Label: "FastAPI/Uvicorn", CommandPreview: "python -m uvicorn main:app --host HOST --port PORT"},
				},
				RuntimePortStrategies: []relaybaseclient.PortBindingStrategy{
					{ID: "explicit_host_port_flags", Confidence: "high", Args: []string{"--host", "HOST", "--port", "PORT"}},
				},
				RuntimeHealthCandidates: []relaybaseclient.RuntimeHealthCandidate{{Path: "/healthz", Confidence: "medium"}},
				SetupQuestions: []relaybaseclient.SetupQuestion{
					{ID: "python.module", Prompt: "Which ASGI module should Relaybase run?", Required: true},
				},
				RepairCandidates: []relaybaseclient.RepairCandidate{
					{ID: "python.explicit-port", Label: "Use explicit Uvicorn host/port flags", AppliesTo: "python", ApprovalRequired: true},
				},
				Risks:         []string{"writes relaybase.app.json"},
				RecoverySteps: []string{"choose pinned upstream port if this app ignores PORT"},
			},
		},
		FileWritePlan: relaybaseclient.FileWritePlan{
			Root:             "C:/project",
			ApprovalRequired: true,
			Writes: []relaybaseclient.FileWritePreview{
				{
					Path:   "C:/project/relaybase.app.json",
					Action: "create",
					Reason: "Relaybase app manifest",
					Diff: relaybaseclient.FileDiff{
						Path:         "C:/project/relaybase.app.json",
						BeforeExists: false,
						AfterExists:  true,
						Changed:      true,
						Hunks:        []string{`+ {"env":{"API_TOKEN":"super-secret-token"}}`},
					},
				},
			},
			Risks: []relaybaseclient.SetupApprovalRisk{
				{Code: "manifest_write", Severity: "warning", Message: "writes relaybase.app.json", RequiresApproval: true},
			},
		},
	})

	rendered := state.Render()
	for _, expected := range []string{
		"Setup Preview",
		"Framework port flag wrapper",
		"selected setup:",
		"project path: C:/project",
		"selected command: FastAPI/Uvicorn -> python -m uvicorn main:app --host HOST --port PORT",
		"port strategy: explicit_host_port_flags (high) args --host HOST --port PORT",
		"app: id selection-web | name Selection Web | command npm run dev | health /health",
		"runtime: python (high)",
		"FastAPI/Uvicorn -> python -m uvicorn main:app --host HOST --port PORT",
		"explicit_host_port_flags (high) args --host HOST --port PORT",
		"Which ASGI module should Relaybase run?",
		"Use explicit Uvicorn host/port flags for python",
		"file preview:",
		"create C:/project/relaybase.app.json",
		"approval risks:",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("expected %q in preview render:\n%s", expected, rendered)
		}
	}
	if strings.Contains(rendered, "super-secret-token") || strings.Contains(rendered, "API_TOKEN") {
		t.Fatalf("preview leaked secret-like diff content:\n%s", rendered)
	}
}

func TestApplyAndRegisterRenderDaemonSummaries(t *testing.T) {
	apply := FromApply(&relaybaseclient.SetupApplyResult{
		CWD:          "C:/project",
		SelectedPlan: relaybaseclient.SetupPlanChoice{ID: "managed"},
		AppliedFiles: []relaybaseclient.SetupAppliedFile{
			{Path: "C:/project/relaybase.app.json", Action: "created"},
			{Path: "C:/project/.relaybase/launch.cjs", Action: "created"},
		},
		RegisteredApp: &relaybaseclient.SetupAppRecord{
			ID:        "selection-web",
			Name:      "Selection Web",
			Command:   "npm run dev",
			CWD:       "C:/project",
			HealthURL: "/health",
		},
	})
	rendered := apply.Render()
	for _, expected := range []string{
		"Setup Applied",
		"applied setup:",
		"created C:/project/relaybase.app.json",
		"created C:/project/.relaybase/launch.cjs",
		"registered app: id selection-web | name Selection Web | command npm run dev | cwd C:/project | health /health",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("expected %q in apply render:\n%s", expected, rendered)
		}
	}

	register := FromRegister(&relaybaseclient.RegisterManifestResult{
		ManifestPath: "C:/project/relaybase.app.json",
		App: relaybaseclient.SetupAppRecord{
			ID:      "selection-web",
			Name:    "Selection Web",
			Command: "npm run dev",
			CWD:     "C:/project",
		},
	})
	rendered = register.Render()
	for _, expected := range []string{
		"Manifest Registered",
		"registered app:",
		"id selection-web | name Selection Web | command npm run dev | cwd C:/project",
		"manifest: C:/project/relaybase.app.json",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("expected %q in register render:\n%s", expected, rendered)
		}
	}
}

func TestRepairRendersPlanChoices(t *testing.T) {
	state := FromRepair(&relaybaseclient.RepairSetupResult{
		Plan: relaybaseclient.RepairSetupPlan{
			CWD: "C:/project",
			Choices: []relaybaseclient.SetupPlanChoice{
				{ID: "pinned-upstream-port", Label: "Pinned upstream port", RuntimeID: "go", RuntimeConfidence: "medium"},
			},
			RuntimeMatrix: &relaybaseclient.RuntimeMatrixSnapshot{
				PrimaryRuntime: "go",
				Runtimes: []relaybaseclient.RuntimeDetectionResult{
					{Runtime: "go", Label: "Go", Confidence: "medium"},
				},
			},
			RepairCandidates: []relaybaseclient.RepairCandidate{
				{ID: "go.pinned-port", Label: "Use pinned upstream port", AppliesTo: "go", ApprovalRequired: true},
			},
			Diagnostics: []relaybaseclient.SetupDiagnostic{
				{Code: "SETUP_REPAIR_PREVIEW_ONLY", Severity: "info", Message: "Preview only"},
			},
		},
	})
	rendered := state.Render()
	if !strings.Contains(rendered, "Setup Repair Choices") ||
		!strings.Contains(rendered, "Pinned upstream port") ||
		!strings.Contains(rendered, "runtime candidates: Go (medium)") ||
		!strings.Contains(rendered, "Use pinned upstream port for go") ||
		!strings.Contains(rendered, "SETUP_REPAIR_PREVIEW_ONLY") {
		t.Fatalf("expected repair choices and diagnostics:\n%s", rendered)
	}
}

func TestDetectRendersRuntimeMatrixQuestions(t *testing.T) {
	state := FromDetect(&relaybaseclient.SetupDetectResult{
		CWD:            "C:/project",
		PackageManager: "unknown",
		Framework:      "unknown",
		PrimaryRuntime: &relaybaseclient.RuntimeDetectionResult{Runtime: "docker-compose", Label: "Docker Compose", Confidence: "medium"},
		RuntimeMatrix: &relaybaseclient.RuntimeMatrixSnapshot{
			PrimaryRuntime: "docker-compose",
			Runtimes: []relaybaseclient.RuntimeDetectionResult{
				{Runtime: "docker-compose", Label: "Docker Compose", Confidence: "medium"},
				{Runtime: "procfile", Label: "Procfile", Confidence: "low"},
			},
			Questions: []relaybaseclient.SetupQuestion{
				{ID: "docker.service", Prompt: "Which Docker Compose service should Relaybase route?", Required: true},
			},
		},
	})

	rendered := state.Render()
	for _, expected := range []string{
		"Detected Docker Compose (medium) project",
		"runtime: Docker Compose (medium)",
		"runtime candidates: Docker Compose (medium); Procfile (low)",
		"Which Docker Compose service should Relaybase route?",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("expected %q in detect render:\n%s", expected, rendered)
		}
	}
}
