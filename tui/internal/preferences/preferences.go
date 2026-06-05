package preferences

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/cameloo/relaybase/tui/internal/tui/assistant"
)

const (
	SchemaVersion = 1
	FileName      = "preferences.json"
)

var secretPattern = regexp.MustCompile(`(?i)(token|password|passwd|secret|api[_-]?key|authorization|bearer|relaybase_token|session-token)`)

type Preferences struct {
	Version   int                 `json:"version"`
	Theme     string              `json:"theme"`
	Keymap    KeymapPreferences   `json:"keymap"`
	Panes     PanePreferences     `json:"panes"`
	Assistant AssistantPreference `json:"assistant"`
	Layout    LayoutPreferences   `json:"layout"`
}

type KeymapPreferences struct {
	ContextMenu []string `json:"contextMenu"`
}

type PanePreferences struct {
	Pinned []string          `json:"pinned"`
	Hidden []string          `json:"hidden"`
	Order  []string          `json:"order"`
	Colors map[string]string `json:"colors"`
}

type AssistantPreference struct {
	BarColor             string                   `json:"barColor"`
	HistoryRetentionDays int                      `json:"historyRetentionDays"`
	Provider             assistant.ProviderConfig `json:"provider"`
}

type LayoutPreferences struct {
	LastPage int    `json:"lastPage"`
	Density  string `json:"density"`
}

type Diagnostic struct {
	Code     string
	Severity string
	Message  string
}

type LoadResult struct {
	Path        string
	BrokenPath  string
	Diagnostics []Diagnostic
}

type Store struct {
	stateDir string
	now      func() time.Time
}

func NewStore(stateDir string) Store {
	return Store{
		stateDir: stateDir,
		now:      time.Now,
	}
}

func NewStoreWithClock(stateDir string, now func() time.Time) Store {
	store := NewStore(stateDir)
	if now != nil {
		store.now = now
	}
	return store
}

func (s Store) Path() string {
	return filepath.Join(s.stateDir, "tui", FileName)
}

func (s Store) Load() (Preferences, LoadResult) {
	result := LoadResult{Path: s.Path()}
	defaults := Default()

	if stat, err := os.Stat(s.stateDir); err == nil && !stat.IsDir() {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Code:     "preferences_load_failed",
			Severity: "warning",
			Message:  fmt.Sprintf("Could not load TUI preferences; state directory is not a directory: %s", s.stateDir),
		})
		return defaults, result
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Code:     "preferences_load_failed",
			Severity: "warning",
			Message:  fmt.Sprintf("Could not inspect TUI preferences state directory; using defaults: %v", err),
		})
		return defaults, result
	}

	raw, err := os.ReadFile(result.Path)
	if err == nil {
		preferences, migrateErr := migrate(raw)
		if migrateErr != nil {
			return s.handleBrokenFile(defaults, result, migrateErr)
		}
		preferences = Sanitize(preferences)
		preferences = normalize(preferences)
		return preferences, result
	}

	if errors.Is(err, os.ErrNotExist) {
		return defaults, result
	}

	result.Diagnostics = append(result.Diagnostics, Diagnostic{
		Code:     "preferences_load_failed",
		Severity: "warning",
		Message:  fmt.Sprintf("Could not load TUI preferences; using defaults: %v", err),
	})
	return defaults, result
}

func (s Store) Save(preferences Preferences) error {
	preferences = normalize(Sanitize(preferences))
	payload, err := json.MarshalIndent(preferences, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	path := s.Path()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	temp, err := os.CreateTemp(dir, ".preferences-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tempPath)
		}
	}()

	if _, err := temp.Write(payload); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := replaceFile(tempPath, path); err != nil {
		return err
	}
	cleanup = false
	_ = syncDirectory(dir)
	return nil
}

func (s Store) handleBrokenFile(defaults Preferences, result LoadResult, reason error) (Preferences, LoadResult) {
	brokenPath := result.Path + ".broken." + s.now().UTC().Format("20060102T150405Z")
	if err := os.Rename(result.Path, brokenPath); err != nil {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Code:     "preferences_corrupt",
			Severity: "warning",
			Message:  fmt.Sprintf("Preference file is corrupt and could not be moved aside; using defaults: %v", reason),
		})
		return defaults, result
	}

	result.BrokenPath = brokenPath
	result.Diagnostics = append(result.Diagnostics, Diagnostic{
		Code:     "preferences_corrupt",
		Severity: "warning",
		Message:  "Preference file was corrupt and was moved aside; defaults were regenerated.",
	})
	if err := s.Save(defaults); err != nil {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Code:     "preferences_regenerate_failed",
			Severity: "warning",
			Message:  fmt.Sprintf("Could not regenerate default preferences: %v", err),
		})
	}
	return defaults, result
}

func Default() Preferences {
	return Preferences{
		Version: SchemaVersion,
		Theme:   "auto",
		Keymap: KeymapPreferences{
			ContextMenu: []string{"ctrl+z", "ctrl+o"},
		},
		Panes: PanePreferences{
			Pinned: []string{},
			Hidden: []string{},
			Order:  []string{},
			Colors: map[string]string{},
		},
		Assistant: AssistantPreference{
			BarColor:             "default",
			HistoryRetentionDays: 30,
			Provider:             assistant.DefaultProviderConfig(),
		},
		Layout: LayoutPreferences{
			LastPage: 0,
			Density:  "compact",
		},
	}
}

func Sanitize(preferences Preferences) Preferences {
	defaults := Default()
	preferences.Theme = sanitizeString(preferences.Theme, defaults.Theme)
	preferences.Keymap.ContextMenu = sanitizeList(preferences.Keymap.ContextMenu)
	preferences.Panes.Pinned = sanitizeList(preferences.Panes.Pinned)
	preferences.Panes.Hidden = sanitizeList(preferences.Panes.Hidden)
	preferences.Panes.Order = sanitizeList(preferences.Panes.Order)
	preferences.Panes.Colors = sanitizeMap(preferences.Panes.Colors)
	preferences.Assistant.BarColor = sanitizeString(preferences.Assistant.BarColor, defaults.Assistant.BarColor)
	preferences.Assistant.Provider = assistant.SanitizeProviderConfig(preferences.Assistant.Provider)
	preferences.Layout.Density = sanitizeString(preferences.Layout.Density, defaults.Layout.Density)
	return preferences
}

func migrate(raw []byte) (Preferences, error) {
	var envelope struct {
		Version *int `json:"version"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return Preferences{}, err
	}
	if envelope.Version != nil && *envelope.Version > SchemaVersion {
		return Preferences{}, fmt.Errorf("unsupported preference schema version %d", *envelope.Version)
	}

	var partial Preferences
	if err := json.Unmarshal(raw, &partial); err != nil {
		return Preferences{}, err
	}
	if envelope.Version == nil || *envelope.Version == 0 {
		partial.Version = SchemaVersion
	}
	return normalize(partial), nil
}

func normalize(preferences Preferences) Preferences {
	defaults := Default()
	preferences.Version = SchemaVersion
	preferences.Theme = oneOf(preferences.Theme, []string{"auto", "light", "dark"}, defaults.Theme)
	preferences.Keymap.ContextMenu = normalizeContextMenu(preferences.Keymap.ContextMenu)
	preferences.Panes.Pinned = uniqueSorted(preferences.Panes.Pinned)
	preferences.Panes.Hidden = uniqueSorted(preferences.Panes.Hidden)
	preferences.Panes.Order = uniquePreserveOrder(preferences.Panes.Order)
	if preferences.Panes.Colors == nil {
		preferences.Panes.Colors = map[string]string{}
	}
	preferences.Assistant.BarColor = normalizeColor(preferences.Assistant.BarColor, defaults.Assistant.BarColor)
	if preferences.Assistant.HistoryRetentionDays <= 0 || preferences.Assistant.HistoryRetentionDays > 365 {
		preferences.Assistant.HistoryRetentionDays = defaults.Assistant.HistoryRetentionDays
	}
	preferences.Assistant.Provider = assistant.NormalizeProviderConfig(preferences.Assistant.Provider)
	preferences.Layout.LastPage = maxInt(0, preferences.Layout.LastPage)
	preferences.Layout.Density = oneOf(preferences.Layout.Density, []string{"compact", "comfortable"}, defaults.Layout.Density)
	return preferences
}

func normalizeContextMenu(keys []string) []string {
	if len(keys) == 0 {
		return append([]string(nil), Default().Keymap.ContextMenu...)
	}
	normalized := uniquePreserveOrder(keys)
	if len(normalized) == 0 {
		return append([]string(nil), Default().Keymap.ContextMenu...)
	}
	return normalized
}

func sanitizeString(value string, fallback string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback
	}
	if secretPattern.MatchString(trimmed) {
		return fallback
	}
	return trimmed
}

func sanitizeList(values []string) []string {
	result := []string{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || secretPattern.MatchString(trimmed) {
			continue
		}
		result = append(result, trimmed)
	}
	return result
}

func sanitizeMap(values map[string]string) map[string]string {
	result := map[string]string{}
	for key, value := range values {
		cleanKey := strings.TrimSpace(key)
		cleanValue := strings.TrimSpace(value)
		if cleanKey == "" || cleanValue == "" {
			continue
		}
		if secretPattern.MatchString(cleanKey) || secretPattern.MatchString(cleanValue) {
			continue
		}
		result[cleanKey] = cleanValue
	}
	return result
}

func uniqueSorted(values []string) []string {
	result := uniquePreserveOrder(values)
	sort.Strings(result)
	return result
}

func uniquePreserveOrder(values []string) []string {
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
	return result
}

func oneOf(value string, allowed []string, fallback string) string {
	trimmed := strings.TrimSpace(value)
	for _, option := range allowed {
		if trimmed == option {
			return trimmed
		}
	}
	return fallback
}

func normalizeColor(value string, fallback string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback
	}
	if trimmed == "default" {
		return trimmed
	}
	if strings.HasPrefix(trimmed, "#") && (len(trimmed) == 4 || len(trimmed) == 7) {
		return trimmed
	}
	return fallback
}

func syncDirectory(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}
