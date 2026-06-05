package slash

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

const (
	KindLaunch       = "launch"
	KindStop         = "stop"
	KindRestart      = "restart"
	KindLogsExport   = "logs_export"
	KindPage         = "page"
	KindPaneColor    = "pane_color"
	KindPin          = "pin"
	KindUnpin        = "unpin"
	KindTheme        = "theme"
	KindHelp         = "help"
	KindConfirm      = "confirm"
	KindCancel       = "cancel"
	KindDaemonStatus = "daemon_status"
	KindDaemonRepair = "daemon_repair"

	KindThreadList    = "thread_list"
	KindThreadNew     = "thread_new"
	KindThreadSwitch  = "thread_switch"
	KindThreadRename  = "thread_rename"
	KindThreadClear   = "thread_clear"
	KindThreadExport  = "thread_export"
	KindThreadPreview = "thread_preview"

	KindAddApp          = "add_app"
	KindRegister        = "register"
	KindConfigure       = "configure"
	KindOpen            = "open"
	KindProve           = "prove"
	KindHealthProve     = "health_prove"
	KindRepair          = "repair"
	KindManifestInspect = "manifest_inspect"
	KindManifestEdit    = "manifest_edit"
	KindHealthRoute     = "health_route"
	KindPortPinned      = "port_pinned"
	KindComponentRole   = "component_role"
	KindComponentGroup  = "component_group"
	KindComponentLabel  = "component_label"
)

const (
	ScopePane  = "pane"
	ScopeApp   = "app"
	ScopeGroup = "group"
	ScopePage  = "page"
	ScopeAll   = "all"
)

type ParsedCommand struct {
	Raw        string
	Kind       string
	Target     string
	Scope      string
	Color      string
	Theme      string
	Page       string
	PageNumber int
	Confirm    bool
	DryRun     bool
	Path       string
	Command    string
	Field      string
	Value      string
	Route      string
	Port       int
	Format     string
}

type ParseError struct {
	Message string
}

func (e ParseError) Error() string {
	return e.Message
}

func Parse(input string) (ParsedCommand, error) {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return ParsedCommand{}, ParseError{Message: "Enter a slash command."}
	}
	if !strings.HasPrefix(raw, "/") {
		return ParsedCommand{}, ParseError{Message: "Slash commands must start with /."}
	}

	content := strings.TrimSpace(strings.TrimPrefix(raw, "/"))
	fields, err := splitCommandFields(content)
	if err != nil {
		return ParsedCommand{}, err
	}
	fields, confirm, dryRun, err := stripCommandFlags(fields)
	if err != nil {
		return ParsedCommand{}, err
	}
	if len(fields) == 0 {
		return ParsedCommand{}, ParseError{Message: "Enter a slash command."}
	}

	command := strings.ToLower(fields[0])
	parsed := ParsedCommand{Raw: raw, Confirm: confirm, DryRun: dryRun}
	args := fields[1:]

	switch command {
	case "add":
		if len(args) == 0 || strings.ToLower(args[0]) != "app" {
			return ParsedCommand{}, ParseError{Message: "Use /add app or /add app <path> using <command>."}
		}
		pathValue, commandValue, err := parseAddAppArgs(args[1:])
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindAddApp
		parsed.Path = pathValue
		parsed.Command = commandValue
	case "launch":
		if err := rejectUnexpectedFlags(args, "/launch <app|group|role>"); err != nil {
			return ParsedCommand{}, err
		}
		target, err := requiredTarget(args, "/launch <app|group|role>")
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindLaunch
		parsed.Target = target
	case "stop":
		if err := rejectUnexpectedFlags(args, "/stop <app|group|role>"); err != nil {
			return ParsedCommand{}, err
		}
		target, err := requiredTarget(args, "/stop <app|group|role>")
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindStop
		parsed.Target = target
	case "restart":
		if err := rejectUnexpectedFlags(args, "/restart <app|group|role>"); err != nil {
			return ParsedCommand{}, err
		}
		target, err := requiredTarget(args, "/restart <app|group|role>")
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindRestart
		parsed.Target = target
	case "logs":
		if len(args) < 2 || strings.ToLower(args[0]) != "export" {
			return ParsedCommand{}, ParseError{Message: "Use /logs export <pane|app|group|page|all>."}
		}
		if err := rejectUnexpectedFlags(args[2:], "/logs export <pane|app|group|page|all>"); err != nil {
			return ParsedCommand{}, err
		}
		scope := strings.ToLower(args[1])
		if !validExportScope(scope) {
			return ParsedCommand{}, ParseError{Message: "Log export scope must be pane, app, group, page, or all."}
		}
		if (scope == ScopeAll || scope == ScopePage) && len(args) > 2 {
			return ParsedCommand{}, ParseError{Message: "Use /logs export " + scope + "."}
		}
		parsed.Kind = KindLogsExport
		parsed.Scope = scope
		parsed.Target = strings.Join(args[2:], " ")
	case "page":
		if err := rejectUnexpectedFlags(args, "/page <next|prev|number>"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) != 1 {
			return ParsedCommand{}, ParseError{Message: "Use /page <next|prev|number>."}
		}
		page := strings.ToLower(args[0])
		parsed.Kind = KindPage
		parsed.Page = page
		if page != "next" && page != "prev" {
			number, err := strconv.Atoi(page)
			if err != nil || number < 1 {
				return ParsedCommand{}, ParseError{Message: "Page must be next, prev, or a positive page number."}
			}
			parsed.PageNumber = number
		}
	case "pane":
		if err := rejectUnexpectedFlags(args, "/pane color <pane> <color>"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) < 3 || strings.ToLower(args[0]) != "color" {
			return ParsedCommand{}, ParseError{Message: "Use /pane color <pane> <color>."}
		}
		parsed.Kind = KindPaneColor
		parsed.Target = strings.Join(args[1:len(args)-1], " ")
		parsed.Color = args[len(args)-1]
	case "pin":
		if err := rejectUnexpectedFlags(args, "/pin <pane>"); err != nil {
			return ParsedCommand{}, err
		}
		target, err := requiredTarget(args, "/pin <pane>")
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindPin
		parsed.Target = target
	case "unpin":
		if err := rejectUnexpectedFlags(args, "/unpin <pane>"); err != nil {
			return ParsedCommand{}, err
		}
		target, err := requiredTarget(args, "/unpin <pane>")
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindUnpin
		parsed.Target = target
	case "theme":
		if err := rejectUnexpectedFlags(args, "/theme <light|dark|auto>"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) != 1 {
			return ParsedCommand{}, ParseError{Message: "Use /theme <light|dark|auto>."}
		}
		theme := strings.ToLower(args[0])
		if theme != "light" && theme != "dark" && theme != "auto" {
			return ParsedCommand{}, ParseError{Message: "Theme must be light, dark, or auto."}
		}
		parsed.Kind = KindTheme
		parsed.Theme = theme
	case "help":
		if err := rejectUnexpectedFlags(args, "/help"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) != 0 {
			return ParsedCommand{}, ParseError{Message: "Use /help."}
		}
		parsed.Kind = KindHelp
	case "confirm":
		if err := rejectUnexpectedFlags(args, "/confirm"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) != 0 {
			return ParsedCommand{}, ParseError{Message: "Use /confirm."}
		}
		parsed.Kind = KindConfirm
	case "cancel":
		if err := rejectUnexpectedFlags(args, "/cancel"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) != 0 {
			return ParsedCommand{}, ParseError{Message: "Use /cancel."}
		}
		parsed.Kind = KindCancel
	case "daemon":
		if err := rejectUnexpectedFlags(args, "/daemon <status|repair|retry>"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) != 1 {
			return ParsedCommand{}, ParseError{Message: "Use /daemon <status|repair|retry>."}
		}
		switch strings.ToLower(args[0]) {
		case "status":
			parsed.Kind = KindDaemonStatus
		case "repair", "retry":
			parsed.Kind = KindDaemonRepair
		default:
			return ParsedCommand{}, ParseError{Message: "Use /daemon <status|repair|retry>."}
		}
	case "thread":
		if len(args) == 0 {
			return ParsedCommand{}, ParseError{Message: "Use /thread <list|new|switch|rename|clear|export|preview>."}
		}
		switch strings.ToLower(args[0]) {
		case "list":
			if err := rejectUnexpectedFlags(args[1:], "/thread list"); err != nil {
				return ParsedCommand{}, err
			}
			if len(args) != 1 {
				return ParsedCommand{}, ParseError{Message: "Use /thread list."}
			}
			parsed.Kind = KindThreadList
		case "new":
			parsed.Kind = KindThreadNew
			parsed.Value = strings.TrimSpace(strings.Join(args[1:], " "))
		case "switch":
			if err := rejectUnexpectedFlags(args[1:], "/thread switch <id|number>"); err != nil {
				return ParsedCommand{}, err
			}
			target, err := requiredTarget(args[1:], "/thread switch <id|number>")
			if err != nil {
				return ParsedCommand{}, err
			}
			parsed.Kind = KindThreadSwitch
			parsed.Target = target
		case "rename":
			title, err := requiredTarget(args[1:], "/thread rename <title>")
			if err != nil {
				return ParsedCommand{}, err
			}
			parsed.Kind = KindThreadRename
			parsed.Value = title
		case "clear":
			if err := rejectUnexpectedFlags(args[1:], "/thread clear"); err != nil {
				return ParsedCommand{}, err
			}
			if len(args) != 1 {
				return ParsedCommand{}, ParseError{Message: "Use /thread clear."}
			}
			parsed.Kind = KindThreadClear
		case "export":
			if err := rejectUnexpectedFlags(args[1:], "/thread export <json|markdown>"); err != nil {
				return ParsedCommand{}, err
			}
			if len(args) != 2 || (strings.ToLower(args[1]) != "json" && strings.ToLower(args[1]) != "markdown") {
				return ParsedCommand{}, ParseError{Message: "Use /thread export <json|markdown>."}
			}
			parsed.Kind = KindThreadExport
			parsed.Format = strings.ToLower(args[1])
		case "preview":
			if err := rejectUnexpectedFlags(args[1:], "/thread preview"); err != nil {
				return ParsedCommand{}, err
			}
			if len(args) != 1 {
				return ParsedCommand{}, ParseError{Message: "Use /thread preview."}
			}
			parsed.Kind = KindThreadPreview
		default:
			return ParsedCommand{}, ParseError{Message: "Use /thread <list|new|switch|rename|clear|export|preview>."}
		}
	case "register":
		if err := rejectUnexpectedFlags(args, "/register <manifest-path>"); err != nil {
			return ParsedCommand{}, err
		}
		target, err := requiredTarget(args, "/register <manifest-path>")
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindRegister
		parsed.Path = target
	case "configure":
		if err := rejectUnexpectedFlags(args, "/configure [cwd|current folder|<path>] [--dry-run]"); err != nil {
			return ParsedCommand{}, err
		}
		pathValue, err := parseConfigureArgs(args)
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindConfigure
		parsed.Path = pathValue
	case "open":
		if err := rejectUnexpectedFlags(args, "/open <path-or-app>"); err != nil {
			return ParsedCommand{}, err
		}
		target, err := requiredTarget(args, "/open <path-or-app>")
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindOpen
		parsed.Target = target
		parsed.Path = target
	case "prove":
		if err := rejectUnexpectedFlags(args, "/prove <app>"); err != nil {
			return ParsedCommand{}, err
		}
		target, err := requiredTarget(args, "/prove <app>")
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindProve
		parsed.Target = target
	case "health":
		if len(args) >= 1 && strings.ToLower(args[0]) == "route" {
			if err := rejectUnexpectedFlags(args[1:], "/health route <app> <route>"); err != nil {
				return ParsedCommand{}, err
			}
			if len(args) < 3 {
				return ParsedCommand{}, ParseError{Message: "Use /health route <app> <route>."}
			}
			parsed.Kind = KindHealthRoute
			parsed.Target = args[1]
			parsed.Route = strings.Join(args[2:], " ")
			break
		}
		if err := rejectUnexpectedFlags(args, "/health <app> --prove", "--prove"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) < 2 || !containsFlag(args, "--prove") {
			return ParsedCommand{}, ParseError{Message: "Use /health <app> --prove or /health route <app> <route>."}
		}
		target := strings.Join(removeFlag(args, "--prove"), " ")
		target = strings.TrimSpace(target)
		if target == "" {
			return ParsedCommand{}, ParseError{Message: "Use /health <app> --prove."}
		}
		parsed.Kind = KindHealthProve
		parsed.Target = target
	case "repair":
		if err := rejectUnexpectedFlags(args, "/repair <app-or-path>"); err != nil {
			return ParsedCommand{}, err
		}
		target, err := requiredTarget(args, "/repair <app-or-path>")
		if err != nil {
			return ParsedCommand{}, err
		}
		parsed.Kind = KindRepair
		parsed.Target = target
		parsed.Path = target
	case "manifest":
		if len(args) == 0 {
			return ParsedCommand{}, ParseError{Message: "Use /manifest inspect <app-or-path> or /manifest edit <field> <value>."}
		}
		switch strings.ToLower(args[0]) {
		case "inspect":
			if err := rejectUnexpectedFlags(args[1:], "/manifest inspect <app-or-path>"); err != nil {
				return ParsedCommand{}, err
			}
			if len(args) < 2 {
				return ParsedCommand{}, ParseError{Message: "Use /manifest inspect <app-or-path>."}
			}
			parsed.Kind = KindManifestInspect
			parsed.Target = strings.Join(args[1:], " ")
			parsed.Path = parsed.Target
		case "edit":
			if err := rejectUnexpectedFlags(args[1:], "/manifest edit <field> <value>"); err != nil {
				return ParsedCommand{}, err
			}
			if len(args) < 3 {
				return ParsedCommand{}, ParseError{Message: "Use /manifest edit <field> <value>."}
			}
			parsed.Kind = KindManifestEdit
			parsed.Field = args[1]
			parsed.Value = strings.Join(args[2:], " ")
		default:
			return ParsedCommand{}, ParseError{Message: "Use /manifest inspect <app-or-path> or /manifest edit <field> <value>."}
		}
	case "port":
		if err := rejectUnexpectedFlags(args, "/port pinned <app> <port>"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) != 3 || strings.ToLower(args[0]) != "pinned" {
			return ParsedCommand{}, ParseError{Message: "Use /port pinned <app> <port>."}
		}
		port, err := strconv.Atoi(args[2])
		if err != nil || port <= 0 || port > 65535 {
			return ParsedCommand{}, ParseError{Message: "Pinned port must be a number from 1 to 65535."}
		}
		parsed.Kind = KindPortPinned
		parsed.Target = args[1]
		parsed.Port = port
	case "component":
		if err := rejectUnexpectedFlags(args, "/component <role|group|label> <app> <value>"); err != nil {
			return ParsedCommand{}, err
		}
		if len(args) < 3 {
			return ParsedCommand{}, ParseError{Message: "Use /component role <app> <role>, /component group <app> <groupId>, or /component label <app> <label>."}
		}
		parsed.Target = args[1]
		parsed.Value = strings.Join(args[2:], " ")
		switch strings.ToLower(args[0]) {
		case "role":
			if !roleTarget(parsed.Value) {
				return ParsedCommand{}, ParseError{Message: "Component role must be frontend, backend, worker, database, service, or other."}
			}
			parsed.Kind = KindComponentRole
		case "group":
			parsed.Kind = KindComponentGroup
		case "label":
			parsed.Kind = KindComponentLabel
		default:
			return ParsedCommand{}, ParseError{Message: "Use /component role <app> <role>, /component group <app> <groupId>, or /component label <app> <label>."}
		}
	default:
		return ParsedCommand{}, ParseError{Message: fmt.Sprintf("Unknown slash command %q. Use /help.", command)}
	}

	return parsed, nil
}

func RequiresConfirmation(command ParsedCommand) bool {
	switch command.Kind {
	case KindLaunch, KindStop, KindRestart, KindLogsExport,
		KindAddApp, KindRegister, KindConfigure, KindOpen, KindProve, KindHealthProve,
		KindManifestEdit, KindHealthRoute, KindPortPinned, KindComponentRole, KindComponentGroup, KindComponentLabel,
		KindDaemonRepair:
		if command.Kind == KindConfigure && command.DryRun {
			return false
		}
		return true
	default:
		return false
	}
}

type PaneRef struct {
	ID          string
	AppID       string
	GroupID     string
	Role        string
	Title       string
	DisplayName string
}

type ResolutionContext struct {
	State        *relaybaseclient.RelaybaseState
	SelectedPane PaneRef
	PagePanes    []PaneRef
}

type ResolvedTarget struct {
	Description   string
	AppIDs        []string
	GroupID       string
	PaneID        string
	PaneIDs       []string
	ComponentRole string
	Scope         string
}

type ResolutionError struct {
	Kind    string
	Message string
	Options []string
}

func (e ResolutionError) Error() string {
	if len(e.Options) == 0 {
		return e.Message
	}
	return e.Message + " Options: " + strings.Join(e.Options, ", ")
}

func ResolveLifecycleTarget(ctx ResolutionContext, target string) (ResolvedTarget, error) {
	normalizedTarget := cleanTarget(target)
	if normalizedTarget == "" || normalizedTarget == "current" || normalizedTarget == "selected" || normalizedTarget == "pane" {
		if ctx.SelectedPane.AppID == "" {
			return ResolvedTarget{}, ResolutionError{Kind: "unknown", Message: "No selected pane is available for the lifecycle command."}
		}
		return ResolvedTarget{
			Description:   describePane(ctx.SelectedPane),
			AppIDs:        []string{ctx.SelectedPane.AppID},
			GroupID:       ctx.SelectedPane.GroupID,
			PaneID:        ctx.SelectedPane.ID,
			ComponentRole: ctx.SelectedPane.Role,
		}, nil
	}

	candidates := map[string]ResolvedTarget{}
	addCandidate := func(candidate ResolvedTarget) {
		candidate.AppIDs = uniqueSorted(candidate.AppIDs)
		key := strings.Join(candidate.AppIDs, ",")
		if key == "" {
			key = candidate.GroupID + "|" + candidate.PaneID + "|" + candidate.ComponentRole
		}
		if key != "||" && key != "" {
			candidates[key] = candidate
		}
	}

	state := ctx.State
	if groupedRole, ok := resolveGroupRoleTarget(state, normalizedTarget); ok {
		return groupedRole, nil
	}
	if state != nil {
		directCandidates := map[string]ResolvedTarget{}
		for _, app := range state.Apps {
			if normalize(app.ID) == normalizedTarget || normalize(app.Name) == normalizedTarget {
				name := firstNonEmpty(app.Name, app.ID)
				directCandidates["app:"+app.ID] = ResolvedTarget{Description: "app " + name, AppIDs: []string{app.ID}}
			}
		}
		for _, group := range state.Groups {
			if normalize(group.GroupID) == normalizedTarget || normalize(group.DisplayName) == normalizedTarget {
				appIDs := groupAppIDs(group, state)
				directCandidates["group:"+group.GroupID] = ResolvedTarget{
					Description: "group " + firstNonEmpty(group.DisplayName, group.GroupID),
					AppIDs:      appIDs,
					GroupID:     group.GroupID,
				}
			}
		}
		if len(directCandidates) > 0 {
			return singleCandidate(directCandidates, target)
		}
	}

	if pagePane, ok, err := resolvePagePaneNumber(ctx, normalizedTarget); ok || err != nil {
		return pagePane, err
	}

	if state != nil {
		for _, component := range componentsFromState(state) {
			if normalize(component.AppID) == normalizedTarget || normalize(component.DisplayName) == normalizedTarget {
				name := firstNonEmpty(component.DisplayName, component.AppID)
				addCandidate(ResolvedTarget{
					Description:   "component " + name,
					AppIDs:        []string{component.AppID},
					GroupID:       component.GroupID,
					ComponentRole: component.Role,
				})
			}
		}
	}

	if ctx.SelectedPane.GroupID != "" {
		roleMatches := []relaybaseclient.AppComponent{}
		for _, component := range componentsFromState(state) {
			if component.GroupID != ctx.SelectedPane.GroupID {
				continue
			}
			if normalize(component.Role) == normalizedTarget || normalize(component.PaneLabel) == normalizedTarget {
				roleMatches = append(roleMatches, component)
			}
		}
		if len(roleMatches) > 0 {
			appIDs := []string{}
			for _, component := range roleMatches {
				appIDs = append(appIDs, component.AppID)
			}
			addCandidate(ResolvedTarget{
				Description:   fmt.Sprintf("role %s in group %s", target, ctx.SelectedPane.GroupID),
				AppIDs:        appIDs,
				GroupID:       ctx.SelectedPane.GroupID,
				ComponentRole: roleMatches[0].Role,
			})
		}
	} else if roleTarget(normalizedTarget) {
		roleMatches := []relaybaseclient.AppComponent{}
		for _, component := range componentsFromState(state) {
			if normalize(component.Role) == normalizedTarget || normalize(component.PaneLabel) == normalizedTarget {
				roleMatches = append(roleMatches, component)
			}
		}
		if len(roleMatches) == 1 {
			component := roleMatches[0]
			addCandidate(ResolvedTarget{
				Description:   fmt.Sprintf("role %s in group %s", target, component.GroupID),
				AppIDs:        []string{component.AppID},
				GroupID:       component.GroupID,
				ComponentRole: component.Role,
			})
		}
		if len(roleMatches) > 1 {
			options := []string{}
			for _, component := range roleMatches {
				options = append(options, fmt.Sprintf("%s/%s/%s", component.GroupID, component.AppID, component.Role))
			}
			sort.Strings(options)
			return ResolvedTarget{}, ResolutionError{
				Kind:    "ambiguous",
				Message: fmt.Sprintf("Role target %q is ambiguous without a selected group. Select a pane in the intended group or use <group> %s.", target, normalizedTarget),
				Options: options,
			}
		}
	}

	return singleCandidate(candidates, target)
}

func ResolvePaneTarget(ctx ResolutionContext, target string) (ResolvedTarget, error) {
	normalizedTarget := cleanTarget(target)
	if normalizedTarget == "" || normalizedTarget == "current" || normalizedTarget == "selected" || normalizedTarget == "pane" {
		if ctx.SelectedPane.ID == "" {
			return ResolvedTarget{}, ResolutionError{Kind: "unknown", Message: "No selected pane is available."}
		}
		return paneTarget(ctx.SelectedPane), nil
	}

	if pagePane, ok, err := resolvePagePaneNumber(ctx, normalizedTarget); ok || err != nil {
		return pagePane, err
	}

	if ctx.SelectedPane.GroupID != "" && roleTarget(normalizedTarget) {
		groupRoleMatches := map[string]ResolvedTarget{}
		for _, pane := range paneCandidates(ctx) {
			if pane.GroupID == ctx.SelectedPane.GroupID && normalize(pane.Role) == normalizedTarget {
				groupRoleMatches[pane.ID] = paneTarget(pane)
			}
		}
		if len(groupRoleMatches) > 0 {
			return singleCandidate(groupRoleMatches, target)
		}
	}

	candidates := map[string]ResolvedTarget{}
	for _, pane := range paneCandidates(ctx) {
		if normalize(pane.ID) == normalizedTarget ||
			normalize(pane.Title) == normalizedTarget ||
			normalize(pane.DisplayName) == normalizedTarget ||
			normalize(pane.AppID) == normalizedTarget ||
			normalize(pane.Role) == normalizedTarget {
			candidates[pane.ID] = paneTarget(pane)
		}
	}
	return singleCandidate(candidates, target)
}

func ResolveExportTarget(ctx ResolutionContext, command ParsedCommand) (ResolvedTarget, error) {
	switch command.Scope {
	case ScopeAll:
		return ResolvedTarget{Description: "all logs", Scope: ScopeAll}, nil
	case ScopePage:
		paneIDs := []string{}
		appIDs := []string{}
		for _, pane := range ctx.PagePanes {
			if pane.ID != "" {
				paneIDs = append(paneIDs, pane.ID)
			}
			if pane.AppID != "" {
				appIDs = append(appIDs, pane.AppID)
			}
		}
		if len(paneIDs) == 0 {
			return ResolvedTarget{}, ResolutionError{Kind: "unknown", Message: "No panes are visible on the current page."}
		}
		return ResolvedTarget{
			Description: "current page logs",
			Scope:       ScopePage,
			PaneIDs:     uniqueSorted(paneIDs),
			AppIDs:      uniqueSorted(appIDs),
		}, nil
	case ScopePane:
		target, err := ResolvePaneTarget(ctx, command.Target)
		target.Scope = ScopePane
		return target, err
	case ScopeApp:
		if strings.TrimSpace(command.Target) == "" {
			if ctx.SelectedPane.AppID == "" {
				return ResolvedTarget{}, ResolutionError{Kind: "unknown", Message: "No selected pane can provide an app target."}
			}
			return ResolvedTarget{
				Description: "app " + ctx.SelectedPane.AppID,
				Scope:       ScopeApp,
				AppIDs:      []string{ctx.SelectedPane.AppID},
				GroupID:     ctx.SelectedPane.GroupID,
			}, nil
		}
		target, err := ResolveLifecycleTarget(ctx, command.Target)
		if err != nil {
			return ResolvedTarget{}, err
		}
		if len(target.AppIDs) != 1 {
			return ResolvedTarget{}, ResolutionError{Kind: "ambiguous", Message: "App log export requires one app target.", Options: target.AppIDs}
		}
		target.Scope = ScopeApp
		return target, nil
	case ScopeGroup:
		if strings.TrimSpace(command.Target) == "" {
			if ctx.SelectedPane.GroupID == "" {
				return ResolvedTarget{}, ResolutionError{Kind: "unknown", Message: "No selected pane can provide a group target."}
			}
			return ResolvedTarget{
				Description: "group " + ctx.SelectedPane.GroupID,
				Scope:       ScopeGroup,
				GroupID:     ctx.SelectedPane.GroupID,
			}, nil
		}
		return ResolveGroupTarget(ctx, command.Target)
	default:
		return ResolvedTarget{}, ResolutionError{Kind: "unknown", Message: "Unknown log export scope."}
	}
}

func ResolveGroupTarget(ctx ResolutionContext, target string) (ResolvedTarget, error) {
	normalizedTarget := normalize(target)
	candidates := map[string]ResolvedTarget{}
	if ctx.State != nil {
		for _, group := range ctx.State.Groups {
			if normalize(group.GroupID) == normalizedTarget || normalize(group.DisplayName) == normalizedTarget {
				candidates[group.GroupID] = ResolvedTarget{
					Description: "group " + firstNonEmpty(group.DisplayName, group.GroupID),
					Scope:       ScopeGroup,
					GroupID:     group.GroupID,
					AppIDs:      groupAppIDs(group, ctx.State),
				}
			}
		}
	}
	resolved, err := singleCandidate(candidates, target)
	if err != nil {
		return ResolvedTarget{}, err
	}
	resolved.Scope = ScopeGroup
	return resolved, nil
}

func resolvePagePaneNumber(ctx ResolutionContext, normalizedTarget string) (ResolvedTarget, bool, error) {
	number, err := strconv.Atoi(normalizedTarget)
	if err != nil {
		return ResolvedTarget{}, false, nil
	}
	if number < 1 {
		return ResolvedTarget{}, true, ResolutionError{Kind: "unknown", Message: fmt.Sprintf("Pane number %d is not valid. Use a positive visible pane number.", number)}
	}
	if number > len(ctx.PagePanes) {
		return ResolvedTarget{}, true, ResolutionError{Kind: "unknown", Message: fmt.Sprintf("No pane %d is visible on the current page.", number)}
	}
	pane := ctx.PagePanes[number-1]
	if pane.ID == "" {
		return ResolvedTarget{}, true, ResolutionError{Kind: "unknown", Message: fmt.Sprintf("No pane %d is visible on the current page.", number)}
	}
	return paneTarget(pane), true, nil
}

func splitCommandFields(input string) ([]string, error) {
	fields := []string{}
	var builder strings.Builder
	var quote rune
	tokenStarted := false
	runes := []rune(input)
	for index := 0; index < len(runes); index++ {
		value := runes[index]
		if quote != 0 {
			if value == quote {
				quote = 0
				continue
			}
			if value == '\\' && quote == '"' && index+1 < len(runes) && (runes[index+1] == '"' || runes[index+1] == '\\') {
				index++
				builder.WriteRune(runes[index])
				continue
			}
			builder.WriteRune(value)
			continue
		}
		if value == '"' || value == '\'' {
			quote = value
			tokenStarted = true
			continue
		}
		if unicode.IsSpace(value) {
			if tokenStarted {
				fields = append(fields, builder.String())
				builder.Reset()
				tokenStarted = false
			}
			continue
		}
		builder.WriteRune(value)
		tokenStarted = true
	}
	if quote != 0 {
		return nil, ParseError{Message: "Close the quoted argument before submitting the slash command."}
	}
	if tokenStarted {
		fields = append(fields, builder.String())
	}
	return fields, nil
}

func stripCommandFlags(fields []string) ([]string, bool, bool, error) {
	filtered := []string{}
	confirm := false
	dryRun := false
	for _, field := range fields {
		switch canonicalGlobalFlag(field) {
		case "confirm":
			if confirm {
				return nil, false, false, ParseError{Message: "Flag --confirm was provided more than once."}
			}
			confirm = true
		case "dry-run":
			if dryRun {
				return nil, false, false, ParseError{Message: "Flag --dry-run was provided more than once."}
			}
			dryRun = true
		default:
			filtered = append(filtered, field)
		}
	}
	return filtered, confirm, dryRun, nil
}

func canonicalGlobalFlag(field string) string {
	switch strings.ToLower(field) {
	case "--confirm", "confirm=true":
		return "confirm"
	case "--dry-run", "--dryrun", "dryrun=true", "dry-run=true":
		return "dry-run"
	default:
		return ""
	}
}

func parseAddAppArgs(args []string) (string, string, error) {
	if len(args) == 0 {
		return "", "", nil
	}
	delimiterIndex := -1
	for index, arg := range args {
		lower := strings.ToLower(arg)
		if lower == "using" || lower == "--command" {
			delimiterIndex = index
			break
		}
	}
	pathArgs := args
	commandArgs := []string{}
	if delimiterIndex >= 0 {
		pathArgs = args[:delimiterIndex]
		commandArgs = args[delimiterIndex+1:]
		if len(commandArgs) == 0 {
			return "", "", ParseError{Message: "Use /add app <path> using <command>."}
		}
	}
	if err := rejectUnexpectedFlags(pathArgs, "/add app <path> using <command>"); err != nil {
		return "", "", err
	}
	return strings.TrimSpace(strings.Join(pathArgs, " ")), strings.TrimSpace(strings.Join(commandArgs, " ")), nil
}

func parseConfigureArgs(args []string) (string, error) {
	if len(args) == 0 {
		return "current", nil
	}
	joined := strings.ToLower(strings.Join(args, " "))
	switch joined {
	case "cwd", "current", "current folder", "current directory", ".":
		return "current", nil
	default:
		return strings.Join(args, " "), nil
	}
}

func containsFlag(args []string, flag string) bool {
	for _, arg := range args {
		if strings.ToLower(arg) == flag {
			return true
		}
	}
	return false
}

func removeFlag(args []string, flag string) []string {
	filtered := []string{}
	for _, arg := range args {
		if strings.ToLower(arg) == flag {
			continue
		}
		filtered = append(filtered, arg)
	}
	return filtered
}

func requiredTarget(args []string, usage string) (string, error) {
	target := strings.TrimSpace(strings.Join(args, " "))
	if target == "" {
		return "", ParseError{Message: "Use " + usage + "."}
	}
	return target, nil
}

func rejectUnexpectedFlags(args []string, usage string, allowed ...string) error {
	allowedSet := map[string]bool{}
	seenAllowed := map[string]bool{}
	for _, flag := range allowed {
		allowedSet[strings.ToLower(flag)] = true
	}
	for _, arg := range args {
		lower := strings.ToLower(arg)
		if allowedSet[lower] {
			if seenAllowed[lower] {
				return ParseError{Message: fmt.Sprintf("Flag %s was provided more than once.", lower)}
			}
			seenAllowed[lower] = true
			continue
		}
		if looksLikeFlag(arg) {
			return ParseError{Message: fmt.Sprintf("Unknown flag %q. Use %s.", arg, usage)}
		}
	}
	return nil
}

func looksLikeFlag(arg string) bool {
	lower := strings.ToLower(strings.TrimSpace(arg))
	if strings.HasPrefix(lower, "--") {
		return true
	}
	return strings.HasSuffix(lower, "=true") || strings.HasSuffix(lower, "=false")
}

func validExportScope(scope string) bool {
	switch scope {
	case ScopePane, ScopeApp, ScopeGroup, ScopePage, ScopeAll:
		return true
	default:
		return false
	}
}

func singleCandidate(candidates map[string]ResolvedTarget, rawTarget string) (ResolvedTarget, error) {
	if len(candidates) == 0 {
		return ResolvedTarget{}, ResolutionError{
			Kind:    "unknown",
			Message: fmt.Sprintf("Unknown target %q. Use an exact app id, display name, group id/name, current pane, or a role in the current selected group.", rawTarget),
		}
	}
	if len(candidates) > 1 {
		options := []string{}
		for _, candidate := range candidates {
			options = append(options, candidate.Description)
		}
		sort.Strings(options)
		return ResolvedTarget{}, ResolutionError{
			Kind:    "ambiguous",
			Message: fmt.Sprintf("Target %q is ambiguous. Choose a more specific app id, group id, or pane id.", rawTarget),
			Options: options,
		}
	}
	for _, candidate := range candidates {
		return candidate, nil
	}
	return ResolvedTarget{}, ResolutionError{Kind: "unknown", Message: "Unknown target."}
}

func paneTarget(pane PaneRef) ResolvedTarget {
	return ResolvedTarget{
		Description:   describePane(pane),
		AppIDs:        []string{pane.AppID},
		GroupID:       pane.GroupID,
		PaneID:        pane.ID,
		PaneIDs:       []string{pane.ID},
		ComponentRole: pane.Role,
	}
}

func paneCandidates(ctx ResolutionContext) []PaneRef {
	candidates := []PaneRef{}
	seen := map[string]bool{}
	if ctx.SelectedPane.ID != "" {
		candidates = append(candidates, ctx.SelectedPane)
		seen[ctx.SelectedPane.ID] = true
	}
	for _, pane := range ctx.PagePanes {
		if pane.ID == "" || seen[pane.ID] {
			continue
		}
		candidates = append(candidates, pane)
		seen[pane.ID] = true
	}
	return candidates
}

func componentsFromState(state *relaybaseclient.RelaybaseState) []relaybaseclient.AppComponent {
	if state == nil {
		return nil
	}
	if len(state.Components) > 0 {
		return state.Components
	}
	components := []relaybaseclient.AppComponent{}
	for _, group := range state.Groups {
		components = append(components, group.Components...)
	}
	return components
}

func groupAppIDs(group relaybaseclient.AppGroup, state *relaybaseclient.RelaybaseState) []string {
	appIDs := []string{}
	for _, component := range group.Components {
		if component.AppID != "" {
			appIDs = append(appIDs, component.AppID)
		}
	}
	if len(appIDs) == 0 && state != nil {
		for _, component := range state.Components {
			if component.GroupID == group.GroupID && component.AppID != "" {
				appIDs = append(appIDs, component.AppID)
			}
		}
	}
	if len(appIDs) == 0 && group.GroupID != "" {
		appIDs = append(appIDs, group.GroupID)
	}
	return uniqueSorted(appIDs)
}

func describePane(pane PaneRef) string {
	return "pane " + firstNonEmpty(pane.Title, pane.ID, pane.AppID)
}

func normalize(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func cleanTarget(value string) string {
	normalized := normalize(value)
	for _, prefix := range []string{"the ", "this ", "current "} {
		if strings.HasPrefix(normalized, prefix) {
			normalized = strings.TrimSpace(strings.TrimPrefix(normalized, prefix))
		}
	}
	return normalized
}

func resolveGroupRoleTarget(state *relaybaseclient.RelaybaseState, normalizedTarget string) (ResolvedTarget, bool) {
	parts := strings.Fields(normalizedTarget)
	if len(parts) < 2 || state == nil {
		return ResolvedTarget{}, false
	}
	role := parts[len(parts)-1]
	if !roleTarget(role) {
		return ResolvedTarget{}, false
	}
	groupTarget := strings.Join(parts[:len(parts)-1], " ")
	groupID := ""
	groupName := ""
	for _, group := range state.Groups {
		if normalize(group.GroupID) == groupTarget || normalize(group.DisplayName) == groupTarget {
			groupID = group.GroupID
			groupName = firstNonEmpty(group.DisplayName, group.GroupID)
			break
		}
	}
	if groupID == "" {
		return ResolvedTarget{}, false
	}
	appIDs := []string{}
	for _, component := range componentsFromState(state) {
		if component.GroupID == groupID && (normalize(component.Role) == role || normalize(component.PaneLabel) == role) {
			appIDs = append(appIDs, component.AppID)
		}
	}
	if len(appIDs) == 0 {
		return ResolvedTarget{}, false
	}
	return ResolvedTarget{
		Description:   fmt.Sprintf("role %s in group %s", role, groupName),
		AppIDs:        uniqueSorted(appIDs),
		GroupID:       groupID,
		ComponentRole: role,
	}, true
}

func roleTarget(value string) bool {
	switch normalize(value) {
	case "frontend", "backend", "worker", "database", "service", "other":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func uniqueSorted(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		result = append(result, trimmed)
	}
	sort.Strings(result)
	return result
}
