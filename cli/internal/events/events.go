// Copyright (c) Microsoft Corporation. All rights reserved.

// Package events defines typed structs for progress event payloads.
package events

// MessageContent represents the inner message in a message event.
type MessageContent struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

// ToolCall represents a tool call requested by the assistant.
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

// ToolFunction represents the function details of a tool call.
type ToolFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// ModelCallParam contains model call metadata.
type ModelCallParam struct {
	APIID     string `json:"api_id,omitempty"`
	Model     string `json:"model,omitempty"`
	Error     string `json:"error,omitempty"`
	Status    int    `json:"status,omitempty"`
	RequestID string `json:"request_id,omitempty"`
}

// ToolResult contains the result of a tool execution.
type ToolResult struct {
	ResultType string `json:"resultType"`
}

// ResponseUsage contains token usage information.
type ResponseUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
}

// ResponseChoice represents a single choice from a model response chunk.
type ResponseChoice struct {
	Delta struct {
		Content string `json:"content"`
	} `json:"delta"`
}

// ResponseChunk represents a streamed model response chunk.
type ResponseChunk struct {
	Choices []ResponseChoice `json:"choices"`
}

// TruncateResult contains truncation statistics.
type TruncateResult struct {
	PreTruncationMessagesLength  int `json:"preTruncationMessagesLength"`
	PostTruncationMessagesLength int `json:"postTruncationMessagesLength"`
}

// Message is the content of a "message" kind event.
type Message struct {
	Kind     string         `json:"kind"`
	ToolName string         `json:"toolName,omitempty"`
	Message  MessageContent `json:"message"`
}

// ModelCallSuccess is the content of a "model_call_success" kind event.
type ModelCallSuccess struct {
	Kind          string         `json:"kind"`
	ModelCall     ModelCallParam `json:"modelCall"`
	ResponseUsage ResponseUsage  `json:"responseUsage"`
	ResponseChunk ResponseChunk  `json:"responseChunk"`
}

// ModelCallFailure is the content of a "model_call_failure" kind event.
type ModelCallFailure struct {
	Kind      string         `json:"kind"`
	ModelCall ModelCallParam `json:"modelCall"`
}

// ToolExecution is the content of a "tool_execution" kind event.
type ToolExecution struct {
	Kind       string     `json:"kind"`
	ToolCallID string     `json:"toolCallId"`
	ToolName   string     `json:"toolName"`
	ToolResult ToolResult `json:"toolResult"`
}

// Response is the content of a "response" kind event.
type Response struct {
	Kind     string         `json:"kind"`
	Response MessageContent `json:"response"`
}

// HistoryTruncated is the content of a "history_truncated" kind event.
type HistoryTruncated struct {
	Kind           string         `json:"kind"`
	TruncateResult TruncateResult `json:"truncateResult"`
}

// ReportProgress is the content of a "report_progress" kind event.
type ReportProgress struct {
	PRTitle       string `json:"pr_title"`
	PRDescription string `json:"pr_description"`
}

// CommentReply is the content of a "comment_reply" kind event.
type CommentReply struct {
	CommentID int64  `json:"comment_id"`
	Message   string `json:"message"`
}

// PRSummary is the content of a "pr_summary" kind event.
type PRSummary struct {
	PRTitle       string `json:"pr_title"`
	PRDescription string `json:"pr_description"`
}
