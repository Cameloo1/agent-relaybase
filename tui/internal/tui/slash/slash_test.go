package slash

import (
	"errors"
	"strings"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

func TestParseSlashCommands(t *testing.T) {
	tests := []struct {
		name   string
		input  string
		kind   string
		target string
		scope  string
	}{
		{name: "launch", input: "/launch api", kind: KindLaunch, target: "api"},
		{name: "stop", input: "/stop api --confirm", kind: KindStop, target: "api"},
		{name: "restart", input: "/restart backend", kind: KindRestart, target: "backend"},
		{name: "logs export", input: "/logs export pane", kind: KindLogsExport, scope: ScopePane},
		{name: "page next", input: "/page next", kind: KindPage},
		{name: "pane color", input: "/pane color current #123456", kind: KindPaneColor, target: "current"},
		{name: "pin", input: "/pin current", kind: KindPin, target: "current"},
		{name: "unpin", input: "/unpin current", kind: KindUnpin, target: "current"},
		{name: "theme", input: "/theme dark", kind: KindTheme},
		{name: "help", input: "/help", kind: KindHelp},
		{name: "confirm", input: "/confirm", kind: KindConfirm},
		{name: "cancel", input: "/cancel", kind: KindCancel},
		{name: "daemon status", input: "/daemon status", kind: KindDaemonStatus},
		{name: "daemon repair", input: "/daemon repair", kind: KindDaemonRepair},
		{name: "thread list", input: "/thread list", kind: KindThreadList},
		{name: "thread new", input: "/thread new Setup notes", kind: KindThreadNew},
		{name: "thread switch", input: "/thread switch 2", kind: KindThreadSwitch, target: "2"},
		{name: "thread rename", input: "/thread rename My thread", kind: KindThreadRename},
		{name: "thread clear", input: "/thread clear", kind: KindThreadClear},
		{name: "thread export", input: "/thread export markdown", kind: KindThreadExport},
		{name: "thread preview", input: "/thread preview", kind: KindThreadPreview},
		{name: "add app", input: "/add app C:/project using npm run dev", kind: KindAddApp},
		{name: "register", input: "/register C:/project/relaybase.app.json", kind: KindRegister},
		{name: "configure", input: "/configure current folder --dry-run", kind: KindConfigure},
		{name: "open", input: "/open C:/project", kind: KindOpen, target: "C:/project"},
		{name: "prove", input: "/prove notes", kind: KindProve, target: "notes"},
		{name: "health prove", input: "/health notes --prove", kind: KindHealthProve, target: "notes"},
		{name: "repair", input: "/repair notes", kind: KindRepair, target: "notes"},
		{name: "manifest inspect", input: "/manifest inspect notes", kind: KindManifestInspect, target: "notes"},
		{name: "manifest edit", input: "/manifest edit healthUrl /healthz", kind: KindManifestEdit},
		{name: "health route", input: "/health route notes /ready", kind: KindHealthRoute, target: "notes"},
		{name: "port pinned", input: "/port pinned notes 5173", kind: KindPortPinned, target: "notes"},
		{name: "component role", input: "/component role notes frontend", kind: KindComponentRole, target: "notes"},
		{name: "component group", input: "/component group notes notes-app", kind: KindComponentGroup, target: "notes"},
		{name: "component label", input: "/component label notes frontend", kind: KindComponentLabel, target: "notes"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			command, err := Parse(test.input)
			if err != nil {
				t.Fatalf("Parse returned error: %v", err)
			}
			if command.Kind != test.kind {
				t.Fatalf("expected kind %s, got %#v", test.kind, command)
			}
			if test.target != "" && command.Target != test.target {
				t.Fatalf("expected target %s, got %#v", test.target, command)
			}
			if test.scope != "" && command.Scope != test.scope {
				t.Fatalf("expected scope %s, got %#v", test.scope, command)
			}
		})
	}
}

func TestParseSetupCommandDetails(t *testing.T) {
	add, err := Parse("/add app C:/Users/wamin/Desktop/app using npm run dev")
	if err != nil {
		t.Fatalf("Parse add app: %v", err)
	}
	if add.Path != "C:/Users/wamin/Desktop/app" || add.Command != "npm run dev" {
		t.Fatalf("unexpected add app parse: %#v", add)
	}

	configure, err := Parse("/configure current folder --dry-run")
	if err != nil {
		t.Fatalf("Parse configure: %v", err)
	}
	if configure.Path != "current" || !configure.DryRun {
		t.Fatalf("unexpected configure parse: %#v", configure)
	}

	manifest, err := Parse("/manifest edit relaybase.groupId notes")
	if err != nil {
		t.Fatalf("Parse manifest edit: %v", err)
	}
	if manifest.Field != "relaybase.groupId" || manifest.Value != "notes" {
		t.Fatalf("unexpected manifest edit parse: %#v", manifest)
	}

	port, err := Parse("/port pinned notes 5173")
	if err != nil {
		t.Fatalf("Parse port pinned: %v", err)
	}
	if port.Port != 5173 {
		t.Fatalf("unexpected port parse: %#v", port)
	}

	threadNew, err := Parse("/thread new Deep work")
	if err != nil {
		t.Fatalf("Parse thread new: %v", err)
	}
	if threadNew.Value != "Deep work" {
		t.Fatalf("unexpected thread title parse: %#v", threadNew)
	}

	threadExport, err := Parse("/thread export json")
	if err != nil {
		t.Fatalf("Parse thread export: %v", err)
	}
	if threadExport.Format != "json" {
		t.Fatalf("unexpected thread export format: %#v", threadExport)
	}
}

func TestParseRequiredSlashCommandMatrix(t *testing.T) {
	tests := []struct {
		input     string
		kind      string
		target    string
		path      string
		value     string
		scope     string
		format    string
		dryRun    bool
		confirmed bool
	}{
		{input: "/add app", kind: KindAddApp},
		{input: "/add app C:/project using npm run dev", kind: KindAddApp, path: "C:/project"},
		{input: "/configure", kind: KindConfigure, path: "current"},
		{input: "/configure cwd", kind: KindConfigure, path: "current"},
		{input: "/configure current folder", kind: KindConfigure, path: "current"},
		{input: "/configure C:/project", kind: KindConfigure, path: "C:/project"},
		{input: "/configure C:/project --dry-run", kind: KindConfigure, path: "C:/project", dryRun: true},
		{input: "/register C:/project/relaybase.app.json", kind: KindRegister, path: "C:/project/relaybase.app.json"},
		{input: "/open C:/project", kind: KindOpen, target: "C:/project", path: "C:/project"},
		{input: "/prove notes", kind: KindProve, target: "notes"},
		{input: "/health notes --prove", kind: KindHealthProve, target: "notes"},
		{input: "/health route notes /ready", kind: KindHealthRoute, target: "notes"},
		{input: "/repair C:/project", kind: KindRepair, target: "C:/project", path: "C:/project"},
		{input: "/manifest inspect C:/project/relaybase.app.json", kind: KindManifestInspect, target: "C:/project/relaybase.app.json"},
		{input: "/manifest edit healthUrl /healthz", kind: KindManifestEdit, value: "/healthz"},
		{input: "/component group notes notes-app", kind: KindComponentGroup, target: "notes", value: "notes-app"},
		{input: "/component role notes frontend", kind: KindComponentRole, target: "notes", value: "frontend"},
		{input: "/component label notes Notes frontend", kind: KindComponentLabel, target: "notes", value: "Notes frontend"},
		{input: "/port pinned notes 5173", kind: KindPortPinned, target: "notes"},
		{input: "/launch notes", kind: KindLaunch, target: "notes"},
		{input: "/stop notes --confirm", kind: KindStop, target: "notes", confirmed: true},
		{input: "/restart backend", kind: KindRestart, target: "backend"},
		{input: "/logs export pane 2", kind: KindLogsExport, target: "2", scope: ScopePane},
		{input: "/logs export app notes-api", kind: KindLogsExport, target: "notes-api", scope: ScopeApp},
		{input: "/logs export group notes", kind: KindLogsExport, target: "notes", scope: ScopeGroup},
		{input: "/logs export page", kind: KindLogsExport, scope: ScopePage},
		{input: "/logs export all", kind: KindLogsExport, scope: ScopeAll},
		{input: "/page next", kind: KindPage},
		{input: "/page prev", kind: KindPage},
		{input: "/page 3", kind: KindPage},
		{input: "/pane color 1 blue", kind: KindPaneColor, target: "1"},
		{input: "/pin 1", kind: KindPin, target: "1"},
		{input: "/unpin current", kind: KindUnpin, target: "current"},
		{input: "/theme light", kind: KindTheme},
		{input: "/theme dark", kind: KindTheme},
		{input: "/theme auto", kind: KindTheme},
		{input: "/thread list", kind: KindThreadList},
		{input: "/thread new", kind: KindThreadNew},
		{input: "/thread new Release check", kind: KindThreadNew, value: "Release check"},
		{input: "/thread switch session-1", kind: KindThreadSwitch, target: "session-1"},
		{input: "/thread switch 2", kind: KindThreadSwitch, target: "2"},
		{input: "/thread rename Focused work", kind: KindThreadRename, value: "Focused work"},
		{input: "/thread clear", kind: KindThreadClear},
		{input: "/thread export json", kind: KindThreadExport, format: "json"},
		{input: "/thread export markdown", kind: KindThreadExport, format: "markdown"},
		{input: "/thread preview", kind: KindThreadPreview},
		{input: "/daemon status", kind: KindDaemonStatus},
		{input: "/daemon repair", kind: KindDaemonRepair},
		{input: "/daemon retry", kind: KindDaemonRepair},
		{input: "/help", kind: KindHelp},
		{input: "/confirm", kind: KindConfirm},
		{input: "/cancel", kind: KindCancel},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			command, err := Parse(test.input + "   ")
			if err != nil {
				t.Fatalf("Parse(%q): %v", test.input, err)
			}
			if command.Kind != test.kind {
				t.Fatalf("expected kind %s, got %#v", test.kind, command)
			}
			if test.target != "" && command.Target != test.target {
				t.Fatalf("expected target %q, got %#v", test.target, command)
			}
			if test.path != "" && command.Path != test.path {
				t.Fatalf("expected path %q, got %#v", test.path, command)
			}
			if test.value != "" && command.Value != test.value {
				t.Fatalf("expected value %q, got %#v", test.value, command)
			}
			if test.scope != "" && command.Scope != test.scope {
				t.Fatalf("expected scope %q, got %#v", test.scope, command)
			}
			if test.format != "" && command.Format != test.format {
				t.Fatalf("expected format %q, got %#v", test.format, command)
			}
			if command.DryRun != test.dryRun {
				t.Fatalf("expected dry-run=%v, got %#v", test.dryRun, command)
			}
			if command.Confirm != test.confirmed {
				t.Fatalf("expected confirm=%v, got %#v", test.confirmed, command)
			}
		})
	}
}

func TestParseCaseAndWhitespaceVariants(t *testing.T) {
	tests := []struct {
		input  string
		kind   string
		target string
	}{
		{input: "  /LAUNCH Notes  ", kind: KindLaunch, target: "Notes"},
		{input: "\t/Configure CWD\t", kind: KindConfigure},
		{input: " /THREAD EXPORT JSON ", kind: KindThreadExport},
		{input: " /HEALTH Notes --PROVE ", kind: KindHealthProve, target: "Notes"},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			command, err := Parse(test.input)
			if err != nil {
				t.Fatalf("Parse(%q): %v", test.input, err)
			}
			if command.Kind != test.kind {
				t.Fatalf("expected kind %s, got %#v", test.kind, command)
			}
			if test.target != "" && command.Target != test.target {
				t.Fatalf("expected target %s, got %#v", test.target, command)
			}
		})
	}
}

func TestParsePathAndQuotedVariants(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		kind    string
		path    string
		target  string
		command string
		dryRun  bool
	}{
		{name: "quoted Windows path add", input: `/add app "C:\Users\wamin\Desktop\My App" using "npm run dev"`, kind: KindAddApp, path: `C:\Users\wamin\Desktop\My App`, command: "npm run dev"},
		{name: "path with spaces configure", input: `/configure "C:/Users/wamin/Desktop/My App" --dry-run`, kind: KindConfigure, path: "C:/Users/wamin/Desktop/My App", dryRun: true},
		{name: "quoted manifest register", input: `/register "C:/Users/wamin/Desktop/My App/relaybase.app.json"`, kind: KindRegister, path: "C:/Users/wamin/Desktop/My App/relaybase.app.json"},
		{name: "relative path configure", input: `/configure ./examples/notes`, kind: KindConfigure, path: "./examples/notes"},
		{name: "absolute path open", input: `/open C:/Users/wamin/Desktop/project`, kind: KindOpen, path: "C:/Users/wamin/Desktop/project", target: "C:/Users/wamin/Desktop/project"},
		{name: "nonexistent path parsed only", input: `/repair C:/this/path/does/not/exist`, kind: KindRepair, path: "C:/this/path/does/not/exist", target: "C:/this/path/does/not/exist"},
		{name: "path traversal parsed for daemon validation", input: `/manifest inspect ../outside/relaybase.app.json`, kind: KindManifestInspect, path: "../outside/relaybase.app.json", target: "../outside/relaybase.app.json"},
		{name: "command hint can carry npm port separator", input: `/add app C:/project using npm run dev -- --port 0`, kind: KindAddApp, path: "C:/project", command: "npm run dev -- --port 0"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			command, err := Parse(test.input)
			if err != nil {
				t.Fatalf("Parse(%q): %v", test.input, err)
			}
			if command.Kind != test.kind || command.Path != test.path || command.Target != test.target || command.Command != test.command || command.DryRun != test.dryRun {
				t.Fatalf("unexpected parse result: %#v", command)
			}
		})
	}
}

func TestParseConfirmFlag(t *testing.T) {
	command, err := Parse("/stop api --confirm")
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}
	if !command.Confirm {
		t.Fatal("expected confirm flag")
	}
}

func TestParseRejectsInvalidArgumentsAndFlags(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "", want: "Enter a slash command."},
		{input: "help", want: "Slash commands must start with /."},
		{input: "/", want: "Enter a slash command."},
		{input: `/configure "C:/unfinished`, want: "Close the quoted argument"},
		{input: "/launch", want: "Use /launch <app|group|role>."},
		{input: "/launch notes --force", want: `Unknown flag "--force"`},
		{input: "/stop", want: "Use /stop <app|group|role>."},
		{input: "/stop notes --confirm --confirm", want: "Flag --confirm was provided more than once."},
		{input: "/restart", want: "Use /restart <app|group|role>."},
		{input: "/logs", want: "Use /logs export <pane|app|group|page|all>."},
		{input: "/logs export zip", want: "Log export scope must be pane, app, group, page, or all."},
		{input: "/logs export pane --raw", want: `Unknown flag "--raw"`},
		{input: "/page", want: "Use /page <next|prev|number>."},
		{input: "/page zero", want: "Page must be next, prev, or a positive page number."},
		{input: "/pane color", want: "Use /pane color <pane> <color>."},
		{input: "/pane color current blue --alpha", want: `Unknown flag "--alpha"`},
		{input: "/pin", want: "Use /pin <pane>."},
		{input: "/unpin", want: "Use /unpin <pane>."},
		{input: "/theme purple", want: "Theme must be light, dark, or auto."},
		{input: "/help now", want: "Use /help."},
		{input: "/confirm now", want: "Use /confirm."},
		{input: "/cancel now", want: "Use /cancel."},
		{input: "/daemon", want: "Use /daemon <status|repair|retry>."},
		{input: "/daemon fix", want: "Use /daemon <status|repair|retry>."},
		{input: "/thread", want: "Use /thread <list|new|switch|rename|clear|export|preview>."},
		{input: "/thread list --all", want: `Unknown flag "--all"`},
		{input: "/thread switch", want: "Use /thread switch <id|number>."},
		{input: "/thread rename", want: "Use /thread rename <title>."},
		{input: "/thread clear now", want: "Use /thread clear."},
		{input: "/thread export zip", want: "Use /thread export <json|markdown>."},
		{input: "/thread preview now", want: "Use /thread preview."},
		{input: "/add", want: "Use /add app or /add app <path> using <command>."},
		{input: "/add app --force using npm run dev", want: `Unknown flag "--force"`},
		{input: "/add app C:/project using", want: "Use /add app <path> using <command>."},
		{input: "/register", want: "Use /register <manifest-path>."},
		{input: "/register --manifest", want: `Unknown flag "--manifest"`},
		{input: "/configure C:/project --dry-run --dry-run", want: "Flag --dry-run was provided more than once."},
		{input: "/configure C:/project --write", want: `Unknown flag "--write"`},
		{input: "/open", want: "Use /open <path-or-app>."},
		{input: "/prove", want: "Use /prove <app>."},
		{input: "/health", want: "Use /health <app> --prove or /health route <app> <route>."},
		{input: "/health notes --prove --prove", want: "Flag --prove was provided more than once."},
		{input: "/health notes --check", want: `Unknown flag "--check"`},
		{input: "/health route notes", want: "Use /health route <app> <route>."},
		{input: "/repair", want: "Use /repair <app-or-path>."},
		{input: "/manifest", want: "Use /manifest inspect <app-or-path> or /manifest edit <field> <value>."},
		{input: "/manifest inspect", want: "Use /manifest inspect <app-or-path>."},
		{input: "/manifest edit healthUrl", want: "Use /manifest edit <field> <value>."},
		{input: "/port pinned notes 70000", want: "Pinned port must be a number from 1 to 65535."},
		{input: "/port dynamic notes", want: "Use /port pinned <app> <port>."},
		{input: "/component role notes sideways", want: "Component role must be frontend, backend, worker, database, service, or other."},
		{input: "/component order notes 1", want: "Use /component role <app> <role>, /component group <app> <groupId>, or /component label <app> <label>."},
		{input: "/unknown", want: `Unknown slash command "unknown". Use /help.`},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			_, err := Parse(test.input)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("expected error containing %q, got %v", test.want, err)
			}
		})
	}
}

func TestParseRejectsMisleadingSlashForms(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "/confirm now", want: "Use /confirm."},
		{input: "/cancel now", want: "Use /cancel."},
		{input: "/logs export all notes", want: "Use /logs export all."},
		{input: "/logs export page notes", want: "Use /logs export page."},
		{input: "/thread export zip", want: "Use /thread export <json|markdown>."},
		{input: "/thread switch", want: "Use /thread switch <id|number>."},
	}

	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			_, err := Parse(test.input)
			if err == nil || err.Error() != test.want {
				t.Fatalf("expected %q, got %v", test.want, err)
			}
		})
	}
}

func TestConfirmationRequirements(t *testing.T) {
	destructive := []string{
		"/launch api",
		"/stop api",
		"/restart api",
		"/logs export all",
		"/add app C:/project using npm run dev",
		"/configure C:/project",
		"/register C:/project/relaybase.app.json",
		"/open C:/project",
		"/prove notes",
		"/health notes --prove",
		"/manifest edit healthUrl /healthz",
		"/health route notes /ready",
		"/port pinned notes 5173",
		"/component role notes frontend",
		"/component group notes notes-app",
		"/component label notes frontend",
		"/daemon repair",
	}
	for _, input := range destructive {
		command, err := Parse(input)
		if err != nil {
			t.Fatalf("Parse(%q): %v", input, err)
		}
		if !RequiresConfirmation(command) {
			t.Fatalf("expected %q to require confirmation", input)
		}
	}

	nonDestructive := []string{
		"/help",
		"/page next",
		"/theme auto",
		"/pane color current blue",
		"/pin current",
		"/unpin current",
		"/confirm",
		"/cancel",
		"/daemon status",
		"/configure C:/project --dry-run",
		"/repair C:/project",
		"/manifest inspect C:/project/relaybase.app.json",
	}
	for _, input := range nonDestructive {
		command, err := Parse(input)
		if err != nil {
			t.Fatalf("Parse(%q): %v", input, err)
		}
		if RequiresConfirmation(command) {
			t.Fatalf("did not expect %q to require confirmation", input)
		}
	}
}

func TestResolveExactAppDisplayNameGroupAndRole(t *testing.T) {
	ctx := resolutionFixture()

	app, err := ResolveLifecycleTarget(ctx, "api")
	if err != nil {
		t.Fatalf("resolve app: %v", err)
	}
	if len(app.AppIDs) != 1 || app.AppIDs[0] != "api" {
		t.Fatalf("unexpected app target: %#v", app)
	}

	display, err := ResolveLifecycleTarget(ctx, "API")
	if err != nil {
		t.Fatalf("resolve display: %v", err)
	}
	if len(display.AppIDs) != 1 || display.AppIDs[0] != "api" {
		t.Fatalf("unexpected display target: %#v", display)
	}

	group, err := ResolveLifecycleTarget(ctx, "Notes")
	if err != nil {
		t.Fatalf("resolve group: %v", err)
	}
	if len(group.AppIDs) != 2 || group.GroupID != "notes" {
		t.Fatalf("unexpected group target: %#v", group)
	}

	role, err := ResolveLifecycleTarget(ctx, "backend")
	if err != nil {
		t.Fatalf("resolve role: %v", err)
	}
	if len(role.AppIDs) != 1 || role.AppIDs[0] != "api" {
		t.Fatalf("unexpected role target: %#v", role)
	}
}

func TestResolveRequiredTargetForms(t *testing.T) {
	ctx := resolutionFixture()
	ctx.State.Apps = append(ctx.State.Apps,
		relaybaseclient.AppState{ID: "stopped-app", Name: "Stopped App", RuntimeStatus: "stopped"},
		relaybaseclient.AppState{ID: "failed-app", Name: "Failed App", RuntimeStatus: "failed"},
		relaybaseclient.AppState{ID: "hidden-app", Name: "Hidden App", RuntimeStatus: "running"},
	)
	ctx.State.Groups = append(ctx.State.Groups, relaybaseclient.AppGroup{
		GroupID:     "shop",
		DisplayName: "Shop",
		Components: []relaybaseclient.AppComponent{
			{AppID: "shop-api", GroupID: "shop", Role: "backend", PaneLabel: "backend", DisplayName: "Shop API"},
		},
	})
	ctx.State.Components = append(ctx.State.Components, ctx.State.Groups[0].Components...)
	ctx.State.Components = append(ctx.State.Components,
		relaybaseclient.AppComponent{AppID: "shop-api", GroupID: "shop", Role: "backend", PaneLabel: "backend", DisplayName: "Shop API"},
		relaybaseclient.AppComponent{AppID: "stopped-app", GroupID: "ops", Role: "worker", PaneLabel: "worker", DisplayName: "Stopped Worker", Status: "stopped"},
		relaybaseclient.AppComponent{AppID: "failed-app", GroupID: "ops", Role: "service", PaneLabel: "service", DisplayName: "Failed Service", Status: "failed"},
		relaybaseclient.AppComponent{AppID: "hidden-app", GroupID: "ops", Role: "service", PaneLabel: "hidden", DisplayName: "Hidden App", Status: "running"},
	)

	tests := []struct {
		name    string
		target  string
		appID   string
		groupID string
		paneID  string
	}{
		{name: "exact app ID", target: "api", appID: "api"},
		{name: "display name", target: "Web", appID: "web"},
		{name: "group ID", target: "notes", groupID: "notes"},
		{name: "group label", target: "Notes", groupID: "notes"},
		{name: "frontend role in selected group", target: "frontend", appID: "web", groupID: "notes"},
		{name: "backend role in selected group", target: "backend", appID: "api", groupID: "notes"},
		{name: "selected pane", target: "current", appID: "api", paneID: "notes:api:backend:backend"},
		{name: "current page pane number", target: "1", appID: "web", paneID: "notes:web:frontend:frontend"},
		{name: "stopped app", target: "stopped-app", appID: "stopped-app"},
		{name: "failed app", target: "Failed App", appID: "failed-app"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolved, err := ResolveLifecycleTarget(ctx, test.target)
			if err != nil {
				t.Fatalf("ResolveLifecycleTarget(%q): %v", test.target, err)
			}
			if test.appID != "" && (len(resolved.AppIDs) != 1 || resolved.AppIDs[0] != test.appID) {
				t.Fatalf("expected app %s, got %#v", test.appID, resolved)
			}
			if test.groupID != "" && resolved.GroupID != test.groupID {
				t.Fatalf("expected group %s, got %#v", test.groupID, resolved)
			}
			if test.paneID != "" && resolved.PaneID != test.paneID {
				t.Fatalf("expected pane %s, got %#v", test.paneID, resolved)
			}
		})
	}

	pane, err := ResolvePaneTarget(ctx, "2")
	if err != nil {
		t.Fatalf("ResolvePaneTarget number: %v", err)
	}
	if pane.PaneID != "notes:api:backend:backend" || len(pane.AppIDs) != 1 || pane.AppIDs[0] != "api" {
		t.Fatalf("unexpected numeric pane target: %#v", pane)
	}

	command, err := Parse("/logs export pane 1")
	if err != nil {
		t.Fatalf("parse numeric pane export: %v", err)
	}
	exported, err := ResolveExportTarget(ctx, command)
	if err != nil {
		t.Fatalf("ResolveExportTarget pane number: %v", err)
	}
	if exported.Scope != ScopePane || exported.PaneID != "notes:web:frontend:frontend" {
		t.Fatalf("unexpected numeric export target: %#v", exported)
	}
}

func TestAmbiguousTargetResolution(t *testing.T) {
	ctx := resolutionFixture()
	ctx.State.Apps = append(ctx.State.Apps, relaybaseclient.AppState{ID: "other-api", Name: "API"})

	_, err := ResolveLifecycleTarget(ctx, "API")
	var resolutionError ResolutionError
	if !errors.As(err, &resolutionError) {
		t.Fatalf("expected ResolutionError, got %T", err)
	}
	if resolutionError.Kind != "ambiguous" {
		t.Fatalf("expected ambiguous error, got %#v", resolutionError)
	}
	if len(resolutionError.Options) == 0 {
		t.Fatalf("expected ambiguity options, got %#v", resolutionError)
	}
}

func TestUnknownTargetResolution(t *testing.T) {
	_, err := ResolveLifecycleTarget(resolutionFixture(), "missing")
	var resolutionError ResolutionError
	if !errors.As(err, &resolutionError) {
		t.Fatalf("expected ResolutionError, got %T", err)
	}
	if resolutionError.Kind != "unknown" {
		t.Fatalf("expected unknown error, got %#v", resolutionError)
	}
	if !containsString(resolutionError.Message, "exact app id") || !containsString(resolutionError.Message, "current pane") {
		t.Fatalf("expected actionable unknown-target message, got %#v", resolutionError)
	}
}

func TestTargetResolutionNeverGuessesHiddenUnknownOrPartialTargets(t *testing.T) {
	ctx := resolutionFixture()
	ctx.State.Apps = append(ctx.State.Apps,
		relaybaseclient.AppState{ID: "dashboard-one", Name: "Dashboard One"},
		relaybaseclient.AppState{ID: "dashboard-two", Name: "Dashboard Two"},
		relaybaseclient.AppState{ID: "hidden-app", Name: "Hidden Pane"},
	)

	for _, test := range []struct {
		name    string
		resolve func() (ResolvedTarget, error)
	}{
		{name: "unknown target", resolve: func() (ResolvedTarget, error) { return ResolveLifecycleTarget(ctx, "missing") }},
		{name: "ambiguous partial target is not guessed", resolve: func() (ResolvedTarget, error) { return ResolveLifecycleTarget(ctx, "dashboard") }},
		{name: "hidden pane is not guessed from app state", resolve: func() (ResolvedTarget, error) { return ResolvePaneTarget(ctx, "hidden-app") }},
		{name: "pane number outside current page", resolve: func() (ResolvedTarget, error) { return ResolvePaneTarget(ctx, "9") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := test.resolve()
			var resolutionError ResolutionError
			if !errors.As(err, &resolutionError) {
				t.Fatalf("expected ResolutionError, got %T %v", err, err)
			}
			if resolutionError.Kind != "unknown" {
				t.Fatalf("expected unknown error, got %#v", resolutionError)
			}
		})
	}
}

func TestAmbiguousRoleResolutionNamesSaferChoices(t *testing.T) {
	ctx := resolutionFixture()
	ctx.SelectedPane = PaneRef{}
	ctx.State.Components = []relaybaseclient.AppComponent{
		{AppID: "api", GroupID: "notes", Role: "backend", PaneLabel: "backend"},
		{AppID: "shop-api", GroupID: "shop", Role: "backend", PaneLabel: "backend"},
	}

	_, err := ResolveLifecycleTarget(ctx, "backend")
	var resolutionError ResolutionError
	if !errors.As(err, &resolutionError) {
		t.Fatalf("expected ResolutionError, got %T", err)
	}
	if resolutionError.Kind != "ambiguous" {
		t.Fatalf("expected ambiguous role error, got %#v", resolutionError)
	}
	if !containsString(resolutionError.Message, "Select a pane") || len(resolutionError.Options) != 2 {
		t.Fatalf("expected safer ambiguity guidance and options, got %#v", resolutionError)
	}
}

func TestResolveExportTargets(t *testing.T) {
	ctx := resolutionFixture()
	command, err := Parse("/logs export pane")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	target, err := ResolveExportTarget(ctx, command)
	if err != nil {
		t.Fatalf("resolve pane export: %v", err)
	}
	if target.Scope != ScopePane || target.PaneID != "notes:api:backend:backend" {
		t.Fatalf("unexpected pane export target: %#v", target)
	}

	command, err = Parse("/logs export all")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	target, err = ResolveExportTarget(ctx, command)
	if err != nil {
		t.Fatalf("resolve all export: %v", err)
	}
	if target.Scope != ScopeAll {
		t.Fatalf("unexpected all export target: %#v", target)
	}
}

func resolutionFixture() ResolutionContext {
	state := &relaybaseclient.RelaybaseState{
		Apps: []relaybaseclient.AppState{
			{ID: "web", Name: "Web"},
			{ID: "api", Name: "API"},
		},
		Groups: []relaybaseclient.AppGroup{
			{
				GroupID:     "notes",
				DisplayName: "Notes",
				Components: []relaybaseclient.AppComponent{
					{AppID: "web", GroupID: "notes", Role: "frontend", PaneLabel: "frontend", DisplayName: "Web"},
					{AppID: "api", GroupID: "notes", Role: "backend", PaneLabel: "backend", DisplayName: "API"},
				},
			},
		},
	}
	selected := PaneRef{
		ID:          "notes:api:backend:backend",
		AppID:       "api",
		GroupID:     "notes",
		Role:        "backend",
		Title:       "Notes: backend",
		DisplayName: "API",
	}
	return ResolutionContext{
		State:        state,
		SelectedPane: selected,
		PagePanes: []PaneRef{
			{ID: "notes:web:frontend:frontend", AppID: "web", GroupID: "notes", Role: "frontend", Title: "Notes: frontend", DisplayName: "Web"},
			selected,
		},
	}
}

func containsString(value string, expected string) bool {
	return strings.Contains(value, expected)
}
