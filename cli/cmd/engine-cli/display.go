// Copyright (c) Microsoft Corporation. All rights reserved.

package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/github/copilot-engine-sdk/cli/internal/events"
	"github.com/github/copilot-engine-sdk/cli/internal/server"
)

// ANSI color codes
const (
	colorReset   = "\033[0m"
	colorBold    = "\033[1m"
	colorDim     = "\033[2m"
	colorCyan    = "\033[36m"
	colorGreen   = "\033[32m"
	colorYellow  = "\033[33m"
	colorBlue    = "\033[34m"
	colorMagenta = "\033[35m"
	colorRed     = "\033[31m"
	colorWhite   = "\033[37m"
	colorGray    = "\033[90m"
)

func eventIcon(kind string) string {
	switch kind {
	case "message":
		return "💬"
	case "model_call_success":
		return "✨"
	case "model_call_failure":
		return "❌"
	case "tool_execution":
		return "🔧"
	case "response":
		return "📤"
	case "history_truncated":
		return "✂️"
	case "report_progress":
		return "📝"
	case "comment_reply":
		return "💬"
	case "pr_summary":
		return "📋"
	default:
		return "📨"
	}
}

func eventColor(kind string) string {
	switch kind {
	case "message":
		return colorCyan
	case "model_call_success":
		return colorGreen
	case "model_call_failure":
		return colorRed
	case "tool_execution":
		return colorYellow
	case "response":
		return colorMagenta
	case "history_truncated":
		return colorBlue
	case "report_progress":
		return colorGreen
	case "comment_reply":
		return colorCyan
	case "pr_summary":
		return colorMagenta
	default:
		return colorWhite
	}
}

// resolveKind extracts the semantic event kind. The progress envelope uses
// kind="log" for all regular sessions-v2 events, so we look inside the
// content JSON for the real kind in that case.
func resolveKind(envelopeKind string, content json.RawMessage) string {
	if envelopeKind != "" && envelopeKind != "log" {
		return envelopeKind
	}
	return extractKind(content)
}

func printProgressEvent(event server.ProgressEvent) {
	kind := resolveKind(event.Kind, event.Content)
	icon := eventIcon(kind)
	color := eventColor(kind)

	// Print event header with box drawing
	fmt.Printf("┌─ %s %s%s%s%s\n", icon, color, colorBold, kind, colorReset)

	// Print event details
	printEventDetails(kind, event.Content)

	if verbose {
		// In verbose mode, show pretty-printed JSON
		var raw any
		if json.Unmarshal(event.Content, &raw) == nil {
			pretty, _ := json.MarshalIndent(raw, "│  ", "  ")
			fmt.Printf("│  %s%s%s\n", colorGray, string(pretty), colorReset)
		}
	}

	fmt.Println("└─")
}

// hasEventDetails returns true if the event kind has meaningful content to render
// in the box format. Events without details are rendered as compact inline counters.
func hasEventDetails(kind string, raw json.RawMessage) bool {
	switch kind {
	case "message", "model_call_success", "model_call_failure", "tool_execution",
		"response", "history_truncated", "report_progress", "comment_reply", "pr_summary":
		return true
	default:
		return false
	}
}

func printEventDetails(kind string, raw json.RawMessage) {
	switch kind {
	case "message":
		var ev events.Message
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		role := ev.Message.Role
		roleColor := colorCyan
		switch role {
		case "assistant":
			roleColor = colorGreen
		case "user":
			roleColor = colorYellow
		case "tool":
			roleColor = colorMagenta
		}

		if role == "tool" && ev.ToolName != "" {
			fmt.Printf("│  %sRole:%s %s%s%s  %sTool:%s %s%s%s\n",
				colorDim, colorReset, roleColor, role, colorReset,
				colorDim, colorReset, colorYellow, ev.ToolName, colorReset)
		} else {
			fmt.Printf("│  %sRole:%s %s%s%s\n", colorDim, colorReset, roleColor, role, colorReset)
		}

		if ev.Message.Content != "" {
			printWrapped(ev.Message.Content, colorWhite, 3)
		}

	case "model_call_success":
		var ev events.ModelCallSuccess
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		if ev.ModelCall.Model != "" {
			fmt.Printf("│  %sModel:%s %s\n", colorDim, colorReset, ev.ModelCall.Model)
		}
		if ev.ResponseUsage.PromptTokens > 0 || ev.ResponseUsage.CompletionTokens > 0 {
			fmt.Printf("│  %sTokens:%s %s%d%s prompt → %s%d%s completion\n",
				colorDim, colorReset,
				colorYellow, ev.ResponseUsage.PromptTokens, colorReset,
				colorGreen, ev.ResponseUsage.CompletionTokens, colorReset)
		}
		if len(ev.ResponseChunk.Choices) > 0 {
			if text := ev.ResponseChunk.Choices[0].Delta.Content; text != "" {
				printWrapped(text, colorGreen, 3)
			}
		}

	case "model_call_failure":
		var ev events.ModelCallFailure
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		if ev.ModelCall.Error != "" {
			fmt.Printf("│  %sError:%s %s%s%s\n", colorDim, colorReset, colorRed, truncate(ev.ModelCall.Error, 80), colorReset)
		}

	case "tool_execution":
		var ev events.ToolExecution
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		name := ev.ToolName
		if name == "" {
			name = truncate(ev.ToolCallID, 23)
		}
		status := ev.ToolResult.ResultType
		statusColor := colorYellow
		switch status {
		case "success":
			statusColor = colorGreen
		case "failure", "error":
			statusColor = colorRed
		}
		fmt.Printf("│  %sTool:%s %s%s%s  %sStatus:%s %s%s%s\n",
			colorDim, colorReset, colorYellow, name, colorReset,
			colorDim, colorReset, statusColor, status, colorReset)

	case "response":
		var ev events.Response
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		if ev.Response.Content != "" {
			printWrapped(ev.Response.Content, colorMagenta, 3)
		}

	case "history_truncated":
		var ev events.HistoryTruncated
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		fmt.Printf("│  %sMessages:%s %s%d%s → %s%d%s\n",
			colorDim, colorReset,
			colorRed, ev.TruncateResult.PreTruncationMessagesLength, colorReset,
			colorGreen, ev.TruncateResult.PostTruncationMessagesLength, colorReset)

	case "report_progress":
		var ev events.ReportProgress
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		if ev.PRTitle != "" {
			fmt.Printf("│  %sTitle:%s %s%s%s\n", colorDim, colorReset, colorBold, ev.PRTitle, colorReset)
		}
		if ev.PRDescription != "" {
			lines := strings.Split(ev.PRDescription, "\n")
			fmt.Printf("│  %sDescription:%s\n", colorDim, colorReset)
			for i, line := range lines {
				if i >= 10 {
					fmt.Printf("│    %s... (%d more lines)%s\n", colorDim, len(lines)-i, colorReset)
					break
				}
				trimmed := strings.TrimSpace(line)
				switch {
				case strings.HasPrefix(trimmed, "- [x]"):
					fmt.Printf("│    %s%s%s\n", colorGreen, line, colorReset)
				case strings.HasPrefix(trimmed, "- [ ]"):
					fmt.Printf("│    %s%s%s\n", colorYellow, line, colorReset)
				default:
					fmt.Printf("│    %s\n", line)
				}
			}
		}

	case "comment_reply":
		var ev events.CommentReply
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		if ev.CommentID != 0 {
			fmt.Printf("│  %sComment ID:%s %d\n", colorDim, colorReset, ev.CommentID)
		}
		if ev.Message != "" {
			printWrapped(ev.Message, colorCyan, 5)
		}

	case "pr_summary":
		var ev events.PRSummary
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		fmt.Printf("│  %s━━━ Final PR Summary ━━━%s\n", colorBold, colorReset)
		if ev.PRTitle != "" {
			fmt.Printf("│  %sTitle:%s %s%s%s\n", colorDim, colorReset, colorBold+colorMagenta, ev.PRTitle, colorReset)
		}
		if ev.PRDescription != "" {
			lines := strings.Split(ev.PRDescription, "\n")
			fmt.Printf("│  %sDescription:%s\n", colorDim, colorReset)
			for i, line := range lines {
				if i >= 15 {
					fmt.Printf("│    %s... (%d more lines)%s\n", colorDim, len(lines)-i, colorReset)
					break
				}
				fmt.Printf("│    %s\n", line)
			}
		}
	}
}

func printWrapped(text, color string, maxLines int) {
	wrapped := wrapText(text, 70)
	for i, line := range wrapped {
		if i == 0 {
			fmt.Printf("│  %s\"%s\"%s\n", color, line, colorReset)
		} else {
			fmt.Printf("│  %s %s%s\n", color, line, colorReset)
		}
		if i >= maxLines-1 {
			fmt.Printf("│  %s...%s\n", colorDim, colorReset)
			break
		}
	}
}

func wrapText(text string, width int) []string {
	var lines []string
	// Split on newlines first, then wrap each line by width
	for _, paragraph := range strings.Split(text, "\n") {
		if len(paragraph) <= width {
			lines = append(lines, paragraph)
			continue
		}
		remaining := paragraph
		for len(remaining) > width {
			idx := width
			for idx > 0 && remaining[idx] != ' ' {
				idx--
			}
			if idx == 0 {
				idx = width
			}
			lines = append(lines, remaining[:idx])
			remaining = remaining[idx:]
			if len(remaining) > 0 && remaining[0] == ' ' {
				remaining = remaining[1:]
			}
		}
		if len(remaining) > 0 {
			lines = append(lines, remaining)
		}
	}
	return lines
}

func extractKind(raw json.RawMessage) string {
	var m struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(raw, &m) == nil && m.Kind != "" {
		return m.Kind
	}
	return "unknown"
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen-3] + "..."
}
