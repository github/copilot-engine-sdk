// Copyright (c) Microsoft Corporation. All rights reserved.

package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/github/copilot-engine-sdk/cli/internal/events"
	"github.com/github/copilot-engine-sdk/cli/internal/server"
)

var (
	dimStyle    = lipgloss.NewStyle().Faint(true)
	boldStyle   = lipgloss.NewStyle().Bold(true)
	greenStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	redStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	yellowStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	cyanStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
	magStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("5"))
	mutedStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))

	separator = dimStyle.Render("  ─────────────────────────────────────────")
)

func resolveKind(envelopeKind string, content json.RawMessage) string {
	if envelopeKind != "" && envelopeKind != "log" {
		return envelopeKind
	}
	var m struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(content, &m) == nil && m.Kind != "" {
		return m.Kind
	}
	return "unknown"
}

// isDisplayEvent returns true for events we render.
func isDisplayEvent(kind string) bool {
	switch kind {
	case "message", "tool_execution", "report_progress", "pr_summary",
		"model_call_failure", "comment_reply":
		return true
	default:
		return false
	}
}

// printEvent renders a single event. Returns true if something was printed.
func printEvent(event server.ProgressEvent) bool {
	kind := resolveKind(event.Kind, event.Content)

	switch kind {
	case "message":
		return printMessage(event.Content)
	case "tool_execution":
		return printToolExecution(event.Content)
	case "report_progress":
		return printReportProgress(event.Content)
	case "pr_summary":
		return printPRSummary(event.Content)
	case "model_call_failure":
		return printModelCallFailure(event.Content)
	case "comment_reply":
		return printCommentReply(event.Content)
	default:
		// Custom namespace/kind — don't render inline, counted in summary
		return false
	}
}

// ─────────────────────────────────────────────────────────────
// Assistant messages
// ─────────────────────────────────────────────────────────────

func printMessage(raw json.RawMessage) bool {
	var ev events.Message
	if json.Unmarshal(raw, &ev) != nil {
		return false
	}
	content := strings.TrimSpace(ev.Message.Content)
	if content == "" {
		return false
	}

	switch ev.Message.Role {
	case "assistant":
		// Skip raw XML wrapper messages (pr_title/pr_description)
		if strings.HasPrefix(content, "<pr_title>") {
			return false
		}
		fmt.Println(separator)
		fmt.Printf("  %s %s\n", cyanStyle.Render("●"), boldStyle.Render("Assistant"))
		fmt.Println()
		for _, line := range wrapText(content, 74) {
			fmt.Printf("    %s\n", line)
		}
		return true

	case "tool":
		name := ev.ToolName
		if name == "" {
			name = "tool"
		}
		// Skip report_progress tool results — shown via ↑ Progress block
		if strings.Contains(name, "report_progress") {
			return false
		}
		fmt.Println(separator)
		isErr := containsError(content)
		if isErr {
			fmt.Printf("  %s %s %s\n", redStyle.Render("●"), dimStyle.Render("Tool:"), yellowStyle.Render(name))
		} else {
			fmt.Printf("  %s %s %s\n", greenStyle.Render("●"), dimStyle.Render("Tool:"), yellowStyle.Render(name))
		}
		// Show the tool output, indented and muted
		fmt.Println()
		lines := wrapText(content, 70)
		maxLines := 8
		for i, line := range lines {
			if i >= maxLines {
				fmt.Printf("    %s\n", mutedStyle.Render(fmt.Sprintf("... (%d more lines)", len(lines)-i)))
				break
			}
			fmt.Printf("    %s\n", mutedStyle.Render(line))
		}
		return true

	default:
		return false
	}
}

// ─────────────────────────────────────────────────────────────
// Tool execution results
// ─────────────────────────────────────────────────────────────

func printToolExecution(raw json.RawMessage) bool {
	var ev events.ToolExecution
	if json.Unmarshal(raw, &ev) != nil {
		return false
	}
	name := ev.ToolName
	if name == "" {
		name = truncate(ev.ToolCallID, 20)
	}
	// Skip report_progress — already shown via ↑ Progress block
	if strings.Contains(name, "report_progress") {
		return false
	}
	// tool_execution is redundant with the tool message above — skip it
	// The tool message (role=tool) already shows name + ✓/✗ + output
	return false
}

// ─────────────────────────────────────────────────────────────
// Progress updates
// ─────────────────────────────────────────────────────────────

func printReportProgress(raw json.RawMessage) bool {
	var ev events.ReportProgress
	if json.Unmarshal(raw, &ev) != nil {
		return false
	}
	fmt.Println(separator)
	title := ev.PRTitle
	if title == "" {
		title = "Progress"
	}
	fmt.Printf("  %s %s\n", greenStyle.Render("●"), boldStyle.Render(title))
	if ev.PRDescription != "" {
		fmt.Println()
		for _, line := range strings.Split(ev.PRDescription, "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}
			switch {
			case strings.HasPrefix(trimmed, "- [x]"):
				fmt.Printf("    %s\n", greenStyle.Render(trimmed))
			case strings.HasPrefix(trimmed, "- [ ]"):
				fmt.Printf("    %s\n", yellowStyle.Render(trimmed))
			default:
				fmt.Printf("    %s\n", dimStyle.Render(trimmed))
			}
		}
	}
	return true
}

// ─────────────────────────────────────────────────────────────
// PR Summary
// ─────────────────────────────────────────────────────────────

func printPRSummary(raw json.RawMessage) bool {
	var ev events.PRSummary
	if json.Unmarshal(raw, &ev) != nil {
		return false
	}
	fmt.Println(separator)
	fmt.Printf("  %s %s %s\n", magStyle.Render("●"), dimStyle.Render("PR"), boldStyle.Render(ev.PRTitle))
	if ev.PRDescription != "" {
		fmt.Println()
		lines := strings.Split(ev.PRDescription, "\n")
		for i, line := range lines {
			if i >= 15 {
				fmt.Printf("    %s\n", mutedStyle.Render(fmt.Sprintf("... (%d more lines)", len(lines)-i)))
				break
			}
			fmt.Printf("    %s\n", line)
		}
	}
	return true
}

// ─────────────────────────────────────────────────────────────
// Errors and misc
// ─────────────────────────────────────────────────────────────

func printModelCallFailure(raw json.RawMessage) bool {
	var ev events.ModelCallFailure
	if json.Unmarshal(raw, &ev) != nil {
		return false
	}
	if ev.ModelCall.Error != "" {
		fmt.Println(separator)
		fmt.Printf("  %s %s\n", redStyle.Render("●"), redStyle.Render(truncate(ev.ModelCall.Error, 72)))
		return true
	}
	return false
}

func printCommentReply(raw json.RawMessage) bool {
	var ev events.CommentReply
	if json.Unmarshal(raw, &ev) != nil {
		return false
	}
	fmt.Println(separator)
	fmt.Printf("  %s %s #%d\n", cyanStyle.Render("●"), dimStyle.Render("Reply to"), ev.CommentID)
	if ev.Message != "" {
		fmt.Println()
		for _, line := range wrapText(ev.Message, 74) {
			fmt.Printf("    %s\n", line)
		}
	}
	return true
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

func containsError(s string) bool {
	lower := strings.ToLower(s)
	return strings.Contains(lower, "error") ||
		strings.Contains(lower, "denied") ||
		strings.Contains(lower, "failed") ||
		strings.Contains(lower, "not found")
}

func wrapText(text string, width int) []string {
	var lines []string
	for _, paragraph := range strings.Split(text, "\n") {
		runes := []rune(paragraph)
		if len(runes) <= width {
			lines = append(lines, paragraph)
			continue
		}
		for len(runes) > width {
			idx := width - 1
			for idx > 0 && runes[idx] != ' ' {
				idx--
			}
			if idx == 0 {
				idx = width
			}
			lines = append(lines, string(runes[:idx]))
			runes = runes[idx:]
			if len(runes) > 0 && runes[0] == ' ' {
				runes = runes[1:]
			}
		}
		if len(runes) > 0 {
			lines = append(lines, string(runes))
		}
	}
	return lines
}

func truncate(s string, maxLen int) string {
	runes := []rune(s)
	if len(runes) <= maxLen {
		return s
	}
	return string(runes[:maxLen-3]) + "..."
}
