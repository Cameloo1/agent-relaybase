package setupwizard

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/assistant"
)

const (
	ModeNone       = ""
	ModeNoApps     = "no_apps"
	ModeDetect     = "detect"
	ModePreview    = "preview"
	ModeRepair     = "repair"
	ModeManifest   = "manifest"
	ModeApply      = "apply"
	ModeRegistered = "registered"
	ModeOpen       = "open"
	ModeProve      = "prove"
)

type Action struct {
	Label   string
	Command string
	Enabled bool
	Reason  string
}

type State struct {
	Mode             string
	CurrentDirectory string
	Title            string
	Message          string
	Actions          []Action
	Detection        *relaybaseclient.SetupDetectResult
	Plans            *relaybaseclient.SetupPlansResult
	Preview          *relaybaseclient.SetupPlanPreview
	Repair           *relaybaseclient.RepairSetupResult
	Manifest         *relaybaseclient.ExistingManifestAnalysis
	ManifestPatch    *relaybaseclient.ManifestPatchPlan
	Apply            *relaybaseclient.SetupApplyResult
	Register         *relaybaseclient.RegisterManifestResult
	Open             *relaybaseclient.OpenProjectResult
	Prove            *relaybaseclient.ProveHealthResult
}

func Empty() State {
	return State{}
}

func NoApps(currentDirectory string) State {
	return State{
		Mode:             ModeNoApps,
		CurrentDirectory: strings.TrimSpace(currentDirectory),
		Title:            "No Apps Registered",
		Message:          noAppsMessage(currentDirectory),
		Actions: []Action{
			{
				Label:   "Configure current project",
				Command: "/configure current folder --dry-run",
				Enabled: strings.TrimSpace(currentDirectory) != "",
				Reason:  disabledReason(strings.TrimSpace(currentDirectory) != "", "trusted current-directory context is unavailable"),
			},
			{Label: "Register manifest", Command: "/register <manifest-path>", Enabled: true},
			{Label: "Choose project path", Command: "/configure <path> --dry-run", Enabled: true},
			{Label: "Open setup docs", Command: "docs/tui-setup-onboarding.md", Enabled: true},
			{Label: "Start daemon", Command: "relaybase serve", Enabled: true},
		},
	}
}

func FromDetect(result *relaybaseclient.SetupDetectResult) State {
	state := State{Mode: ModeDetect, Title: "Setup Detection", Detection: result}
	if result != nil {
		state.CurrentDirectory = result.CWD
		state.Message = fmt.Sprintf(
			"Detected %s project using %s in %s.",
			valueOr(primaryRuntimeLabel(result), valueOr(result.Framework, "unknown")),
			valueOr(result.PackageManager, "unknown"),
			result.CWD,
		)
	}
	return state
}

func FromPlans(result *relaybaseclient.SetupPlansResult) State {
	state := State{Mode: ModePreview, Title: "Setup Plan Choices", Plans: result}
	if result != nil {
		state.CurrentDirectory = result.CWD
		state.Message = fmt.Sprintf("Daemon returned %d setup choice(s).", len(result.Choices))
	}
	return state
}

func FromPreview(result *relaybaseclient.SetupPlanPreview) State {
	state := State{Mode: ModePreview, Title: "Setup Preview", Preview: result}
	if result != nil {
		state.CurrentDirectory = result.CWD
		state.Message = fmt.Sprintf("Previewing %s; %d file write(s) require review.", valueOr(result.SelectedPlan.Label, result.SelectedPlan.ID), len(result.FileWritePlan.Writes))
	}
	return state
}

func FromRepair(result *relaybaseclient.RepairSetupResult) State {
	state := State{Mode: ModeRepair, Title: "Setup Repair Choices", Repair: result}
	if result != nil {
		state.CurrentDirectory = result.Plan.CWD
		state.Message = fmt.Sprintf("Daemon returned %d repair choice(s) and %d preview(s).", len(result.Plan.Choices), len(result.Plan.Previews))
	}
	return state
}

func FromManifest(result *relaybaseclient.ExistingManifestAnalysis) State {
	state := State{Mode: ModeManifest, Title: "Manifest Inspection", Manifest: result}
	if result != nil {
		state.Message = fmt.Sprintf("Manifest %s is %s.", valueOr(result.Path, "<memory>"), validLabel(result.Valid))
	}
	return state
}

func FromManifestPatch(result *relaybaseclient.ManifestPatchPlan) State {
	state := State{Mode: ModeManifest, Title: "Manifest Patch Preview", ManifestPatch: result}
	if result != nil {
		state.CurrentDirectory = result.CWD
		state.Message = fmt.Sprintf("Previewing manifest patch for %s.", result.ManifestPath)
	}
	return state
}

func FromApply(result *relaybaseclient.SetupApplyResult) State {
	state := State{Mode: ModeApply, Title: "Setup Applied", Apply: result}
	if result != nil {
		state.CurrentDirectory = result.CWD
		state.Message = fmt.Sprintf("Applied setup plan %s with %d file result(s).", valueOr(result.SelectedPlan.ID, result.SelectedPlan.Label), len(result.AppliedFiles))
	}
	return state
}

func FromRegister(result *relaybaseclient.RegisterManifestResult) State {
	state := State{Mode: ModeRegistered, Title: "Manifest Registered", Register: result}
	if result != nil {
		state.Message = fmt.Sprintf("Registered %s from %s.", valueOr(result.App.ID, result.App.Name), result.ManifestPath)
	}
	return state
}

func FromOpen(result *relaybaseclient.OpenProjectResult) State {
	state := State{Mode: ModeOpen, Title: "Open Project", Open: result}
	if result != nil {
		state.CurrentDirectory = result.Plan.CWD
		state.Message = fmt.Sprintf("Daemon open flow completed for %s.", result.Plan.CWD)
	}
	return state
}

func FromProve(result *relaybaseclient.ProveHealthResult) State {
	state := State{Mode: ModeProve, Title: "Health Proof", Prove: result}
	if result != nil {
		state.CurrentDirectory = result.CWD
		state.Message = fmt.Sprintf("Daemon proof flow completed for %s.", result.CWD)
	}
	return state
}

func (s State) Active() bool {
	return s.Mode != ModeNone
}

func (s State) Render() string {
	if !s.Active() {
		return ""
	}
	lines := []string{s.Title}
	if s.CurrentDirectory != "" {
		lines = append(lines, "cwd: "+s.CurrentDirectory)
	}
	if s.Message != "" {
		lines = append(lines, assistant.SanitizeText(s.Message))
	}
	lines = append(lines, diagnosticsLines(s)...)
	lines = append(lines, selectedPlanLines(s)...)
	lines = append(lines, runtimeLines(s)...)
	lines = append(lines, choiceLines(s)...)
	lines = append(lines, writePlanLines(s)...)
	lines = append(lines, appliedLines(s)...)
	lines = append(lines, registeredLines(s)...)
	lines = append(lines, actionLines(s)...)
	return strings.Join(lines, "\n")
}

func diagnosticsLines(s State) []string {
	diagnostics := []relaybaseclient.SetupDiagnostic{}
	if s.Detection != nil {
		diagnostics = append(diagnostics, s.Detection.Diagnostics...)
	}
	if s.Plans != nil {
		diagnostics = append(diagnostics, s.Plans.Diagnostics...)
	}
	if s.Preview != nil {
		diagnostics = append(diagnostics, s.Preview.Diagnostics...)
	}
	if s.Repair != nil {
		diagnostics = append(diagnostics, s.Repair.Plan.Diagnostics...)
	}
	if s.Manifest != nil {
		diagnostics = append(diagnostics, s.Manifest.Diagnostics...)
	}
	if s.ManifestPatch != nil {
		diagnostics = append(diagnostics, s.ManifestPatch.Diagnostics...)
	}
	if s.Apply != nil {
		diagnostics = append(diagnostics, s.Apply.Diagnostics...)
	}
	if len(diagnostics) == 0 {
		return nil
	}
	lines := []string{"diagnostics:"}
	for _, diagnostic := range diagnostics {
		lines = append(lines, fmt.Sprintf("- [%s] %s: %s", valueOr(diagnostic.Severity, "info"), diagnostic.Code, assistant.SanitizeText(diagnostic.Message)))
	}
	return lines
}

func choiceLines(s State) []string {
	choices := []relaybaseclient.SetupPlanChoice{}
	if s.Plans != nil {
		choices = append(choices, s.Plans.Choices...)
	}
	if s.Preview != nil {
		choices = append(choices, s.Preview.Choices...)
	}
	if s.Repair != nil {
		choices = append(choices, s.Repair.Plan.Choices...)
	}
	if len(choices) == 0 {
		return nil
	}
	lines := []string{"choices:"}
	for _, choice := range choices {
		details := []string{choice.ID}
		if choice.Architecture != "" {
			details = append(details, choice.Architecture)
		}
		if choice.RuntimeID != "" {
			details = append(details, "runtime "+runtimeLabel(choice.RuntimeID, choice.RuntimeConfidence))
		}
		if len(choice.PortStrategies) > 0 {
			details = append(details, strings.Join(choice.PortStrategies, "+"))
		}
		lines = append(lines, "- "+assistant.SanitizeText(valueOr(choice.Label, strings.Join(details, " | "))))
		lines = append(lines, choiceRuntimeDetailLines(choice)...)
		if len(choice.Risks) > 0 {
			lines = append(lines, "  risks: "+assistant.SanitizeText(strings.Join(choice.Risks, "; ")))
		}
		if len(choice.RecoverySteps) > 0 {
			lines = append(lines, "  recovery: "+assistant.SanitizeText(strings.Join(choice.RecoverySteps, "; ")))
		}
	}
	return lines
}

func selectedPlanLines(s State) []string {
	if s.Preview == nil {
		return nil
	}
	preview := s.Preview
	choice := preview.SelectedPlan.Choice
	lines := []string{"selected setup:"}
	if preview.CWD != "" {
		lines = append(lines, "  project path: "+assistant.SanitizeText(preview.CWD))
	}
	planLabel := valueOr(preview.SelectedPlan.Label, preview.SelectedPlan.ID)
	if planLabel != "" {
		if preview.SelectedPlan.ID != "" && preview.SelectedPlan.ID != planLabel {
			planLabel += " (" + preview.SelectedPlan.ID + ")"
		}
		if preview.SelectedPlan.Architecture != "" {
			planLabel += " | " + preview.SelectedPlan.Architecture
		}
		lines = append(lines, "  plan: "+assistant.SanitizeText(planLabel))
	}
	if choice.RuntimeID != "" || choice.Framework != "" {
		runtime := valueOr(choice.RuntimeID, "unknown")
		if choice.RuntimeConfidence != "" {
			runtime += " (" + choice.RuntimeConfidence + ")"
		}
		if choice.Framework != "" {
			runtime += " | framework " + choice.Framework
		}
		lines = append(lines, "  runtime/framework: "+assistant.SanitizeText(runtime))
	}
	if command := selectedCommandLabel(choice); command != "" {
		lines = append(lines, "  selected command: "+assistant.SanitizeText(command))
	}
	if strategy := selectedPortStrategyLabel(choice); strategy != "" {
		lines = append(lines, "  port strategy: "+assistant.SanitizeText(strategy))
	}
	if app := manifestAppLabel(preview.SelectedPlan.Manifest); app != "" {
		lines = append(lines, "  app: "+assistant.SanitizeText(app))
	}
	lines = append(lines, fmt.Sprintf("  files: %d write(s), approval required: %s", len(preview.FileWritePlan.Writes), yesNo(preview.FileWritePlan.ApprovalRequired)))
	return lines
}

func runtimeLines(s State) []string {
	lines := []string{}
	if s.Detection != nil {
		if s.Detection.PrimaryRuntime != nil {
			lines = append(lines, "runtime: "+assistant.SanitizeText(runtimeDetectionLabel(*s.Detection.PrimaryRuntime)))
		}
		if s.Detection.RuntimeMatrix != nil {
			if len(s.Detection.RuntimeMatrix.Runtimes) > 0 {
				candidates := []string{}
				for _, runtime := range s.Detection.RuntimeMatrix.Runtimes[:minInt(len(s.Detection.RuntimeMatrix.Runtimes), 5)] {
					candidates = append(candidates, runtimeDetectionLabel(runtime))
				}
				lines = append(lines, "runtime candidates: "+assistant.SanitizeText(strings.Join(candidates, "; ")))
			}
			lines = append(lines, setupQuestionLines("setup questions", s.Detection.RuntimeMatrix.Questions)...)
		}
	}
	if s.Repair != nil {
		if s.Repair.Plan.RuntimeMatrix != nil && len(s.Repair.Plan.RuntimeMatrix.Runtimes) > 0 {
			candidates := []string{}
			for _, runtime := range s.Repair.Plan.RuntimeMatrix.Runtimes[:minInt(len(s.Repair.Plan.RuntimeMatrix.Runtimes), 5)] {
				candidates = append(candidates, runtimeDetectionLabel(runtime))
			}
			lines = append(lines, "runtime candidates: "+assistant.SanitizeText(strings.Join(candidates, "; ")))
		}
		if len(s.Repair.Plan.RepairCandidates) > 0 {
			repairs := []string{}
			for _, repair := range s.Repair.Plan.RepairCandidates[:minInt(len(s.Repair.Plan.RepairCandidates), 6)] {
				repairs = append(repairs, repairLabel(repair))
			}
			lines = append(lines, "runtime repairs: "+assistant.SanitizeText(strings.Join(repairs, "; ")))
		}
	}
	return lines
}

func choiceRuntimeDetailLines(choice relaybaseclient.SetupPlanChoice) []string {
	lines := []string{}
	if choice.RuntimeID != "" {
		lines = append(lines, "  runtime: "+assistant.SanitizeText(runtimeLabel(choice.RuntimeID, choice.RuntimeConfidence)))
	}
	if len(choice.RuntimeStartCommandCandidates) > 0 {
		commands := []string{}
		for _, candidate := range choice.RuntimeStartCommandCandidates[:minInt(len(choice.RuntimeStartCommandCandidates), 3)] {
			commands = append(commands, commandCandidateLabel(candidate))
		}
		lines = append(lines, "  commands: "+assistant.SanitizeText(strings.Join(commands, "; ")))
	}
	if len(choice.RuntimePortStrategies) > 0 {
		strategies := []string{}
		for _, strategy := range choice.RuntimePortStrategies[:minInt(len(choice.RuntimePortStrategies), 4)] {
			strategies = append(strategies, portStrategyLabel(strategy))
		}
		lines = append(lines, "  port strategies: "+assistant.SanitizeText(strings.Join(strategies, "; ")))
	}
	if len(choice.RuntimeHealthCandidates) > 0 {
		health := []string{}
		for _, candidate := range choice.RuntimeHealthCandidates[:minInt(len(choice.RuntimeHealthCandidates), 4)] {
			health = append(health, candidate.Path)
		}
		lines = append(lines, "  health: "+assistant.SanitizeText(strings.Join(health, ", ")))
	}
	lines = append(lines, setupQuestionLines("  questions", choice.SetupQuestions)...)
	if len(choice.RepairCandidates) > 0 {
		repairs := []string{}
		for _, repair := range choice.RepairCandidates[:minInt(len(choice.RepairCandidates), 4)] {
			repairs = append(repairs, repairLabel(repair))
		}
		lines = append(lines, "  repairs: "+assistant.SanitizeText(strings.Join(repairs, "; ")))
	}
	return lines
}

func writePlanLines(s State) []string {
	var plan *relaybaseclient.FileWritePlan
	if s.Preview != nil {
		plan = &s.Preview.FileWritePlan
	}
	if s.ManifestPatch != nil {
		plan = &s.ManifestPatch.FileWritePlan
	}
	if plan == nil || len(plan.Writes) == 0 {
		return nil
	}
	lines := []string{"file preview:"}
	for _, write := range plan.Writes {
		lines = append(lines, fmt.Sprintf("- %s %s", write.Action, write.Path))
		if write.Reason != "" {
			lines = append(lines, "  reason: "+assistant.SanitizeText(write.Reason))
		}
		for _, hunk := range write.Diff.Hunks[:minInt(len(write.Diff.Hunks), 8)] {
			lines = append(lines, "  "+assistant.SanitizeText(hunk))
		}
		if len(write.Diff.Hunks) > 8 {
			lines = append(lines, "  ... diff truncated in TUI preview ...")
		}
	}
	if len(plan.Risks) > 0 {
		lines = append(lines, "approval risks:")
		for _, risk := range plan.Risks {
			lines = append(lines, fmt.Sprintf("- [%s] %s", valueOr(risk.Severity, "warning"), assistant.SanitizeText(risk.Message)))
		}
	}
	return lines
}

func appliedLines(s State) []string {
	if s.Apply == nil {
		return nil
	}
	lines := []string{"applied setup:"}
	if len(s.Apply.AppliedFiles) > 0 {
		lines = append(lines, "  files:")
		for _, file := range s.Apply.AppliedFiles {
			lines = append(lines, fmt.Sprintf("  - %s %s", valueOr(file.Action, "updated"), assistant.SanitizeText(file.Path)))
		}
	}
	if s.Apply.RegisteredApp != nil {
		lines = append(lines, "  registered app: "+appRecordLabel(*s.Apply.RegisteredApp))
	}
	return lines
}

func registeredLines(s State) []string {
	if s.Register == nil {
		return nil
	}
	lines := []string{"registered app:"}
	lines = append(lines, "  "+appRecordLabel(s.Register.App))
	if s.Register.ManifestPath != "" {
		lines = append(lines, "  manifest: "+assistant.SanitizeText(s.Register.ManifestPath))
	}
	return lines
}

func actionLines(s State) []string {
	if len(s.Actions) == 0 {
		return nil
	}
	lines := []string{"actions:"}
	for _, action := range s.Actions {
		label := action.Label
		if !action.Enabled {
			label += " (unavailable: " + action.Reason + ")"
		}
		if action.Command != "" {
			label += " -> " + action.Command
		}
		lines = append(lines, "- "+label)
	}
	return lines
}

func ManifestPathFromApp(app relaybaseclient.AppState) string {
	return strings.TrimSpace(app.ManifestPath)
}

func CWDFromManifestPath(manifestPath string) string {
	if strings.TrimSpace(manifestPath) == "" {
		return ""
	}
	return filepath.Dir(manifestPath)
}

func noAppsMessage(currentDirectory string) string {
	if strings.TrimSpace(currentDirectory) == "" {
		return "No apps are registered. Choose a project path or register an existing manifest."
	}
	return "No apps are registered. You can preview setup for the current directory or choose another project path."
}

func primaryRuntimeLabel(result *relaybaseclient.SetupDetectResult) string {
	if result == nil || result.PrimaryRuntime == nil {
		return ""
	}
	return runtimeDetectionLabel(*result.PrimaryRuntime)
}

func runtimeDetectionLabel(runtime relaybaseclient.RuntimeDetectionResult) string {
	return fmt.Sprintf("%s (%s)", valueOr(runtime.Label, runtime.Runtime), valueOr(runtime.Confidence, "unknown"))
}

func runtimeLabel(runtimeID string, confidence string) string {
	if confidence == "" {
		return runtimeID
	}
	return runtimeID + " (" + confidence + ")"
}

func commandCandidateLabel(candidate relaybaseclient.StartCommandCandidate) string {
	label := valueOr(candidate.Label, candidate.ID)
	command := valueOr(candidate.CommandPreview, strings.Join(candidate.Command, " "))
	if command == "" {
		return label
	}
	if label == "" {
		return command
	}
	return label + " -> " + command
}

func selectedCommandLabel(choice relaybaseclient.SetupPlanChoice) string {
	if len(choice.RuntimeStartCommandCandidates) == 0 {
		return ""
	}
	return commandCandidateLabel(choice.RuntimeStartCommandCandidates[0])
}

func selectedPortStrategyLabel(choice relaybaseclient.SetupPlanChoice) string {
	if len(choice.RuntimePortStrategies) > 0 {
		return portStrategyLabel(choice.RuntimePortStrategies[0])
	}
	if len(choice.PortStrategies) > 0 {
		return choice.PortStrategies[0]
	}
	return ""
}

func portStrategyLabel(strategy relaybaseclient.PortBindingStrategy) string {
	label := strategy.ID
	if strategy.Confidence != "" {
		label += " (" + strategy.Confidence + ")"
	}
	if len(strategy.Args) > 0 {
		label += " args " + strings.Join(strategy.Args, " ")
	}
	if len(strategy.Env) > 0 {
		keys := []string{}
		for key := range strategy.Env {
			keys = append(keys, key)
		}
		label += " env " + strings.Join(keys, ",")
	}
	return label
}

func manifestAppLabel(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var manifest struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		Command      string `json:"command"`
		CWD          string `json:"cwd"`
		HealthURL    string `json:"healthUrl"`
		UpstreamPort int    `json:"upstreamPort"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return ""
	}
	parts := []string{}
	if manifest.ID != "" {
		parts = append(parts, "id "+manifest.ID)
	}
	if manifest.Name != "" {
		parts = append(parts, "name "+manifest.Name)
	}
	if manifest.Command != "" {
		parts = append(parts, "command "+manifest.Command)
	}
	if manifest.HealthURL != "" {
		parts = append(parts, "health "+manifest.HealthURL)
	}
	if manifest.UpstreamPort > 0 {
		parts = append(parts, fmt.Sprintf("upstream port %d", manifest.UpstreamPort))
	}
	return strings.Join(parts, " | ")
}

func appRecordLabel(app relaybaseclient.SetupAppRecord) string {
	parts := []string{}
	if app.ID != "" {
		parts = append(parts, "id "+app.ID)
	}
	if app.Name != "" {
		parts = append(parts, "name "+app.Name)
	}
	if app.Command != "" {
		parts = append(parts, "command "+app.Command)
	}
	if app.CWD != "" {
		parts = append(parts, "cwd "+app.CWD)
	}
	if app.HealthURL != "" {
		parts = append(parts, "health "+app.HealthURL)
	}
	return assistant.SanitizeText(strings.Join(parts, " | "))
}

func setupQuestionLines(prefix string, questions []relaybaseclient.SetupQuestion) []string {
	if len(questions) == 0 {
		return nil
	}
	labels := []string{}
	for _, question := range questions[:minInt(len(questions), 5)] {
		labels = append(labels, valueOr(question.Prompt, question.ID))
	}
	return []string{prefix + ": " + assistant.SanitizeText(strings.Join(labels, "; "))}
}

func repairLabel(repair relaybaseclient.RepairCandidate) string {
	label := valueOr(repair.Label, repair.ID)
	if repair.AppliesTo != "" {
		label += " for " + repair.AppliesTo
	}
	if repair.ApprovalRequired {
		label += " (approval required)"
	}
	return label
}

func validLabel(valid bool) string {
	if valid {
		return "valid"
	}
	return "invalid"
}

func disabledReason(enabled bool, reason string) string {
	if enabled {
		return ""
	}
	return reason
}

func yesNo(value bool) string {
	if value {
		return "yes"
	}
	return "no"
}

func valueOr(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return strings.TrimSpace(value)
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}
