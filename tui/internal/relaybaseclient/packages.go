package relaybaseclient

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

type AppPackageDefinition struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	NormalizedName string         `json:"normalizedName,omitempty"`
	MemberAppIDs   []string       `json:"memberAppIds"`
	Revision       int            `json:"revision"`
	CreatedAt      string         `json:"createdAt,omitempty"`
	UpdatedAt      string         `json:"updatedAt,omitempty"`
	LastRun        *AppPackageRun `json:"lastRun,omitempty"`
}

type AppPackageRunMember struct {
	Ordinal              int    `json:"ordinal"`
	AppID                string `json:"appId"`
	State                string `json:"state"`
	LifecycleOperationID string `json:"lifecycleOperationId,omitempty"`
	ErrorCode            string `json:"errorCode,omitempty"`
	ErrorMessage         string `json:"errorMessage,omitempty"`
	Retryable            bool   `json:"retryable,omitempty"`
	StartedAt            string `json:"startedAt,omitempty"`
	FinishedAt           string `json:"finishedAt,omitempty"`
}

type AppPackageRun struct {
	ID              string                `json:"id"`
	PackageID       string                `json:"packageId"`
	PackageName     string                `json:"packageName"`
	PackageRevision int                   `json:"packageRevision"`
	Status          string                `json:"status"`
	AbortRequested  bool                  `json:"abortRequested"`
	RetryOfRunID    string                `json:"retryOfRunId,omitempty"`
	CreatedAt       string                `json:"createdAt,omitempty"`
	StartedAt       string                `json:"startedAt,omitempty"`
	UpdatedAt       string                `json:"updatedAt,omitempty"`
	FinishedAt      string                `json:"finishedAt,omitempty"`
	Members         []AppPackageRunMember `json:"members"`
}

func (r AppPackageRun) Terminal() bool {
	return r.Status != "" && r.Status != "queued" && r.Status != "running"
}

func (c *Client) ListAppPackages(ctx context.Context) ([]AppPackageDefinition, error) {
	var response struct {
		Packages []AppPackageDefinition `json:"packages"`
	}
	if _, err := c.getJSON(ctx, "/__hub/api/packages", &response); err != nil {
		return nil, err
	}
	return response.Packages, nil
}

func (c *Client) CreateAppPackage(ctx context.Context, name string, members []string) (*AppPackageDefinition, error) {
	var response struct {
		Package AppPackageDefinition `json:"package"`
	}
	if _, err := c.postJSON(ctx, "/__hub/api/packages", map[string]any{"name": name, "members": members}, &response); err != nil {
		return nil, err
	}
	return &response.Package, nil
}

func (c *Client) DeleteAppPackage(ctx context.Context, packageID string) (*AppPackageDefinition, error) {
	var response struct {
		Package AppPackageDefinition `json:"package"`
	}
	path := fmt.Sprintf("/__hub/api/packages/%s", url.PathEscape(packageID))
	if _, err := c.writeJSON(ctx, http.MethodDelete, path, nil, &response); err != nil {
		return nil, err
	}
	return &response.Package, nil
}

func (c *Client) LaunchAppPackage(ctx context.Context, packageID string) (*AppPackageRun, error) {
	return c.writeAppPackageRun(ctx, fmt.Sprintf("/__hub/api/packages/%s/launch", url.PathEscape(packageID)))
}

func (c *Client) GetAppPackageRun(ctx context.Context, runID string) (*AppPackageRun, error) {
	var response struct {
		Run AppPackageRun `json:"run"`
	}
	path := fmt.Sprintf("/__hub/api/package-runs/%s", url.PathEscape(runID))
	if _, err := c.getJSON(ctx, path, &response); err != nil {
		return nil, err
	}
	return &response.Run, nil
}

func (c *Client) RetryAppPackageRun(ctx context.Context, runID string) (*AppPackageRun, error) {
	return c.writeAppPackageRun(ctx, fmt.Sprintf("/__hub/api/package-runs/%s/retry", url.PathEscape(runID)))
}

func (c *Client) AbortAppPackageRun(ctx context.Context, runID string) (*AppPackageRun, error) {
	return c.writeAppPackageRun(ctx, fmt.Sprintf("/__hub/api/package-runs/%s/abort", url.PathEscape(runID)))
}

func (c *Client) writeAppPackageRun(ctx context.Context, path string) (*AppPackageRun, error) {
	var response struct {
		Run AppPackageRun `json:"run"`
	}
	if _, err := c.postJSON(ctx, path, map[string]any{}, &response); err != nil {
		return nil, err
	}
	return &response.Run, nil
}
