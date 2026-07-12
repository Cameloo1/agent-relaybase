package model

import (
	"context"
	"errors"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

const clipboardTimeout = 3 * time.Second

var (
	readClipboardText       = readSystemClipboardText
	writeClipboardText      = writeSystemClipboardText
	clipboardWriteAvailable = systemClipboardWriteAvailable
)

func systemClipboardWriteAvailable() bool {
	candidates := []string{}
	switch runtime.GOOS {
	case "windows":
		candidates = []string{"clip.exe"}
	case "darwin":
		candidates = []string{"pbcopy"}
	default:
		candidates = []string{"wl-copy", "xclip", "xsel"}
	}
	for _, candidate := range candidates {
		if _, err := exec.LookPath(candidate); err == nil {
			return true
		}
	}
	return false
}

func readSystemClipboardText() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), clipboardTimeout)
	defer cancel()

	switch runtime.GOOS {
	case "windows":
		return commandOutput(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw")
	case "darwin":
		return commandOutput(ctx, "pbpaste")
	default:
		return firstClipboardOutput(ctx, [][]string{
			{"wl-paste", "--no-newline"},
			{"xclip", "-selection", "clipboard", "-out"},
			{"xsel", "--clipboard", "--output"},
		})
	}
}

func writeSystemClipboardText(text string) error {
	ctx, cancel := context.WithTimeout(context.Background(), clipboardTimeout)
	defer cancel()

	switch runtime.GOOS {
	case "windows":
		return commandInput(ctx, text, "clip.exe")
	case "darwin":
		return commandInput(ctx, text, "pbcopy")
	default:
		return firstClipboardInput(ctx, text, [][]string{
			{"wl-copy"},
			{"xclip", "-selection", "clipboard", "-in"},
			{"xsel", "--clipboard", "--input"},
		})
	}
}

func commandOutput(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(output), nil
}

func commandInput(ctx context.Context, text string, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}

func firstClipboardOutput(ctx context.Context, candidates [][]string) (string, error) {
	var lastErr error
	for _, candidate := range candidates {
		if len(candidate) == 0 {
			continue
		}
		output, err := commandOutput(ctx, candidate[0], candidate[1:]...)
		if err == nil {
			return output, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no clipboard read command is configured for this platform")
	}
	return "", lastErr
}

func firstClipboardInput(ctx context.Context, text string, candidates [][]string) error {
	var lastErr error
	for _, candidate := range candidates {
		if len(candidate) == 0 {
			continue
		}
		err := commandInput(ctx, text, candidate[0], candidate[1:]...)
		if err == nil {
			return nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no clipboard write command is configured for this platform")
	}
	return lastErr
}
