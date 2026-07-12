package relaybaseclient

import "context"

type AgentUsageResponse struct {
	Agent struct {
		Usage AgentUsageSnapshot `json:"usage"`
	} `json:"agent"`
}

type AgentUsageSnapshot struct {
	Scope        string                 `json:"scope"`
	SessionID    *string                `json:"sessionId"`
	LastRequest  *AgentUsageLastRequest `json:"lastRequest"`
	ThreadTotals AgentUsageTotals       `json:"threadTotals"`
	UpdatedAt    *string                `json:"updatedAt"`
}

type AgentUsageLastRequest struct {
	RunID       string           `json:"runId"`
	ModelSlug   string           `json:"modelSlug"`
	Provider    string           `json:"provider"`
	CompletedAt string           `json:"completedAt"`
	Tokens      AgentUsageTokens `json:"tokens"`
	Cost        AgentUsageCost   `json:"cost"`
}

type AgentUsageTokens struct {
	Input       int64  `json:"input"`
	Output      int64  `json:"output"`
	Total       int64  `json:"total"`
	TotalSource string `json:"totalSource,omitempty"`
}

type AgentUsageCost struct {
	USD    *string `json:"usd"`
	Source string  `json:"source"`
}

type AgentUsageTotals struct {
	RequestCount int64            `json:"requestCount"`
	Tokens       AgentUsageTokens `json:"tokens"`
	Cost         struct {
		KnownUSD                string   `json:"knownUsd"`
		KnownRequestCount       int64    `json:"knownRequestCount"`
		UnavailableRequestCount int64    `json:"unavailableRequestCount"`
		Sources                 []string `json:"sources"`
	} `json:"cost"`
}

func (c *Client) GetActiveAgentUsage(ctx context.Context) (*AgentUsageSnapshot, error) {
	var response AgentUsageResponse
	if _, err := c.getJSON(ctx, "/__hub/api/agent/usage?scope=active-thread", &response); err != nil {
		return nil, err
	}
	return &response.Agent.Usage, nil
}
