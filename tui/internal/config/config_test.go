package config

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cameloo/relaybase/tui/internal/tui/testfixtures"
)

func TestLoadWithEnvUsesRelaybaseConventions(t *testing.T) {
	env := map[string]string{
		"RELAYBASE_URL":       "http://127.0.0.1:9999",
		"RELAYBASE_TOKEN":     "env-token",
		"RELAYBASE_STATE_DIR": "/tmp/relaybase-state",
		"RELAYBASE_TUI_THEME": "dark",
	}
	cfg := LoadWithEnv(func(key string) string { return env[key] })

	if cfg.BaseURL != "http://127.0.0.1:9999" {
		t.Fatalf("unexpected base url: %s", cfg.BaseURL)
	}
	if cfg.Token != "env-token" {
		t.Fatalf("unexpected token: %s", cfg.Token)
	}
	if cfg.StateDir != "/tmp/relaybase-state" {
		t.Fatalf("unexpected state dir: %s", cfg.StateDir)
	}
	if cfg.ThemeMode != "dark" {
		t.Fatalf("unexpected theme: %s", cfg.ThemeMode)
	}
}

func TestLoadWithEnvUsesConfiguredStateDirWithoutUserState(t *testing.T) {
	stateDir := testfixtures.IsolatedStateDir(t)
	if err := os.WriteFile(filepath.Join(stateDir, "session-token"), []byte("temp-token\n"), 0o600); err != nil {
		t.Fatalf("write token fixture: %v", err)
	}
	env := map[string]string{
		"LOCALAPPDATA":         filepath.Join(t.TempDir(), "real-user-state"),
		"RELAYBASE_STATE_DIR": stateDir,
	}

	cfg := LoadWithEnv(func(key string) string { return env[key] })

	if cfg.StateDir != stateDir {
		t.Fatalf("expected configured state dir, got %s", cfg.StateDir)
	}
	if cfg.Token != "temp-token" {
		t.Fatalf("expected token from temp state dir, got %q", cfg.Token)
	}
	if cfg.TokenPath != filepath.Join(stateDir, "session-token") {
		t.Fatalf("expected temp token path, got %s", cfg.TokenPath)
	}
}
