package usage

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/cameloo/relaybase/tui/internal/tui/response"
)

func Render(data Snapshot, width int, now time.Time) string {
	if width < 44 && (data.Status == StatusReady || data.Status == StatusStale) && data.Usage != nil && data.Usage.LastRequest != nil {
		return renderCompact(data, width, now)
	}
	lines := []string{"Usage", ""}
	switch data.Status {
	case StatusLoading:
		lines = append(lines, "Loading recorded usage…")
	case StatusError:
		lines = append(lines, "Usage is unavailable.", compactError(data.Error))
	case StatusEmpty:
		lines = append(lines, "No completed model usage yet.", "The configured model has not completed a request in this thread.")
	default:
		if data.Usage == nil || data.Usage.LastRequest == nil {
			lines = append(lines, "No completed model usage yet.")
			break
		}
		last := data.Usage.LastRequest
		lines = append(lines,
			"Last request",
			row("Model", middleEllipsis(last.ModelSlug, max(12, width-12))),
			row("Tokens", fmt.Sprintf("%s in · %s out · %s total", group(last.Tokens.Input), group(last.Tokens.Output), group(last.Tokens.Total))),
			row("Cost", formatCost(last.Cost.USD, last.Cost.Source)),
			"",
			"Active thread",
			row("Tokens", group(data.Usage.ThreadTotals.Tokens.Total)+" total"),
			row("Cost", formatTotalCost(data.Usage.ThreadTotals.Cost.KnownUSD, data.Usage.ThreadTotals.Cost.Sources, data.Usage.ThreadTotals.Cost.UnavailableRequestCount)),
			row("Updated", formatUpdated(data.Usage.UpdatedAt, now)),
		)
		if data.Status == StatusStale {
			lines = append(lines, "Stale: refresh failed · "+compactError(data.Error))
		}
	}
	lines = append(lines, "", "Esc close · R refresh")
	return response.SanitizeTerminalText(strings.Join(lines, "\n"))
}

func renderCompact(data Snapshot, width int, now time.Time) string {
	last := data.Usage.LastRequest
	title := "Usage"
	if data.Status == StatusStale {
		title += " · stale"
	}
	threadCost, threadSource := totalCostParts(
		data.Usage.ThreadTotals.Cost.KnownUSD,
		data.Usage.ThreadTotals.Cost.Sources,
		data.Usage.ThreadTotals.Cost.UnavailableRequestCount,
	)
	lines := []string{
		title,
		"Last request",
		"Model " + middleEllipsis(last.ModelSlug, max(8, width-6)),
		fmt.Sprintf("In %s · Out %s", group(last.Tokens.Input), group(last.Tokens.Output)),
		"Total " + group(last.Tokens.Total),
		"Cost " + formatCost(last.Cost.USD, last.Cost.Source),
		"Active thread",
		"Tokens " + group(data.Usage.ThreadTotals.Tokens.Total) + " total",
		"Cost " + threadCost,
		"Source " + threadSource,
		"Updated " + compactUpdated(data.Usage.UpdatedAt, now),
		"Esc close · R refresh",
	}
	return response.SanitizeTerminalText(strings.Join(lines, "\n"))
}

func row(label, value string) string { return fmt.Sprintf("%-10s%s", label, value) }
func group(value int64) string {
	s := strconv.FormatInt(value, 10)
	start := 0
	if strings.HasPrefix(s, "-") {
		start = 1
	}
	for index := len(s) - 3; index > start; index -= 3 {
		s = s[:index] + "," + s[index:]
	}
	return s
}
func formatCost(value *string, source string) string {
	if value == nil {
		return "unavailable"
	}
	return displayUSD(*value) + " " + costSource(source)
}
func formatTotalCost(value string, sources []string, missing int64) string {
	cost, source := totalCostParts(value, sources, missing)
	return cost + " " + source
}
func totalCostParts(value string, sources []string, missing int64) (string, string) {
	label := "unavailable"
	if len(sources) > 0 {
		labels := make([]string, len(sources))
		for i, v := range sources {
			labels[i] = costSource(v)
		}
		label = strings.Join(labels, " + ")
	}
	if missing > 0 {
		label += " · partial"
	}
	return displayUSD(value), label
}
func costSource(source string) string {
	if strings.TrimSpace(source) == "" {
		return "unavailable"
	}
	return strings.ReplaceAll(source, "provider_reported", "reported")
}
func displayUSD(value string) string {
	parts := strings.SplitN(value, ".", 2)
	if len(parts) == 1 {
		return "$" + parts[0]
	}
	fraction := parts[1]
	if len(fraction) > 6 {
		fraction = fraction[:6]
	}
	fraction = strings.TrimRight(fraction, "0")
	if parts[0] == "0" && fraction == "" && strings.Trim(parts[1], "0") != "" {
		return "<$0.000001"
	}
	if fraction == "" {
		return "$" + parts[0]
	}
	return "$" + parts[0] + "." + fraction
}
func formatUpdated(value *string, now time.Time) string {
	if value == nil {
		return "unavailable"
	}
	parsed, err := time.Parse(time.RFC3339, *value)
	if err != nil {
		return "unavailable"
	}
	age := now.Sub(parsed)
	relative := "just now"
	if age >= time.Minute {
		relative = fmt.Sprintf("%d minutes ago", int(age.Minutes()))
	} else if age >= time.Second {
		relative = fmt.Sprintf("%d seconds ago", int(age.Seconds()))
	}
	return parsed.Local().Format("3:04 PM") + " · " + relative
}
func compactUpdated(value *string, now time.Time) string {
	formatted := formatUpdated(value, now)
	formatted = strings.ReplaceAll(formatted, " seconds ago", "s ago")
	formatted = strings.ReplaceAll(formatted, " minutes ago", "m ago")
	return formatted
}
func middleEllipsis(value string, width int) string {
	if width < 5 || len([]rune(value)) <= width {
		return value
	}
	r := []rune(value)
	left := (width - 1) / 2
	right := width - 1 - left
	return string(r[:left]) + "…" + string(r[len(r)-right:])
}
func compactError(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len(value) > 80 {
		return value[:79] + "…"
	}
	return value
}
