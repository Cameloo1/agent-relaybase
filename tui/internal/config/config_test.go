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
		"LOCALAPPDATA":        filepath.Join(t.TempDir(), "real-user-state"),
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

func TestExplicitStateDirPrefersThatStateToken(t *testing.T) {
	userStateDir := testfixtures.IsolatedStateDir(t)
	if err := os.WriteFile(filepath.Join(userStateDir, "session-token"), []byte("stale-user-token\n"), 0o600); err != nil {
		t.Fatalf("write default token fixture: %v", err)
	}
	selectedStateDir := testfixtures.IsolatedStateDir(t)
	if err := os.WriteFile(filepath.Join(selectedStateDir, "session-token"), []byte("selected-token\n"), 0o600); err != nil {
		t.Fatalf("write selected token fixture: %v", err)
	}
	env := map[string]string{
		"RELAYBASE_STATE_DIR": userStateDir,
	}

	cfg := LoadWithEnv(func(key string) string { return env[key] })
	if cfg.Token != "stale-user-token" {
		t.Fatalf("expected default token before override, got %q", cfg.Token)
	}

	cfg.StateDir = selectedStateDir
	cfg.ReloadTokenForStateDir(true)

	if cfg.Token != "selected-token" {
		t.Fatalf("expected selected state token after explicit override, got %q", cfg.Token)
	}
	if cfg.TokenPath != filepath.Join(selectedStateDir, "session-token") {
		t.Fatalf("expected selected token path, got %s", cfg.TokenPath)
	}
}

func TestExplicitStateDirWithoutTokenClearsInheritedFileToken(t *testing.T) {
	defaultStateDir := testfixtures.IsolatedStateDir(t)
	if err := os.WriteFile(filepath.Join(defaultStateDir, "session-token"), []byte("default-token\n"), 0o600); err != nil {
		t.Fatalf("write default token fixture: %v", err)
	}
	selectedStateDir := testfixtures.IsolatedStateDir(t)
	cfg := LoadWithEnv(func(key string) string {
		if key == "RELAYBASE_STATE_DIR" {
			return defaultStateDir
		}
		return ""
	})

	cfg.StateDir = selectedStateDir
	cfg.ReloadTokenForStateDir(true)

	if cfg.Token != "" {
		t.Fatalf("explicit tokenless state inherited another state token: %q", cfg.Token)
	}
}

func TestExplicitEnvironmentTokenSurvivesTokenlessStateOverride(t *testing.T) {
	selectedStateDir := testfixtures.IsolatedStateDir(t)
	cfg := LoadWithEnv(func(key string) string {
		if key == "RELAYBASE_TOKEN" {
			return "explicit-token"
		}
		return ""
	})

	cfg.StateDir = selectedStateDir
	cfg.ReloadTokenForStateDir(true)

	if cfg.Token != "explicit-token" {
		t.Fatalf("explicit environment token was discarded: %q", cfg.Token)
	}
}

func TestReloadTokenFromDiskUpdatesOnlyForANewNonemptyToken(t *testing.T) {
	stateDir := testfixtures.IsolatedStateDir(t)
	tokenPath := filepath.Join(stateDir, "session-token")
	cfg := Config{StateDir: stateDir, Token: "old-token", TokenPath: tokenPath}

	if cfg.ReloadTokenFromDisk() {
		t.Fatal("missing token file must not clear or replace the in-memory token")
	}
	if cfg.Token != "old-token" {
		t.Fatalf("missing token file changed token to %q", cfg.Token)
	}
	if err := os.WriteFile(tokenPath, []byte("new-token\n"), 0o600); err != nil {
		t.Fatalf("write rotated token: %v", err)
	}
	if !cfg.ReloadTokenFromDisk() || cfg.Token != "new-token" {
		t.Fatalf("expected rotated token, changed=%v token=%q", cfg.Token == "new-token", cfg.Token)
	}
	if cfg.ReloadTokenFromDisk() {
		t.Fatal("unchanged token must not trigger another retry")
	}
}
