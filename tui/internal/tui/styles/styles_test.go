package styles

import (
	"fmt"
	"image/color"
	"math"
	"reflect"
	"testing"
)

func TestThemeFallbackForUnsupportedTerminal(t *testing.T) {
	env := map[string]string{
		"TERM":     "dumb",
		"NO_COLOR": "1",
	}
	theme, diagnostics := ResolveTheme("auto", func(key string) string { return env[key] })

	if theme.Mode != "dark" {
		t.Fatalf("expected dark fallback, got %s", theme.Mode)
	}
	if len(diagnostics) == 0 || diagnostics[0].Code != "terminal_color_fallback" {
		t.Fatalf("expected terminal_color_fallback diagnostic, got %#v", diagnostics)
	}
}

func TestThemeCatalogUsesStableSelectionOrderAndReturnsCopies(t *testing.T) {
	want := []string{
		"auto",
		"light",
		"dark",
		"terminal-green",
		"code-blue",
		"pure-black",
		"amber-crt",
		"arctic-slate",
		"plum-night",
	}
	if got := ThemeIDs(); !reflect.DeepEqual(got, want) {
		t.Fatalf("theme IDs = %#v, want %#v", got, want)
	}

	options := ThemeOptions()
	options[0].ID = "changed"
	if ThemeOptions()[0].ID != "auto" {
		t.Fatal("ThemeOptions exposed mutable catalog state")
	}
}

func TestCustomThemePalettesMatchApprovedColors(t *testing.T) {
	tests := []struct {
		id         string
		name       string
		background string
		text       string
		border     string
		muted      string
		accent     string
	}{
		{id: "terminal-green", name: "Terminal Green", background: "#050805", text: "#55ff55", border: "#1fc742", muted: "#2fb344", accent: "#7cff6b"},
		{id: "code-blue", name: "Code Blue", background: "#1e1e1e", text: "#d4d4d4", border: "#3d6f96", muted: "#9da5b4", accent: "#4fc1ff"},
		{id: "pure-black", name: "Pure Black", background: "#000000", text: "#f2f2f2", border: "#3a3a3a", muted: "#a0a0a0", accent: "#ffffff"},
		{id: "amber-crt", name: "Amber CRT", background: "#100b00", text: "#ffbf00", border: "#7a5000", muted: "#c18f28", accent: "#ffd166"},
		{id: "arctic-slate", name: "Arctic Slate", background: "#222832", text: "#dce3ec", border: "#53657a", muted: "#9aa8ba", accent: "#88c0d0"},
		{id: "plum-night", name: "Plum Night", background: "#19131f", text: "#e9e0f0", border: "#684c78", muted: "#aa9aaf", accent: "#c792ea"},
	}

	dark, _ := ResolveTheme("dark", nil)
	for _, test := range tests {
		t.Run(test.id, func(t *testing.T) {
			theme, diagnostics := ResolveTheme(test.id, nil)
			if len(diagnostics) != 0 {
				t.Fatalf("unexpected diagnostics: %#v", diagnostics)
			}
			if theme.Mode != test.id || theme.Name != test.name {
				t.Fatalf("resolved identity = %q/%q, want %q/%q", theme.Mode, theme.Name, test.id, test.name)
			}
			assertColorString(t, "background", theme.Background, test.background)
			assertColorString(t, "text", theme.Text, test.text)
			assertColorString(t, "border", theme.Border, test.border)
			assertColorString(t, "muted", theme.Muted, test.muted)
			assertColorString(t, "accent", theme.Accent, test.accent)

			for _, semantic := range []struct {
				name string
				got  color.Color
				want color.Color
			}{
				{name: "success", got: theme.Success, want: dark.Success},
				{name: "warning", got: theme.Warning, want: dark.Warning},
				{name: "error", got: theme.Error, want: dark.Error},
			} {
				if colorHex(semantic.got) != colorHex(semantic.want) {
					t.Fatalf("%s color changed: got %v want %v", semantic.name, semantic.got, semantic.want)
				}
			}

			if ratio := contrastRatio(theme.Text, theme.Background); ratio < 4.5 {
				t.Fatalf("main text contrast %.2f is below 4.5", ratio)
			}
			if ratio := contrastRatio(theme.Muted, theme.Background); ratio < 4.5 {
				t.Fatalf("muted text contrast %.2f is below 4.5", ratio)
			}
			if ratio := contrastRatio(theme.Accent, theme.Background); ratio < 4.5 {
				t.Fatalf("accent text contrast %.2f is below 4.5", ratio)
			}
		})
	}
}

func TestUnknownThemeStillFallsBackToRelaybaseLight(t *testing.T) {
	theme, diagnostics := ResolveTheme("unknown", nil)
	if theme.Mode != "light" || theme.Name != "Relaybase Light" {
		t.Fatalf("unknown theme fallback = %#v", theme)
	}
	if len(diagnostics) != 1 || diagnostics[0].Code != "theme_mode_unknown" {
		t.Fatalf("unknown theme diagnostics = %#v", diagnostics)
	}
}

func assertColorString(t *testing.T, name string, got color.Color, want string) {
	t.Helper()
	if value := colorHex(got); value != want {
		t.Fatalf("%s = %s, want %s", name, value, want)
	}
}

func colorHex(value color.Color) string {
	r, g, b, _ := value.RGBA()
	return fmt.Sprintf("#%02x%02x%02x", r>>8, g>>8, b>>8)
}

func contrastRatio(foreground color.Color, background color.Color) float64 {
	light := relativeLuminance(foreground)
	dark := relativeLuminance(background)
	if light < dark {
		light, dark = dark, light
	}
	return (light + 0.05) / (dark + 0.05)
}

func relativeLuminance(value color.Color) float64 {
	r, g, b, _ := value.RGBA()
	return 0.2126*linearChannel(r) + 0.7152*linearChannel(g) + 0.0722*linearChannel(b)
}

func linearChannel(value uint32) float64 {
	channel := float64(value) / 65535
	if channel <= 0.04045 {
		return channel / 12.92
	}
	return math.Pow((channel+0.055)/1.055, 2.4)
}
