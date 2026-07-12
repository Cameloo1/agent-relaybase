package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/config"
	"github.com/cameloo/relaybase/tui/internal/events"
	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/commands"
	"github.com/cameloo/relaybase/tui/internal/tui/model"
)

func main() {
	cfg := config.Load()

	baseURL := flag.String("base-url", cfg.BaseURL, "Relaybase daemon base URL")
	stateDir := flag.String("state-dir", cfg.StateDir, "Relaybase state directory")
	currentDirectory := flag.String("current-directory", cfg.CurrentDirectory, "trusted current project directory for setup/onboarding prompts")
	theme := flag.String("theme", cfg.ThemeMode, "theme mode: auto, light, or dark")
	smokeRender := flag.Bool("smoke-render", false, "render one deterministic smoke-evidence frame and exit")
	smokeInput := flag.String("smoke-input", "", "optional command or assistant input for smoke-render")
	smokeAgentSessionID := flag.String("smoke-agent-session-id", "", "optional Agent Gateway session id to render in smoke-render")
	smokeWidth := flag.Int("smoke-width", 100, "smoke-render terminal width")
	smokeHeight := flag.Int("smoke-height", 30, "smoke-render terminal height")
	flag.Parse()
	stateDirExplicit := false
	flag.Visit(func(parsed *flag.Flag) {
		if parsed.Name == "state-dir" {
			stateDirExplicit = true
		}
	})

	cfg.BaseURL = *baseURL
	cfg.StateDir = *stateDir
	cfg.CurrentDirectory = *currentDirectory
	cfg.ThemeMode = *theme
	cfg.ReloadTokenForStateDir(stateDirExplicit)

	httpClient := &http.Client{Timeout: 20 * time.Second}
	client := relaybaseclient.New(cfg.BaseURL, cfg.Token, httpClient)
	root := model.NewRoot(cfg, client)
	if *smokeRender {
		if err := renderSmokeFrame(root, client, *smokeInput, *smokeAgentSessionID, *smokeWidth, *smokeHeight, cfg.HTTPTimeout); err != nil {
			fmt.Fprintf(os.Stderr, "relaybase-tui smoke render: %v\n", err)
			os.Exit(1)
		}
		return
	}

	program := tea.NewProgram(root)
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "relaybase-tui: %v\n", err)
		os.Exit(1)
	}
}

func renderSmokeFrame(root model.RootModel, client *relaybaseclient.Client, input string, agentSessionID string, width int, height int, timeout time.Duration) error {
	if width <= 0 {
		width = 100
	}
	if height <= 0 {
		height = 30
	}

	updated, cmd := root.Update(tea.WindowSizeMsg{Width: width, Height: height})
	root = updated.(model.RootModel)
	root = drainSmokeCmd(root, cmd)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	state, err := client.GetState(ctx)
	if err != nil {
		updated, _ = root.Update(commands.StateFailedMsg{Err: err})
		root = updated.(model.RootModel)
		fmt.Fprintln(os.Stdout, root.Render())
		return nil
	}

	updated, cmd = root.Update(commands.StateLoadedMsg{State: state})
	root = updated.(model.RootModel)
	root = drainSmokeCmd(root, cmd)

	if config, err := client.GetAgentConfig(ctx); err == nil {
		updated, cmd = root.Update(commands.AgentConfigLoadedMsg{Config: config})
		root = updated.(model.RootModel)
		root = drainSmokeCmd(root, cmd)
	} else {
		updated, cmd = root.Update(commands.AgentConfigFailedMsg{Err: err})
		root = updated.(model.RootModel)
		root = drainSmokeCmd(root, cmd)
	}

	if diagnostics, err := client.GetAgentDiagnostics(ctx); err == nil {
		updated, cmd = root.Update(commands.AgentDiagnosticsLoadedMsg{Diagnostics: diagnostics})
		root = updated.(model.RootModel)
		root = drainSmokeCmd(root, cmd)
	} else {
		updated, cmd = root.Update(commands.AgentDiagnosticsFailedMsg{Err: err})
		root = updated.(model.RootModel)
		root = drainSmokeCmd(root, cmd)
	}

	if agentSessionID != "" {
		session, err := client.GetAgentSession(ctx, agentSessionID)
		if err != nil {
			return err
		}
		updated, _ = root.Update(commands.AgentSessionCreatedMsg{Session: session})
		root = updated.(model.RootModel)
		for _, run := range session.Runs {
			updated, cmd = root.Update(commands.AgentMessageSentMsg{
				Result: &relaybaseclient.AgentMessageResult{Run: run},
			})
			root = updated.(model.RootModel)
			root = drainSmokeCmd(root, cmd)
		}
	}

	if input != "" {
		root = applySmokeInput(root, input)
	}

	fmt.Fprintln(os.Stdout, root.Render())
	return nil
}

func drainSmokeCmd(root model.RootModel, cmd tea.Cmd) model.RootModel {
	if cmd == nil {
		return root
	}

	msg := cmd()
	if batch, ok := msg.(tea.BatchMsg); ok {
		for _, nested := range batch {
			root = drainSmokeCmd(root, nested)
		}
		return root
	}

	updated, next := root.Update(msg)
	switch streamMsg := msg.(type) {
	case events.StreamConnectedMsg:
		_ = streamMsg.Stream.Close()
		return updated.(model.RootModel)
	case commands.AgentEventsConnectedMsg:
		_ = streamMsg.Stream.Close()
		return updated.(model.RootModel)
	}
	root = updated.(model.RootModel)
	return drainSmokeCmd(root, next)
}

func applySmokeInput(root model.RootModel, input string) model.RootModel {
	for _, char := range input {
		// Textarea editing can schedule cursor blink/tick commands. A one-frame
		// smoke render needs the resulting draft, not an unbounded animation
		// drain; only the final Enter may issue a meaningful daemon command.
		updated, _ := root.Update(tea.KeyPressMsg{Text: string(char), Code: char})
		root = updated.(model.RootModel)
	}

	updated, cmd := root.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	root = updated.(model.RootModel)
	return drainSmokeCmd(root, cmd)
}
