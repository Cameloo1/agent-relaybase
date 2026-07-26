package slash

import (
	"sort"
	"strings"
	"unicode"

	"github.com/cameloo/relaybase/tui/internal/tui/styles"
)

// CommandDescriptor is the discoverability contract shared by help and slash
// completion. Parse remains the semantic validation source of truth.
type CommandDescriptor struct {
	Kind        string
	Canonical   string
	Insertion   string
	Usages      []string
	Description string
	Examples    []string
	Keywords    []string
	Aliases     []string
	// CompatibilityAliases participate in parsing, prefix recognition, and
	// completion without being presented as normal user-facing commands.
	CompatibilityAliases []string
	Category             string
	Approval             bool
	// ConfirmationPolicy makes conditional commands honest in help while
	// Approval remains the representative-example compatibility flag.
	ConfirmationPolicy ConfirmationPolicy
}

type ConfirmationPolicy string

const (
	ConfirmationNever        ConfirmationPolicy = "never"
	ConfirmationAlways       ConfirmationPolicy = "always"
	ConfirmationWhenTargeted ConfirmationPolicy = "when_targeted"
)

// CommandMatch is a ranked catalog result. Score is intended only for stable
// ordering and must not be persisted as product state.
type CommandMatch struct {
	Descriptor CommandDescriptor
	Score      int
}

var commandCatalog = []CommandDescriptor{
	descriptor(KindLaunch, "/launch", "/launch ", "lifecycle", true, "Start an app, group, or component role through the daemon.", []string{"/launch <app|group|role>"}, []string{"/launch notes"}, []string{"start", "run"}),
	withConfirmationPolicy(descriptor(KindStart, "/start", "/start ", "inventory", true, "Open the registered app launcher, or request a confirmation-gated start for one registered app.", []string{"/start", "/start <app>"}, []string{"/start notes"}, []string{"apps", "registered", "saved", "launcher", "run"}), ConfirmationWhenTargeted),
	descriptor(KindStop, "/stop", "/stop ", "lifecycle", true, "Stop an app, group, or component role through the daemon.", []string{"/stop <app|group|role>"}, []string{"/stop notes"}, []string{"shutdown"}),
	descriptor(KindRestart, "/restart", "/restart ", "lifecycle", true, "Restart an app, group, or component role through the daemon.", []string{"/restart <app|group|role>"}, []string{"/restart notes"}, []string{"reboot", "reload"}),
	descriptor(KindLogsExport, "/logs export", "/logs export ", "logs", true, "Export a redacted log scope through the daemon.", []string{"/logs export <pane|app|group|page|all>"}, []string{"/logs export all"}, []string{"download", "save"}),
	descriptor(KindPage, "/page", "/page ", "layout", false, "Move between dashboard pane pages.", []string{"/page <next|prev|number>"}, []string{"/page next"}, []string{"pagination", "dashboard"}),
	descriptor(KindPaneColor, "/pane color", "/pane color ", "layout", false, "Change the selected pane color preference.", []string{"/pane color <pane> <color>"}, []string{"/pane color current blue"}, []string{"theme", "accent"}),
	descriptor(KindPin, "/pin", "/pin ", "layout", false, "Pin a pane in the dashboard layout.", []string{"/pin <pane>"}, []string{"/pin current"}, []string{"keep", "layout"}),
	descriptor(KindUsage, "/usage", "/usage", "agent", false, "Show model, token, and cost usage for the last request and active thread.", []string{"/usage"}, []string{"/usage"}, []string{"model", "tokens", "cost", "spend", "credits", "billing"}),
	descriptor(KindSettings, "/settings", "/settings", "settings", false, "Open categorized Relaybase settings, including dedicated Agent security management.", []string{"/settings", "/settings agent", "/settings agent security"}, []string{"/settings agent security"}, []string{"preferences", "agent", "configuration", "credentials", "security", "repair"}),
	descriptor(KindUnpin, "/unpin", "/unpin ", "layout", false, "Unpin a pane from the dashboard layout.", []string{"/unpin <pane>"}, []string{"/unpin current"}, []string{"release", "layout"}),
	descriptor(KindTheme, "/theme", "/theme ", "layout", false, "Choose a built-in TUI color theme.", []string{"/theme <name>"}, themeCommandExamples(), append([]string{"appearance", "color"}, styles.ThemeIDs()...)),
	descriptor(KindHelp, "/help", "/help", "help", false, "Open searchable command help.", []string{"/help"}, []string{"/help"}, []string{"commands", "documentation"}),
	withCompatibilityAliases(descriptor(KindManage, "/manage", "/manage", "inventory", false, "Manage registered apps through daemon-backed actions.", []string{"/manage"}, []string{"/manage"}, []string{"apps", "registered", "saved", "start", "stop", "restart", "unregister"}), "/list"),
	descriptor(KindConfirm, "/confirm", "/confirm", "safety", false, "Confirm the currently pending Relaybase action.", []string{"/confirm"}, []string{"/confirm"}, []string{"approve", "continue"}),
	descriptor(KindCancel, "/cancel", "/cancel", "safety", false, "Cancel the currently pending Relaybase action.", []string{"/cancel"}, []string{"/cancel"}, []string{"reject", "abort"}),
	descriptor(KindDaemonStatus, "/daemon status", "/daemon status", "daemon", false, "Show the current Relaybase daemon connection status.", []string{"/daemon status"}, []string{"/daemon status"}, []string{"offline", "connection"}),
	withAliases(descriptor(KindDaemonRepair, "/daemon repair", "/daemon repair", "daemon", true, "Request a safe daemon repair or reconnect through the launch bridge.", []string{"/daemon repair", "/daemon retry"}, []string{"/daemon repair"}, []string{"reconnect", "fix"}), "/daemon retry"),
	descriptor(KindDaemonRestart, "/daemon restart", "/daemon restart", "daemon", true, "Safely restart the control-plane daemon and restore Relaybase-owned apps.", []string{"/daemon restart"}, []string{"/daemon restart"}, []string{"reboot", "relaunch", "restore"}),
	descriptor(KindCreatePackage, "/create-package", "/create-package ", "packages", false, "Create a durable named package from an ordered list of registered apps.", []string{"/create-package {'Registered App','Other App'} 'package-name'"}, []string{"/create-package {'Notes','Notes API'} 'notes-stack'"}, []string{"bundle", "group", "apps"}),
	descriptor(KindPackages, "/packages", "/packages", "packages", false, "Manage saved app packages, ordered members, and recent runs.", []string{"/packages"}, []string{"/packages"}, []string{"bundle", "saved apps"}),
	descriptor(KindLaunchPackage, "/launch-package", "/launch-package ", "packages", true, "Start every eligible app in a saved package through daemon lifecycle operations.", []string{"/launch-package <package-name>"}, []string{"/launch-package 'notes-stack'"}, []string{"bundle", "start apps"}),
	descriptor(KindDeletePackage, "/delete-package", "/delete-package ", "packages", true, "Delete a saved package definition without stopping its apps.", []string{"/delete-package <package-name>"}, []string{"/delete-package 'notes-stack'"}, []string{"bundle", "remove"}),
	descriptor(KindPackageRunRetry, "/package-run retry", "/package-run retry ", "packages", true, "Retry only failed or interrupted members from a package run.", []string{"/package-run retry <run-id>"}, []string{"/package-run retry pkg_run_123"}, []string{"resume", "failed apps"}),
	descriptor(KindPackageRunAbort, "/package-run abort", "/package-run abort ", "packages", true, "Abort package members that have not yet been enqueued.", []string{"/package-run abort <run-id>"}, []string{"/package-run abort pkg_run_123"}, []string{"cancel", "pending apps"}),
	descriptor(KindThreadList, "/thread list", "/thread list", "agent-thread", false, "List daemon-backed Operator Agent threads.", []string{"/thread list"}, []string{"/thread list"}, []string{"sessions", "chats"}),
	descriptor(KindThreadNew, "/thread new", "/thread new ", "agent-thread", false, "Create a daemon-backed Operator Agent thread.", []string{"/thread new [title]"}, []string{"/thread new release checks"}, []string{"session", "chat"}),
	descriptor(KindThreadSwitch, "/thread switch", "/thread switch ", "agent-thread", false, "Activate an Operator Agent thread by ID or listed number.", []string{"/thread switch <id|number>"}, []string{"/thread switch 1"}, []string{"activate", "session"}),
	descriptor(KindThreadRename, "/thread rename", "/thread rename ", "agent-thread", false, "Rename the active Operator Agent thread.", []string{"/thread rename <title>"}, []string{"/thread rename release checks"}, []string{"title", "session"}),
	descriptor(KindThreadClear, "/thread clear", "/thread clear", "agent-thread", false, "Soft-clear the active Operator Agent thread.", []string{"/thread clear"}, []string{"/thread clear"}, []string{"delete", "session"}),
	descriptor(KindThreadExport, "/thread export", "/thread export ", "agent-thread", false, "Export the active redacted Agent thread as JSON or Markdown.", []string{"/thread export <json|markdown>"}, []string{"/thread export markdown"}, []string{"download", "session"}),
	descriptor(KindThreadPreview, "/thread preview", "/thread preview", "agent-thread", false, "Preview the active Agent thread context and approval counts.", []string{"/thread preview"}, []string{"/thread preview"}, []string{"context", "session"}),
	descriptor(KindAddApp, "/add", "/add ", "setup", true, "Inspect and add a project, optionally with an explicit start command.", []string{"/add <path>", "/add <path> using <command>"}, []string{"/add ./apps/notes using npm run dev"}, []string{"project", "configure"}),
	descriptor(KindRegister, "/register", "/register ", "setup", true, "Register and optionally verify an existing Relaybase manifest or project path.", []string{"/register <manifest-or-project-path> [--no-verify]"}, []string{"/register ./apps/notes/relaybase.app.json", "/register ./apps/notes --no-verify"}, []string{"manifest", "project", "verify"}),
	descriptor(KindConfigure, "/configure", "/configure ", "setup", true, "Detect and preview or apply Relaybase project setup.", []string{"/configure [cwd|current folder|<path>] [--dry-run]"}, []string{"/configure ./apps/notes"}, []string{"project", "setup", "detect"}),
	descriptor(KindOpen, "/open", "/open ", "setup", true, "Open a registered app or project through daemon setup primitives.", []string{"/open <path-or-app>"}, []string{"/open notes"}, []string{"project", "route"}),
	descriptor(KindProve, "/prove", "/prove ", "health", true, "Run daemon-owned health proof for an app.", []string{"/prove <app>"}, []string{"/prove notes"}, []string{"verify", "ready"}),
	descriptor(KindHealthProve, "/health", "/health ", "health", true, "Run the explicit health-proof form for an app.", []string{"/health <app> --prove"}, []string{"/health notes --prove"}, []string{"verify", "ready"}),
	descriptor(KindRepair, "/repair", "/repair ", "setup", false, "Inspect safe repair choices for an app or project path.", []string{"/repair <app-or-path>"}, []string{"/repair notes"}, []string{"fix", "diagnose"}),
	descriptor(KindManifestInspect, "/manifest inspect", "/manifest inspect ", "manifest", false, "Inspect and validate a Relaybase manifest without writing it.", []string{"/manifest inspect <app-or-path>"}, []string{"/manifest inspect notes"}, []string{"validate", "read"}),
	descriptor(KindManifestEdit, "/manifest edit", "/manifest edit ", "manifest", true, "Preview and apply an approved safe manifest-field edit.", []string{"/manifest edit <field> <value>"}, []string{"/manifest edit name Notes"}, []string{"patch", "update"}),
	descriptor(KindHealthRoute, "/health route", "/health route ", "manifest", true, "Preview and apply an app health-route change.", []string{"/health route <app> <route>"}, []string{"/health route notes /health"}, []string{"endpoint", "patch"}),
	descriptor(KindPortPinned, "/port pinned", "/port pinned ", "manifest", true, "Preview and apply a pinned-port change for an app.", []string{"/port pinned <app> <port>"}, []string{"/port pinned notes 4173"}, []string{"network", "patch"}),
	descriptor(KindComponentRole, "/component role", "/component role ", "manifest", true, "Preview and apply an app component-role change.", []string{"/component role <app> <role>"}, []string{"/component role notes frontend"}, []string{"metadata", "patch"}),
	descriptor(KindComponentGroup, "/component group", "/component group ", "manifest", true, "Preview and apply an app component-group change.", []string{"/component group <app> <groupId>"}, []string{"/component group notes workspace"}, []string{"metadata", "patch"}),
	descriptor(KindComponentLabel, "/component label", "/component label ", "manifest", true, "Preview and apply an app component-label change.", []string{"/component label <app> <label>"}, []string{"/component label notes web"}, []string{"metadata", "patch"}),
}

func descriptor(kind, canonical, insertion, category string, approval bool, description string, usages, examples, keywords []string) CommandDescriptor {
	policy := ConfirmationNever
	if approval {
		policy = ConfirmationAlways
	}
	return CommandDescriptor{Kind: kind, Canonical: canonical, Insertion: insertion, Category: category, Approval: approval, ConfirmationPolicy: policy, Description: description, Usages: usages, Examples: examples, Keywords: keywords}
}

func themeCommandExamples() []string {
	themeIDs := styles.ThemeIDs()
	examples := make([]string, 0, len(themeIDs))
	for _, themeID := range themeIDs {
		examples = append(examples, "/theme "+themeID)
	}
	return examples
}

func withConfirmationPolicy(value CommandDescriptor, policy ConfirmationPolicy) CommandDescriptor {
	value.ConfirmationPolicy = policy
	return value
}

func withAliases(value CommandDescriptor, aliases ...string) CommandDescriptor {
	value.Aliases = aliases
	return value
}

func withCompatibilityAliases(value CommandDescriptor, aliases ...string) CommandDescriptor {
	value.CompatibilityAliases = aliases
	return value
}

// Catalog returns a deep copy so callers cannot mutate the shared catalog.
func Catalog() []CommandDescriptor {
	result := make([]CommandDescriptor, len(commandCatalog))
	for index, value := range commandCatalog {
		result[index] = cloneDescriptor(value)
	}
	return result
}

func DescriptorForKind(kind string) (CommandDescriptor, bool) {
	for _, value := range commandCatalog {
		if value.Kind == kind {
			return cloneDescriptor(value), true
		}
	}
	return CommandDescriptor{}, false
}

// IsKnownPrefix reports whether raw begins with a cataloged canonical or alias
// root. It intentionally does not validate arguments.
func IsKnownPrefix(raw string) bool {
	query := normalizeCatalogText(raw)
	if query == "" {
		return false
	}
	for _, value := range commandCatalog {
		candidates := append([]string{value.Canonical}, value.Aliases...)
		candidates = append(candidates, value.CompatibilityAliases...)
		for _, candidate := range candidates {
			candidate = normalizeCatalogText(candidate)
			if query == candidate || strings.HasPrefix(query, candidate+" ") {
				return true
			}
			root := strings.Fields(candidate)
			if len(root) > 0 && (query == root[0] || strings.HasPrefix(query, root[0]+" ")) {
				return true
			}
		}
	}
	return false
}

// SearchCatalog ranks catalog entries using deterministic, dependency-free
// matching. All query tokens must match at least one searchable field.
func SearchCatalog(query string) []CommandMatch {
	normalized := normalizeCatalogText(query)
	if normalized == "" {
		matches := make([]CommandMatch, len(commandCatalog))
		for index, value := range commandCatalog {
			matches[index] = CommandMatch{Descriptor: cloneDescriptor(value)}
		}
		return matches
	}
	tokens := strings.Fields(normalized)
	type ranked struct {
		match CommandMatch
		order int
	}
	rankedMatches := make([]ranked, 0, len(commandCatalog))
	for order, value := range commandCatalog {
		score, ok := descriptorScore(value, normalized, tokens)
		if !ok {
			continue
		}
		rankedMatches = append(rankedMatches, ranked{match: CommandMatch{Descriptor: cloneDescriptor(value), Score: score}, order: order})
	}
	sort.SliceStable(rankedMatches, func(left, right int) bool {
		if rankedMatches[left].match.Score == rankedMatches[right].match.Score {
			return rankedMatches[left].order < rankedMatches[right].order
		}
		return rankedMatches[left].match.Score > rankedMatches[right].match.Score
	})
	result := make([]CommandMatch, len(rankedMatches))
	for index, value := range rankedMatches {
		result[index] = value.match
	}
	return result
}

func descriptorScore(value CommandDescriptor, normalized string, tokens []string) (int, bool) {
	primary := append([]string{value.Canonical}, value.Usages...)
	secondary := append(append([]string{}, value.Aliases...), value.CompatibilityAliases...)
	secondary = append(secondary, value.Keywords...)
	score := 0
	for _, token := range tokens {
		best := bestFieldScore(token, primary, 300)
		best = maxCatalogScore(best, bestFieldScore(token, secondary, 200))
		best = maxCatalogScore(best, bestFieldScore(token, []string{value.Description}, 100))
		if best == 0 {
			return 0, false
		}
		score += best
	}
	canonical := normalizeCatalogText(value.Canonical)
	if canonical == normalized {
		score += 1000
	} else if strings.HasPrefix(canonical, normalized) {
		score += 500
	}
	for _, alias := range value.CompatibilityAliases {
		alias = normalizeCatalogText(alias)
		if alias == normalized {
			score += 1000
		} else if strings.HasPrefix(alias, normalized) {
			score += 700
		}
	}
	return score, true
}

func bestFieldScore(token string, fields []string, weight int) int {
	best := 0
	for _, field := range fields {
		field = normalizeCatalogText(field)
		quality := 0
		switch {
		case field == token:
			quality = 100
		case strings.HasPrefix(field, token):
			quality = 90
		case hasWordPrefix(field, token):
			quality = 80
		case strings.Contains(field, token):
			quality = 70
		case orderedSubsequence(token, field):
			quality = 50
		}
		if quality > 0 {
			best = maxCatalogScore(best, weight+quality)
		}
	}
	return best
}

func hasWordPrefix(value, prefix string) bool {
	for _, word := range strings.FieldsFunc(value, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if strings.HasPrefix(word, prefix) {
			return true
		}
	}
	return false
}

func orderedSubsequence(needle, haystack string) bool {
	needleRunes := []rune(needle)
	if len(needleRunes) == 0 {
		return true
	}
	index := 0
	for _, value := range []rune(haystack) {
		if value == needleRunes[index] {
			index++
			if index == len(needleRunes) {
				return true
			}
		}
	}
	return false
}

func normalizeCatalogText(value string) string {
	value = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), "/"))
	return strings.Join(strings.Fields(strings.ToLower(value)), " ")
}

func cloneDescriptor(value CommandDescriptor) CommandDescriptor {
	value.Usages = append([]string(nil), value.Usages...)
	value.Examples = append([]string(nil), value.Examples...)
	value.Keywords = append([]string(nil), value.Keywords...)
	value.Aliases = append([]string(nil), value.Aliases...)
	value.CompatibilityAliases = append([]string(nil), value.CompatibilityAliases...)
	return value
}

func maxCatalogScore(left, right int) int {
	if left > right {
		return left
	}
	return right
}
