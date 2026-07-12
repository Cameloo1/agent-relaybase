package keymap

import (
	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
)

type KeyMap struct {
	Up              key.Binding
	Down            key.Binding
	Left            key.Binding
	Right           key.Binding
	PageUp          key.Binding
	PageDown        key.Binding
	Home            key.Binding
	End             key.Binding
	Enter           key.Binding
	Escape          key.Binding
	Follow          key.Binding
	Slash           key.Binding
	ContextualMenu  key.Binding
	ContextFallback key.Binding
	Help            key.Binding
	Diagnostics     key.Binding
	Tab             key.Binding
	CopyLogs        key.Binding
	Quit            key.Binding
}

func Default() KeyMap {
	return WithContextMenu([]string{"ctrl+z", "ctrl+o"})
}

func WithContextMenu(contextMenu []string) KeyMap {
	contextual := "ctrl+z"
	fallback := "ctrl+o"
	if len(contextMenu) > 0 && contextMenu[0] != "" {
		contextual = contextMenu[0]
	}
	if len(contextMenu) > 1 && contextMenu[1] != "" {
		fallback = contextMenu[1]
	}
	fallbackKeys := []string{fallback}
	if fallback != "ctrl+o" {
		fallbackKeys = append(fallbackKeys, "ctrl+o")
	}
	fallbackHelp := fallback
	if fallback != "ctrl+o" {
		fallbackHelp = fallback + "/ctrl+o"
	}
	return KeyMap{
		Up:              key.NewBinding(key.WithKeys("up"), key.WithHelp("up", "pane up")),
		Down:            key.NewBinding(key.WithKeys("down"), key.WithHelp("down", "pane down")),
		Left:            key.NewBinding(key.WithKeys("left"), key.WithHelp("left", "pane left")),
		Right:           key.NewBinding(key.WithKeys("right"), key.WithHelp("right", "pane right")),
		PageUp:          key.NewBinding(key.WithKeys("pgup"), key.WithHelp("pgup", "previous page")),
		PageDown:        key.NewBinding(key.WithKeys("pgdown"), key.WithHelp("pgdn", "next page")),
		Home:            key.NewBinding(key.WithKeys("home"), key.WithHelp("home", "top")),
		End:             key.NewBinding(key.WithKeys("end"), key.WithHelp("end", "bottom")),
		Enter:           key.NewBinding(key.WithKeys("enter"), key.WithHelp("enter", "focus pane")),
		Escape:          key.NewBinding(key.WithKeys("esc"), key.WithHelp("esc", "dashboard")),
		Follow:          key.NewBinding(key.WithKeys("f"), key.WithHelp("f", "follow")),
		Slash:           key.NewBinding(key.WithKeys("/"), key.WithHelp("/", "command")),
		ContextualMenu:  key.NewBinding(key.WithKeys(contextual), key.WithHelp(contextual, "menu")),
		ContextFallback: key.NewBinding(key.WithKeys(fallbackKeys...), key.WithHelp(fallbackHelp, "menu")),
		Help:            key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "help")),
		Diagnostics:     key.NewBinding(key.WithKeys("ctrl+d"), key.WithHelp("ctrl+d", "diagnostics")),
		Tab:             key.NewBinding(key.WithKeys("tab"), key.WithHelp("tab", "complete")),
		CopyLogs:        key.NewBinding(key.WithKeys("c"), key.WithHelp("c", "copy 20 logs")),
		Quit:            key.NewBinding(key.WithKeys("q", "ctrl+c"), key.WithHelp("q/ctrl+c", "quit")),
	}
}

func (k KeyMap) ShortHelp() []key.Binding {
	return []key.Binding{k.Help, k.Quit}
}

func (k KeyMap) FullHelp() []key.Binding {
	return []key.Binding{
		k.Up,
		k.Down,
		k.Left,
		k.Right,
		k.PageUp,
		k.PageDown,
		k.Home,
		k.End,
		k.Enter,
		k.Escape,
		k.Follow,
		k.Slash,
		k.ContextualMenu,
		k.ContextFallback,
		k.Help,
		k.Diagnostics,
		k.Tab,
		k.CopyLogs,
		k.Quit,
	}
}

func Matches(msg tea.KeyPressMsg, binding key.Binding) bool {
	return key.Matches(msg, binding)
}
