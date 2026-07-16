package views

import (
	"fmt"
	"strings"

	bubblestable "charm.land/bubbles/v2/table"
	"charm.land/lipgloss/v2"

	"github.com/cameloo/relaybase/tui/internal/tui/inventory"
	"github.com/cameloo/relaybase/tui/internal/tui/styles"
)

func renderAppPackagePicker(style styles.Styles, shell ShellData, data AppManagerData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	item := inventory.Item{}
	if data.Selected >= 0 && data.Selected < len(data.Items) {
		item = data.Items[data.Selected]
	}
	table := data.PackagePicker
	if table == nil {
		return fixedRegion(lipgloss.NewStyle(), "Add app to package\nPackage inventory is unavailable.\n\nEsc back", width, height)
	}
	notice := valueOr(cleanInlineText(data.Notice), "Choose a saved package. Adding membership will not start, stop, or restart any app.")
	lines := []string{
		fmt.Sprintf("Add %s to a package — %d saved", cleanInlineText(valueOr(item.Name, item.ID)), len(table.Rows)),
		"Adding membership will not start, stop, or restart any app.",
		truncateText(notice, width),
		"",
		renderPackageTable(style, width, packageTableViewportRows(shell), *table),
		"",
		style.Muted.Render(truncateText("↑/↓ or wheel select • Enter review • N new package • R refresh • Esc back", width)),
	}
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderAppPackageCreate(style styles.Styles, shell ShellData, data AppManagerData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	item := inventory.Item{}
	if data.Selected >= 0 && data.Selected < len(data.Items) {
		item = data.Items[data.Selected]
	}
	lines := []string{
		"Create package for " + cleanInlineText(valueOr(item.Name, item.ID)),
		"The selected app will be the first package member.",
		"",
		"Package name  " + data.PackageNameInput,
		"",
		truncateText(valueOr(cleanInlineText(data.Notice), "Enter creates the saved package; no app will be launched."), width),
		"",
		style.Muted.Render("Enter create • Ctrl+V paste • Esc back"),
	}
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderPackageManagerModal(style styles.Styles, shell ShellData, data PackageManagerData) string {
	switch data.Surface {
	case "actions":
		return renderPackageManagerActions(style, shell, data)
	case "name":
		return renderPackageNameEditor(style, shell, data)
	case "members":
		return renderPackageMembers(style, shell, data)
	case "run":
		return renderPackageRun(style, shell, data)
	}
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	lines := []string{
		fmt.Sprintf("Packages — %d saved", len(data.Table.Rows)),
		packageManagerConnectionLine(data),
		truncateText(valueOr(cleanInlineText(data.Notice), "Saved bundles of registered apps that Relaybase can launch together."), width),
		"",
		renderPackageTable(style, width, packageTableViewportRows(shell), data.Table),
		"",
		style.Muted.Render(truncateText("↑/↓ or wheel select • Enter actions • N new • R refresh • Esc close", width)),
	}
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderPackageManagerActions(style styles.Styles, shell ShellData, data PackageManagerData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	selected := data.SelectedPackage
	if selected == nil {
		return fixedRegion(lipgloss.NewStyle(), "Manage package\nPackage selection is unavailable.\n\nEsc back", width, height)
	}
	lines := []string{"Manage " + cleanInlineText(selected.Name), packageManagerConnectionLine(data)}
	if height < 14 {
		lines = append(lines, truncateText(fmt.Sprintf("Apps %d  |  Revision %d  |  Last run %s", selected.MemberCount, selected.Revision, cleanInlineText(valueOr(selected.LastRun, "never"))), width))
	} else {
		lines = append(lines,
			"",
			"Stable ID   "+cleanInlineText(selected.ID),
			fmt.Sprintf("Apps        %d", selected.MemberCount),
			fmt.Sprintf("Revision    %d", selected.Revision),
			"Last run    "+cleanInlineText(valueOr(selected.LastRun, "never")),
			truncateText(cleanInlineText(data.Notice), width),
			"",
		)
	}
	rows := packageActionViewportRows(shell)
	start := clampInt(data.ActionOffset, 0, maxInt(0, len(data.Actions)-rows))
	end := minInt(len(data.Actions), start+rows)
	rangeLine := fmt.Sprintf("Actions %d–%d of %d", minInt(start+1, len(data.Actions)), end, len(data.Actions))
	if start > 0 {
		rangeLine += fmt.Sprintf("  ↑ %d above", start)
	}
	if end < len(data.Actions) {
		rangeLine += fmt.Sprintf("  ↓ %d more", len(data.Actions)-end)
	}
	lines = append(lines, style.Muted.Render(truncateText(rangeLine, width)))
	for index := start; index < end; index++ {
		action := data.Actions[index]
		label := cleanInlineText(action.Label)
		if !action.Enabled {
			label += " — unavailable: " + cleanInlineText(action.DisabledReason)
		}
		label = truncateText(label, maxInt(1, width-2))
		prefix := "  "
		if index == data.SelectedAction {
			prefix = "> "
			label = style.PaletteSelected.Render(label)
		} else if !action.Enabled {
			label = style.Muted.Render(label)
		}
		lines = append(lines, prefix+label)
	}
	lines = append(lines, "", style.Muted.Render(truncateText("↑/↓ or wheel move • PgUp/PgDn page • Home/End jump • Enter review • Esc back", width)))
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderPackageNameEditor(style styles.Styles, shell ShellData, data PackageManagerData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	title := "Rename package"
	verb := "preview"
	if data.Creating {
		title = "Create package"
		verb = "continue"
	}
	lines := []string{title, packageManagerConnectionLine(data)}
	if height < 14 {
		lines = append(lines,
			"Current name  "+cleanInlineText(valueOr(data.NameCurrent, "new package")),
			"New name      "+data.NameInput,
			truncateText(cleanInlineText(data.Notice), width),
			style.Muted.Render("Enter "+verb+" • Ctrl+V paste • Esc back"),
		)
	} else {
		lines = append(lines,
			"",
			"Current name  "+cleanInlineText(valueOr(data.NameCurrent, "new package")),
			"New name      "+data.NameInput,
			"",
			truncateText(cleanInlineText(data.Notice), width),
			"",
			style.Muted.Render("Enter "+verb+" • Ctrl+V paste • Esc back"),
		)
	}
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderPackageMembers(style styles.Styles, shell ShellData, data PackageManagerData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	lines := []string{"Edit package apps and launch order", packageManagerConnectionLine(data)}
	if strings.TrimSpace(data.Notice) != "" {
		lines = append(lines, truncateText(cleanInlineText(data.Notice), width))
	}
	rows := packageMemberViewportRows(shell)
	start := clampInt(data.MemberOffset, 0, maxInt(0, len(data.Members)-rows))
	end := minInt(len(data.Members), start+rows)
	rangeLine := fmt.Sprintf("Apps %d–%d of %d", minInt(start+1, len(data.Members)), end, len(data.Members))
	if start > 0 {
		rangeLine += fmt.Sprintf("  ↑ %d above", start)
	}
	if end < len(data.Members) {
		rangeLine += fmt.Sprintf("  ↓ %d more", len(data.Members)-end)
	}
	lines = append(lines, style.Muted.Render(truncateText(rangeLine, width)))
	for index := start; index < end; index++ {
		member := data.Members[index]
		mark := "[ ]"
		ordinal := "  "
		if member.Included {
			mark = "[x]"
			ordinal = fmt.Sprintf("%2d", member.Ordinal)
		}
		label := fmt.Sprintf("%s %s  %s [%s]", mark, ordinal, cleanInlineText(member.Name), cleanInlineText(member.AppID))
		if member.Missing {
			label += " — missing registration"
		}
		label = truncateText(label, maxInt(1, width-2))
		prefix := "  "
		if index == data.SelectedMember {
			prefix = "> "
			label = style.PaletteSelected.Render(label)
		}
		lines = append(lines, prefix+label)
	}
	lines = append(lines, style.Muted.Render(truncateText("Space add/remove • Ctrl+↑/↓ reorder • Enter review • Esc back", width)))
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderPackageRun(style styles.Styles, shell ShellData, data PackageManagerData) string {
	width := contentWidth(shell.Width)
	height := maxInt(8, shell.Height-8)
	if data.Run == nil {
		return fixedRegion(lipgloss.NewStyle(), "Latest package run\nNo package run has been recorded.\n\nEsc back", width, height)
	}
	rows := maxInt(1, height-6)
	start := clampInt(data.RunOffset, 0, maxInt(0, len(data.Run.Members)-rows))
	end := minInt(len(data.Run.Members), start+rows)
	rangeLine := fmt.Sprintf("Members %d–%d of %d", minInt(start+1, len(data.Run.Members)), end, len(data.Run.Members))
	if start > 0 {
		rangeLine += fmt.Sprintf("  ↑ %d above", start)
	}
	if end < len(data.Run.Members) {
		rangeLine += fmt.Sprintf("  ↓ %d more", len(data.Run.Members)-end)
	}
	lines := []string{"Latest package run", "Run ID  " + cleanInlineText(data.Run.ID), "Status  " + cleanInlineText(data.Run.Status), style.Muted.Render(truncateText(rangeLine, width))}
	for _, member := range data.Run.Members[start:end] {
		lines = append(lines, truncateText(cleanInlineText(member.AppID)+" — "+cleanInlineText(member.State), width))
	}
	lines = append(lines, "", style.Muted.Render("↑/↓ or wheel scroll • PgUp/PgDn page • Home/End jump • Esc back"))
	return fixedRegion(lipgloss.NewStyle(), strings.Join(lines, "\n"), width, height)
}

func renderPackageTable(style styles.Styles, width int, visibleRows int, data PackageTableData) string {
	visibleRows = maxInt(1, visibleRows)
	start := clampInt(data.Offset, 0, maxInt(0, len(data.Rows)-visibleRows))
	end := minInt(len(data.Rows), start+visibleRows)
	appsWidth := 6
	nameWidth := maxInt(8, width/2-4)
	lastWidth := maxInt(9, width-nameWidth-appsWidth-8)
	columns := []bubblestable.Column{{Title: "Name", Width: nameWidth}, {Title: "Apps", Width: appsWidth}, {Title: "Last run", Width: lastWidth}}
	if data.PickerMode {
		membershipWidth := minInt(20, maxInt(14, width/4))
		lastWidth = minInt(14, maxInt(8, width/6))
		nameWidth = maxInt(8, width-appsWidth-lastWidth-membershipWidth-8)
		columns[0].Width = nameWidth
		columns[2].Width = lastWidth
		columns = append(columns, bubblestable.Column{Title: "Membership", Width: membershipWidth})
	}
	tableRows := make([]bubblestable.Row, 0, end-start)
	for _, row := range data.Rows[start:end] {
		last := cleanInlineText(valueOr(row.LastRun, "never"))
		values := bubblestable.Row{cleanInlineText(row.Name), fmt.Sprintf("%d", row.MemberCount), appStatusTone(style, last).Render(last)}
		if data.PickerMode {
			membership := cleanInlineText(valueOr(row.Membership, "not included"))
			if !row.Enabled && row.DisabledReason != "" {
				membership = cleanInlineText(row.DisabledReason)
			}
			values = append(values, membership)
		}
		tableRows = append(tableRows, values)
	}
	tableStyles := bubblestable.DefaultStyles()
	tableStyles.Header = lipgloss.NewStyle().Bold(true).Foreground(style.Theme.Muted).Padding(0, 1)
	tableStyles.Cell = lipgloss.NewStyle().Foreground(style.Theme.Text).Padding(0, 1)
	tableStyles.Selected = lipgloss.NewStyle().Bold(true).Foreground(style.Theme.Background).Background(style.Theme.Accent)
	model := bubblestable.New(
		bubblestable.WithColumns(columns),
		bubblestable.WithRows(tableRows),
		bubblestable.WithWidth(maxInt(1, width)),
		bubblestable.WithHeight(visibleRows+1),
		bubblestable.WithFocused(true),
		bubblestable.WithStyles(tableStyles),
	)
	if len(tableRows) > 0 {
		model.SetCursor(clampInt(data.Selected-start, 0, len(tableRows)-1))
	}
	return model.View()
}

func packageManagerConnectionLine(data PackageManagerData) string {
	if data.ConnectionStatus != "connected" {
		return "Daemon offline — showing last known packages; mutations are unavailable."
	}
	if data.Refreshing {
		return "Refreshing packages from the Relaybase daemon…"
	}
	return "Current daemon-backed package state."
}

func packageTableViewportRows(shell ShellData) int {
	return maxInt(1, maxInt(8, shell.Height-8)-7)
}

func packageActionViewportRows(shell ShellData) int {
	return maxInt(1, maxInt(8, shell.Height-8)-12)
}

func packageManagerActionStartY(shell ShellData) int {
	if maxInt(8, shell.Height-8) < 14 {
		return 4
	}
	return 10
}

func packageMemberViewportRows(shell ShellData) int {
	return maxInt(1, maxInt(8, shell.Height-8)-7)
}

func packageManagerMemberStartY(data ShellData) int {
	if data.PackageManager != nil && strings.TrimSpace(data.PackageManager.Notice) != "" {
		return 4
	}
	return 3
}
