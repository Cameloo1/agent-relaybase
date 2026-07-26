package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	DefaultBaseURL = "http://127.0.0.1:7777"
	DefaultTheme   = "auto"
)

type Config struct {
	BaseURL          string
	StateDir         string
	Token            string
	TokenPath        string
	ThemeMode        string
	CurrentDirectory string
	BootstrapURL     string
	BootstrapToken   string
	BootstrapReport  string
	HTTPTimeout      time.Duration
	tokenFromEnv     bool
}

func Load() Config {
	return LoadWithEnv(os.Getenv)
}

func LoadWithEnv(getenv func(string) string) Config {
	envToken := strings.TrimSpace(getenv("RELAYBASE_TOKEN"))
	cfg := Config{
		BaseURL:          valueOrDefault(getenv("RELAYBASE_URL"), DefaultBaseURL),
		StateDir:         defaultStateDir(getenv),
		Token:            envToken,
		ThemeMode:        valueOrDefault(getenv("RELAYBASE_TUI_THEME"), DefaultTheme),
		CurrentDirectory: valueOrDefault(getenv("RELAYBASE_TUI_CURRENT_DIRECTORY"), currentDirectory()),
		BootstrapURL:     strings.TrimSpace(getenv("RELAYBASE_TUI_BOOTSTRAP_URL")),
		BootstrapToken:   strings.TrimSpace(getenv("RELAYBASE_TUI_BOOTSTRAP_TOKEN")),
		BootstrapReport:  strings.TrimSpace(getenv("RELAYBASE_TUI_BOOTSTRAP_REPORT")),
		HTTPTimeout:      20 * time.Second,
		tokenFromEnv:     envToken != "",
	}
	cfg.TokenPath = filepath.Join(cfg.StateDir, "session-token")
	if cfg.Token == "" {
		cfg.Token = readTokenFile(cfg.TokenPath)
	}
	return cfg
}

func (c *Config) ReloadToken() {
	c.ReloadTokenForStateDir(false)
}

func (c *Config) ReloadTokenForStateDir(preferStateDirToken bool) {
	c.TokenPath = filepath.Join(c.StateDir, "session-token")
	tokenFromStateDir := readTokenFile(c.TokenPath)
	if preferStateDirToken {
		if tokenFromStateDir != "" {
			c.Token = tokenFromStateDir
		} else if !c.tokenFromEnv {
			c.Token = ""
		}
		return
	}
	if strings.TrimSpace(c.Token) == "" {
		c.Token = tokenFromStateDir
	}
}

// ReloadTokenFromDisk refreshes a running TUI after an atomic token rotation.
// It never clears a working in-memory token when the file is temporarily unavailable.
func (c *Config) ReloadTokenFromDisk() bool {
	c.TokenPath = filepath.Join(c.StateDir, "session-token")
	next := readTokenFile(c.TokenPath)
	if next == "" || next == c.Token {
		return false
	}
	c.Token = next
	return true
}

func currentDirectory() string {
	cwd, err := os.Getwd()
	if err != nil {
		return ""
	}
	return cwd
}

func defaultStateDir(getenv func(string) string) string {
	if dir := strings.TrimSpace(getenv("RELAYBASE_STATE_DIR")); dir != "" {
		return dir
	}

	if runtime.GOOS == "windows" {
		if localAppData := strings.TrimSpace(getenv("LOCALAPPDATA")); localAppData != "" {
			return filepath.Join(localAppData, "Relaybase")
		}
	}

	if home := strings.TrimSpace(getenv("HOME")); home != "" {
		return filepath.Join(home, ".relaybase")
	}
	if userProfile := strings.TrimSpace(getenv("USERPROFILE")); userProfile != "" {
		return filepath.Join(userProfile, ".relaybase")
	}
	return ".relaybase"
}

func readTokenFile(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(content))
}

func valueOrDefault(value string, fallback string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fallback
	}
	return trimmed
}
