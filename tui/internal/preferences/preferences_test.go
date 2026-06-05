package preferences

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cameloo/relaybase/tui/internal/tui/assistant"
)

func TestLoadDefaultsWhenPreferenceFileMissing(t *testing.T) {
	store := NewStore(t.TempDir())
	prefs, result := store.Load()

	if prefs.Version != SchemaVersion {
		t.Fatalf("expected schema version %d, got %d", SchemaVersion, prefs.Version)
	}
	if prefs.Theme != "auto" {
		t.Fatalf("unexpected default theme: %s", prefs.Theme)
	}
	if result.Path != filepath.Join(store.stateDir, "tui", FileName) {
		t.Fatalf("unexpected path: %s", result.Path)
	}
}

func TestSavePreferencesAtomically(t *testing.T) {
	store := NewStore(t.TempDir())
	prefs := Default()
	prefs.Theme = "dark"
	prefs.Panes.Pinned = []string{"notes:web"}

	if err := store.Save(prefs); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	loaded, result := store.Load()
	if len(result.Diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %#v", result.Diagnostics)
	}
	if loaded.Theme != "dark" {
		t.Fatalf("expected dark theme, got %s", loaded.Theme)
	}
	if len(loaded.Panes.Pinned) != 1 || loaded.Panes.Pinned[0] != "notes:web" {
		t.Fatalf("pinned pane did not persist: %#v", loaded.Panes.Pinned)
	}
	tempFiles, err := filepath.Glob(filepath.Join(filepath.Dir(store.Path()), ".preferences-*.tmp"))
	if err != nil {
		t.Fatalf("glob temp preferences: %v", err)
	}
	if len(tempFiles) != 0 {
		t.Fatalf("atomic save left temporary files behind: %#v", tempFiles)
	}
}

func TestSaveAndLoadAllSupportedPreferences(t *testing.T) {
	store := NewStore(t.TempDir())
	prefs := Default()
	prefs.Theme = "dark"
	prefs.Keymap.ContextMenu = []string{"ctrl+x", "ctrl+y"}
	prefs.Panes.Pinned = []string{"notes:web", "api:backend"}
	prefs.Panes.Hidden = []string{"archived:web"}
	prefs.Panes.Order = []string{"api:backend", "notes:web", "archived:web"}
	prefs.Panes.Colors = map[string]string{
		"api:backend": "#216869",
		"notes:web":   "#abc",
	}
	prefs.Assistant.BarColor = "#6d4c3d"
	prefs.Assistant.HistoryRetentionDays = 14
	prefs.Layout.LastPage = 2
	prefs.Layout.Density = "comfortable"

	if err := store.Save(prefs); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	loaded, result := store.Load()
	if len(result.Diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %#v", result.Diagnostics)
	}
	if loaded.Theme != "dark" {
		t.Fatalf("theme did not persist: %#v", loaded)
	}
	if strings.Join(loaded.Keymap.ContextMenu, ",") != "ctrl+x,ctrl+y" {
		t.Fatalf("context menu fallback did not persist: %#v", loaded.Keymap.ContextMenu)
	}
	if strings.Join(loaded.Panes.Pinned, ",") != "api:backend,notes:web" {
		t.Fatalf("pinned panes did not persist and normalize: %#v", loaded.Panes.Pinned)
	}
	if strings.Join(loaded.Panes.Hidden, ",") != "archived:web" {
		t.Fatalf("hidden panes did not persist: %#v", loaded.Panes.Hidden)
	}
	if strings.Join(loaded.Panes.Order, ",") != "api:backend,notes:web,archived:web" {
		t.Fatalf("pane order did not persist: %#v", loaded.Panes.Order)
	}
	if loaded.Panes.Colors["api:backend"] != "#216869" || loaded.Panes.Colors["notes:web"] != "#abc" {
		t.Fatalf("pane colors did not persist: %#v", loaded.Panes.Colors)
	}
	if loaded.Assistant.BarColor != "#6d4c3d" || loaded.Assistant.HistoryRetentionDays != 14 {
		t.Fatalf("assistant preferences did not persist: %#v", loaded.Assistant)
	}
	if loaded.Layout.LastPage != 2 || loaded.Layout.Density != "comfortable" {
		t.Fatalf("layout preferences did not persist: %#v", loaded.Layout)
	}
}

func TestCorruptPreferenceFileIsRenamedAndDefaultsRegenerate(t *testing.T) {
	store := NewStoreWithClock(t.TempDir(), func() time.Time {
		return time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	})
	if err := os.MkdirAll(filepath.Dir(store.Path()), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(store.Path(), []byte("{not-json"), 0o600); err != nil {
		t.Fatalf("write corrupt prefs: %v", err)
	}

	prefs, result := store.Load()
	if prefs.Theme != "auto" || prefs.Version != SchemaVersion {
		t.Fatalf("expected defaults after corruption, got %#v", prefs)
	}
	if result.BrokenPath == "" || !strings.Contains(result.BrokenPath, ".broken.20260601T120000Z") {
		t.Fatalf("unexpected broken path: %#v", result)
	}
	if _, err := os.Stat(result.BrokenPath); err != nil {
		t.Fatalf("broken file was not retained: %v", err)
	}
	if _, err := os.Stat(store.Path()); err != nil {
		t.Fatalf("default preferences were not regenerated: %v", err)
	}
}

func TestMigrationFromVersionZero(t *testing.T) {
	store := NewStore(t.TempDir())
	if err := os.MkdirAll(filepath.Dir(store.Path()), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(store.Path(), []byte(`{"version":0,"theme":"dark","layout":{"lastPage":3}}`), 0o600); err != nil {
		t.Fatalf("write old prefs: %v", err)
	}

	prefs, result := store.Load()
	if len(result.Diagnostics) != 0 {
		t.Fatalf("unexpected diagnostics: %#v", result.Diagnostics)
	}
	if prefs.Version != SchemaVersion || prefs.Theme != "dark" || prefs.Layout.LastPage != 3 {
		t.Fatalf("migration failed: %#v", prefs)
	}
}

func TestUnsupportedFuturePreferenceVersionFailsSafely(t *testing.T) {
	store := NewStoreWithClock(t.TempDir(), func() time.Time {
		return time.Date(2026, 6, 1, 13, 0, 0, 0, time.UTC)
	})
	if err := os.MkdirAll(filepath.Dir(store.Path()), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(store.Path(), []byte(`{"version":999,"theme":"dark"}`), 0o600); err != nil {
		t.Fatalf("write future prefs: %v", err)
	}

	prefs, result := store.Load()
	if prefs.Version != SchemaVersion || prefs.Theme != "auto" {
		t.Fatalf("expected safe defaults for unsupported future version, got %#v", prefs)
	}
	if result.BrokenPath == "" || !strings.Contains(result.BrokenPath, ".broken.20260601T130000Z") {
		t.Fatalf("future-version file was not moved aside: %#v", result)
	}
	if len(result.Diagnostics) == 0 || result.Diagnostics[0].Code != "preferences_corrupt" {
		t.Fatalf("expected safe diagnostic for unsupported future version, got %#v", result.Diagnostics)
	}
	raw, err := os.ReadFile(store.Path())
	if err != nil {
		t.Fatalf("read regenerated preferences: %v", err)
	}
	if strings.Contains(string(raw), `"version": 999`) || strings.Contains(string(raw), `"theme": "dark"`) {
		t.Fatalf("future-version preferences were reused instead of regenerated: %s", raw)
	}
}

func TestNoSecretTokenAppearsInPreferenceJSON(t *testing.T) {
	store := NewStore(t.TempDir())
	prefs := Default()
	prefs.Theme = "token=abc"
	prefs.Panes.Pinned = []string{"pane-1", "password=abc"}
	prefs.Panes.Colors = map[string]string{
		"pane-1":          "#123456",
		"api_key=secret":  "#abcdef",
		"pane-with-token": "token=abc",
	}

	if err := store.Save(prefs); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	raw, err := os.ReadFile(store.Path())
	if err != nil {
		t.Fatalf("read preferences: %v", err)
	}
	output := strings.ToLower(string(raw))
	for _, forbidden := range []string{"token=abc", "password=abc", "api_key=secret"} {
		if strings.Contains(output, forbidden) {
			t.Fatalf("preference JSON leaked %s: %s", forbidden, output)
		}
	}
}

func TestAssistantProviderDefaultsArePrivate(t *testing.T) {
	prefs := Default()
	if prefs.Assistant.Provider.Mode != assistant.ModeDeterministic {
		t.Fatalf("expected deterministic assistant default, got %#v", prefs.Assistant.Provider)
	}
	if prefs.Assistant.Provider.SendLogs || prefs.Assistant.Provider.SendDiagnostics || prefs.Assistant.Provider.RemoteEnabled {
		t.Fatalf("expected private assistant defaults, got %#v", prefs.Assistant.Provider)
	}
}

func TestAssistantProviderDoesNotStoreRawAPIKey(t *testing.T) {
	store := NewStore(t.TempDir())
	prefs := Default()
	prefs.Assistant.Provider = assistant.ProviderConfig{
		Mode:          assistant.ModeRemoteModel,
		Provider:      "openai-compatible",
		Model:         "gpt-test",
		BaseURL:       "https://example.invalid/v1",
		APIKeyRef:     "sk-abc123secret",
		RemoteEnabled: true,
	}

	if err := store.Save(prefs); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	raw, err := os.ReadFile(store.Path())
	if err != nil {
		t.Fatalf("read preferences: %v", err)
	}
	output := strings.ToLower(string(raw))
	if strings.Contains(output, "sk-abc123secret") || strings.Contains(output, "abc123secret") {
		t.Fatalf("preference JSON leaked raw API key: %s", output)
	}
	loaded, _ := store.Load()
	if loaded.Assistant.Provider.APIKeyRef != "" {
		t.Fatalf("expected raw API key ref to be rejected, got %#v", loaded.Assistant.Provider)
	}
}
