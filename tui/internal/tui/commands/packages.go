package commands

import (
	"context"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/cameloo/relaybase/tui/internal/relaybaseclient"
)

const (
	packageRunPollDelay          = 350 * time.Millisecond
	packageRunPollMaxBackoffStep = 4
)

type AppPackagesLoadedMsg struct {
	Packages []relaybaseclient.AppPackageDefinition
}

type AppPackagesFailedMsg struct{ Err error }

type AppPackageCreatedMsg struct {
	Package *relaybaseclient.AppPackageDefinition
}

type AppPackageCreateFailedMsg struct{ Err error }

type AppPackageDeletedMsg struct {
	Package *relaybaseclient.AppPackageDefinition
}

type AppPackageDeleteFailedMsg struct{ Err error }

type AppPackageChangePreviewedMsg struct {
	PackageID string
	Preview   *relaybaseclient.AppPackageChangePreview
}

type AppPackageChangePreviewFailedMsg struct {
	PackageID string
	Err       error
}

type AppPackageChangedMsg struct {
	PackageID string
	Result    *relaybaseclient.AppPackageChangeResult
}

type AppPackageChangeFailedMsg struct {
	PackageID string
	Err       error
}

type AppPackageDeletePreviewedMsg struct {
	PackageID string
	Preview   *relaybaseclient.AppPackageDeletePreview
}

type AppPackageDeletePreviewFailedMsg struct {
	PackageID string
	Err       error
}

type AppPackageDeleteAppliedMsg struct {
	PackageID string
	Result    *relaybaseclient.AppPackageDeleteResult
}

type AppPackageDeleteApplyFailedMsg struct {
	PackageID string
	Err       error
}

type AppPackageRunStartedMsg struct {
	Run    *relaybaseclient.AppPackageRun
	Action string
}

type AppPackageRunStartFailedMsg struct {
	Action string
	Err    error
}

type AppPackageRunLoadedMsg struct {
	Run     *relaybaseclient.AppPackageRun
	Attempt int
}

type AppPackageRunLoadFailedMsg struct {
	RunID   string
	Attempt int
	Err     error
}

func ListAppPackagesCmd(ctx context.Context, client *relaybaseclient.Client) tea.Cmd {
	return func() tea.Msg {
		packages, err := client.ListAppPackages(ctx)
		if err != nil {
			return AppPackagesFailedMsg{Err: err}
		}
		return AppPackagesLoadedMsg{Packages: packages}
	}
}

func CreateAppPackageCmd(ctx context.Context, client *relaybaseclient.Client, name string, members []string) tea.Cmd {
	return func() tea.Msg {
		definition, err := client.CreateAppPackage(ctx, name, members)
		if err != nil {
			return AppPackageCreateFailedMsg{Err: err}
		}
		return AppPackageCreatedMsg{Package: definition}
	}
}

func DeleteAppPackageCmd(ctx context.Context, client *relaybaseclient.Client, packageID string) tea.Cmd {
	return func() tea.Msg {
		definition, err := client.DeleteAppPackage(ctx, packageID)
		if err != nil {
			return AppPackageDeleteFailedMsg{Err: err}
		}
		return AppPackageDeletedMsg{Package: definition}
	}
}

func PreviewAppPackageChangeCmd(
	ctx context.Context,
	client *relaybaseclient.Client,
	packageID string,
	expectedRevision int,
	change relaybaseclient.AppPackageChange,
) tea.Cmd {
	return func() tea.Msg {
		preview, err := client.PreviewAppPackageChange(ctx, packageID, expectedRevision, change)
		if err != nil {
			return AppPackageChangePreviewFailedMsg{PackageID: packageID, Err: err}
		}
		return AppPackageChangePreviewedMsg{PackageID: packageID, Preview: preview}
	}
}

func ApplyAppPackageChangeCmd(ctx context.Context, client *relaybaseclient.Client, packageID string, previewID string) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ApplyAppPackageChange(ctx, packageID, previewID)
		if err != nil {
			return AppPackageChangeFailedMsg{PackageID: packageID, Err: err}
		}
		return AppPackageChangedMsg{PackageID: packageID, Result: result}
	}
}

func PreviewAppPackageDeleteCmd(ctx context.Context, client *relaybaseclient.Client, packageID string, expectedRevision int) tea.Cmd {
	return func() tea.Msg {
		preview, err := client.PreviewAppPackageDelete(ctx, packageID, expectedRevision)
		if err != nil {
			return AppPackageDeletePreviewFailedMsg{PackageID: packageID, Err: err}
		}
		return AppPackageDeletePreviewedMsg{PackageID: packageID, Preview: preview}
	}
}

func ApplyAppPackageDeleteCmd(ctx context.Context, client *relaybaseclient.Client, packageID string, previewID string) tea.Cmd {
	return func() tea.Msg {
		result, err := client.ApplyAppPackageDelete(ctx, packageID, previewID)
		if err != nil {
			return AppPackageDeleteApplyFailedMsg{PackageID: packageID, Err: err}
		}
		return AppPackageDeleteAppliedMsg{PackageID: packageID, Result: result}
	}
}

func LaunchAppPackageCmd(ctx context.Context, client *relaybaseclient.Client, packageID string) tea.Cmd {
	return appPackageRunActionCmd(ctx, "launch", func() (*relaybaseclient.AppPackageRun, error) {
		return client.LaunchAppPackage(ctx, packageID)
	})
}

func RetryAppPackageRunCmd(ctx context.Context, client *relaybaseclient.Client, runID string) tea.Cmd {
	return appPackageRunActionCmd(ctx, "retry", func() (*relaybaseclient.AppPackageRun, error) {
		return client.RetryAppPackageRun(ctx, runID)
	})
}

func AbortAppPackageRunCmd(ctx context.Context, client *relaybaseclient.Client, runID string) tea.Cmd {
	return appPackageRunActionCmd(ctx, "abort", func() (*relaybaseclient.AppPackageRun, error) {
		return client.AbortAppPackageRun(ctx, runID)
	})
}

func PollAppPackageRunCmd(ctx context.Context, client *relaybaseclient.Client, runID string, attempt int) tea.Cmd {
	return func() tea.Msg {
		backoffStep := minInt(maxInt(attempt, 0), packageRunPollMaxBackoffStep)
		timer := time.NewTimer(packageRunPollDelay * time.Duration(1<<backoffStep))
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return AppPackageRunLoadFailedMsg{RunID: runID, Attempt: attempt, Err: ctx.Err()}
		case <-timer.C:
		}
		run, err := client.GetAppPackageRun(ctx, runID)
		if err != nil {
			return AppPackageRunLoadFailedMsg{RunID: runID, Attempt: attempt, Err: err}
		}
		return AppPackageRunLoadedMsg{Run: run, Attempt: attempt}
	}
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func appPackageRunActionCmd(ctx context.Context, action string, run func() (*relaybaseclient.AppPackageRun, error)) tea.Cmd {
	return func() tea.Msg {
		result, err := run()
		if err != nil {
			return AppPackageRunStartFailedMsg{Action: action, Err: err}
		}
		return AppPackageRunStartedMsg{Run: result, Action: action}
	}
}
