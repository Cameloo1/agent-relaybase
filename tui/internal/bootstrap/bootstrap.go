package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

type DaemonResult struct {
	Reachable    bool     `json:"reachable"`
	Started      bool     `json:"started"`
	Code         string   `json:"code"`
	UserAction   string   `json:"userAction"`
	PID          int      `json:"pid,omitempty"`
	LogPath      string   `json:"logPath,omitempty"`
	PIDPath      string   `json:"pidPath,omitempty"`
	MetadataPath string   `json:"metadataPath,omitempty"`
	ExitCode     *int     `json:"exitCode,omitempty"`
	Signal       string   `json:"signal,omitempty"`
	Error        string   `json:"error,omitempty"`
	LogTail      []string `json:"logTail,omitempty"`
}

type responseBody struct {
	Daemon DaemonResult `json:"daemon"`
}

func New(baseURL string, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		token:   strings.TrimSpace(token),
		http:    httpClient,
	}
}

func (c *Client) Available() bool {
	return c != nil && c.baseURL != "" && c.token != ""
}

func (c *Client) Status(ctx context.Context) (*DaemonResult, error) {
	return c.request(ctx, http.MethodGet, "/daemon/status")
}

func (c *Client) Ensure(ctx context.Context) (*DaemonResult, error) {
	return c.request(ctx, http.MethodPost, "/daemon/ensure")
}

func DecodeReport(raw string) (*DaemonResult, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var result DaemonResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) request(ctx context.Context, method string, path string) (*DaemonResult, error) {
	if !c.Available() {
		return nil, fmt.Errorf("local daemon bootstrap bridge is unavailable")
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(nil))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("bootstrap bridge returned %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	var decoded responseBody
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	return &decoded.Daemon, nil
}
