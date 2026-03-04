// Copyright (c) Microsoft Corporation. All rights reserved.

// Package main implements the engine-cli command.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/github/copilot-engine-sdk/cli/internal/events"
	"github.com/github/copilot-engine-sdk/cli/internal/runner"
	"github.com/github/copilot-engine-sdk/cli/internal/server"
	"github.com/github/copilot-engine-sdk/cli/internal/store"
	"github.com/spf13/cobra"
)

var (
	// Run command flags
	repoURL                  string
	problemStatement         string
	organizationInstructions string
	workingDir               string
	timeout                  time.Duration
	verbose                  bool
	action                   string
	commitLogin              string
	commitEmail              string
	assignmentID             string
)

func main() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}

var rootCmd = &cobra.Command{
	Use:   "engine-cli",
	Short: "CLI for testing engine implementations",
	Long: `engine-cli is a test harness for verifying engine implementations
against the platform API.

It starts a mock platform server and runs your engine with the
required environment variables, allowing you to test your engine
locally without deploying to the platform.`,
}

var runCmd = &cobra.Command{
	Use:   "run <command>",
	Short: "Run an engine with a mock platform server",
	Long: `Run an engine command with a mock platform server.

The CLI will:
1. Clone the specified repository to a temporary directory
2. Start a mock platform server
3. Set the required environment variables (GITHUB_JOB_ID, GITHUB_PLATFORM_API_TOKEN, etc.)
4. Execute your engine command with GITHUB_PLATFORM_REPO_LOCATION pointing to the cloned repo
5. Display received events from the engine

Examples:
  # Run a Node.js engine against a GitHub repo
  engine-cli run "node dist/index.js" --repo https://github.com/user/repo --problem-statement "Fix the bug"

  # Run a Python engine
  engine-cli run "python engine.py" --repo https://github.com/user/repo --problem-statement "Add tests"`,
	Args: cobra.ExactArgs(1),
	RunE: runEngine,
}

func init() {
	rootCmd.AddCommand(runCmd)

	runCmd.Flags().StringVarP(&repoURL, "repo", "r", "", "GitHub repository URL to clone (required)")
	runCmd.Flags().StringVarP(&problemStatement, "problem-statement", "p", "Hello, please respond with 'Hello World!'", "Problem statement for the engine to solve")
	runCmd.Flags().StringVar(&organizationInstructions, "org-instructions", "", "Organization custom instructions")
	runCmd.Flags().StringVarP(&workingDir, "working-dir", "w", "", "Working directory for the engine command (not the repo)")
	runCmd.Flags().DurationVarP(&timeout, "timeout", "t", 5*time.Minute, "Timeout for engine execution")
	runCmd.Flags().BoolVarP(&verbose, "verbose", "v", false, "Enable verbose output")
	runCmd.Flags().StringVar(&action, "action", "fix", "Agent action type: fix, fix-pr-comment, or task")
	runCmd.Flags().StringVar(&commitLogin, "commit-login", "engine-cli-user", "Git author name for commits")
	runCmd.Flags().StringVar(&commitEmail, "commit-email", "engine-cli@users.noreply.github.com", "Git author email for commits")
	runCmd.Flags().StringVar(&assignmentID, "assignment-id", "", "Assignment ID to enable cross-run history persistence")

	_ = runCmd.MarkFlagRequired("repo")
}

func runEngine(cmd *cobra.Command, args []string) error {
	command := args[0]

	// Clone the repository to a temporary directory
	fmt.Println("🚀 Engine Test Harness")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Printf("📦 Cloning repository: %s\n", repoURL)

	repoDir, branchName, err := cloneRepo(repoURL)
	if err != nil {
		return fmt.Errorf("failed to clone repository: %w", err)
	}
	defer func() {
		fmt.Printf("🧹 Cleaning up temp directory: %s\n", repoDir)
		_ = os.RemoveAll(repoDir)
	}()

	fmt.Printf("📁 Cloned to: %s\n", repoDir)

	// Generate a job ID
	jobID := fmt.Sprintf("test-job-%d", time.Now().UnixNano())

	// Parse the repo URL into server URL + owner/repo for the job response
	serverURL, repoNWO, err := parseRepoURL(repoURL)
	if err != nil {
		return fmt.Errorf("invalid repo URL: %w", err)
	}

	// Create mock server
	jobConfig := server.JobConfig{
		JobID:                    jobID,
		ProblemStatement:         problemStatement,
		OrganizationInstructions: organizationInstructions,
		Action:                   action,
		Repository:               repoNWO,
		ServerURL:                serverURL,
		BranchName:               branchName,
		CommitLogin:              commitLogin,
		CommitEmail:              commitEmail,
	}

	callbacks := server.Callbacks{
		OnJobFetched: func() {
			fmt.Println("📋 Engine fetched job details")
		},
		OnProgressEvent: func(event server.ProgressEvent) {
			printProgressEvent(event)
		},
	}

	mockServer := server.New(jobConfig, callbacks)

	// Load history from previous run if assignment ID is provided
	if assignmentID != "" {
		previousEvents, err := store.Load(assignmentID)
		if err != nil {
			fmt.Printf("⚠️  Failed to load history for assignment %s: %v\n", assignmentID, err)
		} else if len(previousEvents) > 0 {
			mockServer.SetPreviousEvents(previousEvents)
			fmt.Printf("📂 Loaded %d history events from previous run (assignment: %s)\n", len(previousEvents), assignmentID)
		} else {
			fmt.Printf("📂 No previous history for assignment: %s\n", assignmentID)
		}
	}

	// Start the server
	port, err := mockServer.Start(0)
	if err != nil {
		return fmt.Errorf("failed to start mock server: %w", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = mockServer.Stop(ctx)
	}()

	apiURL := fmt.Sprintf("http://localhost:%d/agent", port)

	// All engine tokens are derived from a single GITHUB_TOKEN in the environment.
	githubToken := os.Getenv("GITHUB_TOKEN")
	if githubToken == "" {
		return fmt.Errorf("GITHUB_TOKEN must be set in the environment")
	}

	fmt.Printf("📡 Mock server running on %s\n", apiURL)
	fmt.Printf("🆔 Job ID: %s\n", jobID)
	fmt.Printf("📝 Problem: %s\n", truncate(problemStatement, 50))
	fmt.Printf("⚙️  Command: %s\n", command)
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println()

	// Set up context with timeout and signal handling
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Handle interrupt signals
	interrupted := false
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		interrupted = true
		fmt.Println("\n⚠️  Received interrupt, stopping engine...")
		cancel()
	}()

	// Create runner callbacks
	runnerCallbacks := runner.Callbacks{
		OnStdout: func(line string) {
			fmt.Printf("│ %s\n", line)
		},
		OnStderr: func(line string) {
			fmt.Printf("│ \033[31m%s\033[0m\n", line) // Red for stderr
		},
	}

	// Run the engine
	fmt.Println("▶️  Starting engine...")
	fmt.Println()

	env := runner.Environment{
		JobID:          jobID,
		APIToken:       githubToken,
		APIURL:         apiURL,
		JobNonce:       mockServer.Nonce(),
		InferenceToken: githubToken,
		GitToken:       githubToken,
	}

	opts := runner.Options{
		WorkingDir: workingDir,
	}

	result := runner.Run(ctx, command, env, opts, runnerCallbacks)

	fmt.Println()
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	// Print summary
	events := mockServer.Events()
	fmt.Printf("📊 Summary:\n")
	fmt.Printf("   Events received: %d\n", len(events))

	// Save current events as history for next run
	if assignmentID != "" && len(events) > 0 {
		records := make([]store.Record, len(events))
		for i, ev := range events {
			records[i] = store.Record{
				ID:        fmt.Sprintf("progress-%d", i+1),
				Namespace: ev.Namespace,
				Kind:      ev.Kind,
				Version:   ev.Version,
				Content:   ev.Content,
				CreatedAt: ev.Timestamp.Unix(),
			}
		}
		if err := store.Save(assignmentID, records); err != nil {
			fmt.Printf("   ⚠️  Failed to save history: %v\n", err)
		} else {
			fmt.Printf("   💾 Saved %d events to history (assignment: %s)\n", len(records), assignmentID)
		}
	}

	if result.Error != nil {
		fmt.Printf("   Error: %v\n", result.Error)
	}

	// Print event summary by kind
	eventCounts := make(map[string]int)
	for _, e := range events {
		kind := resolveKind(e.Kind, e.Content)
		eventCounts[kind]++
	}

	if len(eventCounts) > 0 {
		fmt.Println("   Event types:")
		for kind, count := range eventCounts {
			fmt.Printf("     - %s: %d\n", kind, count)
		}
	}

	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	// Don't report error for interrupt or successful exit
	if interrupted || result.ExitCode == 0 {
		return nil
	}

	if result.ExitCode != 0 {
		return fmt.Errorf("engine exited with code %d", result.ExitCode)
	}

	return nil
}

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
	if len(text) <= width {
		return []string{text}
	}

	var lines []string
	for len(text) > width {
		// Find last space before width
		idx := width
		for idx > 0 && text[idx] != ' ' {
			idx--
		}
		if idx == 0 {
			idx = width // No space found, hard break
		}
		lines = append(lines, text[:idx])
		text = text[idx:]
		if len(text) > 0 && text[0] == ' ' {
			text = text[1:]
		}
	}
	if len(text) > 0 {
		lines = append(lines, text)
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

// parseRepoURL splits a full repo URL into server URL and owner/repo.
// e.g. "https://github.com/josebalius/dotfiles" → ("https://github.com", "josebalius/dotfiles")
func parseRepoURL(raw string) (string, string, error) {
	u, err := url.Parse(strings.TrimSuffix(raw, ".git"))
	if err != nil {
		return "", "", err
	}
	path := strings.TrimPrefix(u.Path, "/")
	parts := strings.SplitN(path, "/", 3)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("expected owner/repo in URL path, got %q", path)
	}
	serverURL := fmt.Sprintf("%s://%s", u.Scheme, u.Host)
	nwo := parts[0] + "/" + parts[1]
	return serverURL, nwo, nil
}

// cloneRepo clones a GitHub repository to a temporary directory, creates a working branch, and returns the path.
func cloneRepo(repoURL string) (string, string, error) {
	// Create a temporary directory
	tempDir, err := os.MkdirTemp("", "engine-cli-repo-*")
	if err != nil {
		return "", "", fmt.Errorf("failed to create temp directory: %w", err)
	}

	// Clone the repository
	cmd := exec.Command("git", "clone", "--depth", "1", repoURL, tempDir)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		// Clean up temp dir on failure
		_ = os.RemoveAll(tempDir)
		return "", "", fmt.Errorf("git clone failed: %w", err)
	}

	// Create and checkout a working branch
	branchName := fmt.Sprintf("engine-cli-test-%d", time.Now().UnixNano())
	cmd = exec.Command("git", "checkout", "-b", branchName)
	cmd.Dir = tempDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		_ = os.RemoveAll(tempDir)
		return "", "", fmt.Errorf("failed to create branch: %w", err)
	}

	fmt.Printf("🌿 Created branch: %s\n", branchName)

	// Get absolute path
	absPath, err := filepath.Abs(tempDir)
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return "", "", fmt.Errorf("failed to get absolute path: %w", err)
	}

	return absPath, branchName, nil
}
