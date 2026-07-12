package model

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
	"github.com/cameloo/relaybase/tui/internal/tui/assistant"
)

func (m *RootModel) upsertAppPackage(definition relaybaseclient.AppPackageDefinition) {
	definition.MemberAppIDs = append([]string(nil), definition.MemberAppIDs...)
	for index := range m.appPackages {
		if m.appPackages[index].ID == definition.ID {
			m.appPackages[index] = definition
			return
		}
	}
	m.appPackages = append(m.appPackages, definition)
	sort.SliceStable(m.appPackages, func(left, right int) bool {
		return strings.ToLower(m.appPackages[left].Name) < strings.ToLower(m.appPackages[right].Name)
	})
}

func (m *RootModel) removeAppPackage(id string) {
	kept := m.appPackages[:0]
	for _, definition := range m.appPackages {
		if definition.ID != id {
			kept = append(kept, definition)
		}
	}
	m.appPackages = kept
}

func (m RootModel) resolveAppPackage(reference string) (*relaybaseclient.AppPackageDefinition, error) {
	reference = strings.TrimSpace(reference)
	for index := range m.appPackages {
		if m.appPackages[index].ID == reference {
			copy := m.appPackages[index]
			copy.MemberAppIDs = append([]string(nil), copy.MemberAppIDs...)
			return &copy, nil
		}
	}
	matches := []relaybaseclient.AppPackageDefinition{}
	for _, definition := range m.appPackages {
		if strings.EqualFold(strings.TrimSpace(definition.Name), reference) {
			matches = append(matches, definition)
		}
	}
	if len(matches) == 1 {
		copy := matches[0]
		copy.MemberAppIDs = append([]string(nil), copy.MemberAppIDs...)
		return &copy, nil
	}
	if len(matches) > 1 {
		return nil, fmt.Errorf("package name %q is ambiguous; use its package id", reference)
	}
	return nil, fmt.Errorf("package %q was not found; use /packages to refresh saved packages", reference)
}

func appPackageListMessage(definitions []relaybaseclient.AppPackageDefinition, state *relaybaseclient.RelaybaseState) string {
	if len(definitions) == 0 {
		return "No saved app packages. Create one with /create-package {'Registered App','Other App'} 'package-name'."
	}
	items := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		members := make([]string, 0, len(definition.MemberAppIDs))
		for _, appID := range definition.MemberAppIDs {
			members = append(members, appNameForPackage(state, appID))
		}
		last := "never run"
		if definition.LastRun != nil && definition.LastRun.Status != "" {
			last = "last " + definition.LastRun.Status
		}
		items = append(items, fmt.Sprintf("%s (%d: %s; %s)", definition.Name, len(members), strings.Join(members, ", "), last))
	}
	return "Saved packages: " + strings.Join(items, " | ")
}

func appNameForPackage(state *relaybaseclient.RelaybaseState, appID string) string {
	if state != nil {
		for _, app := range state.Apps {
			if app.ID == appID && strings.TrimSpace(app.Name) != "" {
				return app.Name
			}
		}
	}
	return appID
}

func packageRunAcceptedMessage(run relaybaseclient.AppPackageRun, action string) string {
	return fmt.Sprintf("Package %s accepted for %s (%s).", action, run.PackageName, run.ID)
}

func packageRunProgressMessage(run relaybaseclient.AppPackageRun) string {
	pending, active, complete := packageRunCounts(run)
	return fmt.Sprintf("Package %s: %d complete, %d active, %d pending.", run.PackageName, complete, active, pending)
}

func packageRunResultMessage(run relaybaseclient.AppPackageRun) string {
	counts := map[string]int{}
	failed := []string{}
	for _, member := range run.Members {
		counts[member.State]++
		if member.State == "failed" || strings.HasPrefix(member.State, "interrupted") || strings.HasPrefix(member.State, "skipped_") && member.State != "skipped_already_running" {
			failed = append(failed, member.AppID)
		}
	}
	message := fmt.Sprintf(
		"Package %s finished %s: %d started, %d already running, %d failed/skipped.",
		run.PackageName,
		run.Status,
		counts["started"],
		counts["skipped_already_running"],
		len(failed),
	)
	if len(failed) > 0 {
		message += " Review: " + strings.Join(failed, ", ") + "."
	}
	return message
}

func packageRunCounts(run relaybaseclient.AppPackageRun) (pending int, active int, complete int) {
	for _, member := range run.Members {
		switch member.State {
		case "pending":
			pending++
		case "starting":
			active++
		default:
			complete++
		}
	}
	return pending, active, complete
}

func safePackageErrorMessage(err error) string {
	var apiError *relaybaseclient.APIError
	if errors.As(err, &apiError) {
		message := assistant.SanitizeText(apiError.ErrorBody.Message)
		if message != "" {
			if action := assistant.SanitizeText(apiError.ErrorBody.UserAction); action != "" {
				return message + " " + action
			}
			return message
		}
	}
	return "The daemon package request failed; inspect Relaybase diagnostics and retry."
}
