// Copyright (c) Microsoft Corporation. All rights reserved.

// Package main implements the engine-cli command.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

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
	engineLogs               bool
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
	runCmd.Flags().BoolVar(&engineLogs, "engine-logs", false, "Show raw engine stdout/stderr instead of formatted server events")
	runCmd.Flags().StringVar(&action, "action", "fix", "Agent action type: fix, fix-pr-comment, or task")
	runCmd.Flags().StringVar(&commitLogin, "commit-login", "engine-cli-user", "Git author name for commits")
	runCmd.Flags().StringVar(&commitEmail, "commit-email", "engine-cli@users.noreply.github.com", "Git author email for commits")
	runCmd.Flags().StringVar(&assignmentID, "assignment-id", "", "Assignment ID to enable cross-run history persistence")

	_ = runCmd.MarkFlagRequired("repo")
}

func runEngine(cmd *cobra.Command, args []string) error {
	command := args[0]

	fmt.Println("🚀 Engine Test Harness")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")

	// Generate a job ID
	jobID := fmt.Sprintf("test-job-%d", time.Now().UnixNano())

	// Parse the repo URL into server URL + owner/repo for the job response
	serverURL, repoNWO, err := parseRepoURL(repoURL)
	if err != nil {
		return fmt.Errorf("invalid repo URL: %w", err)
	}

	// All engine tokens are derived from a single GITHUB_TOKEN in the environment.
	githubToken := os.Getenv("GITHUB_TOKEN")
	if githubToken == "" {
		return fmt.Errorf("GITHUB_TOKEN must be set in the environment")
	}

	// Determine owner/repo and API base URL
	parts := strings.SplitN(repoNWO, "/", 2)
	owner, repo := parts[0], parts[1]
	apiBaseURL := serverURL + "/api/v3"
	if strings.Contains(serverURL, "github.com") {
		apiBaseURL = "https://api.github.com"
	}

	// Fetch the default branch
	defaultBranch, err := getDefaultBranch(apiBaseURL, githubToken, owner, repo)
	if err != nil {
		return fmt.Errorf("failed to get default branch: %w", err)
	}

	branchName := fmt.Sprintf("engine-cli-test-%d", time.Now().UnixNano())

	// Create branch with empty commit and draft PR
	fmt.Printf("📦 Repository: %s (default branch: %s)\n", repoNWO, defaultBranch)
	fmt.Printf("🌿 Creating branch: %s\n", branchName)

	setup, err := setupBranchAndPR(apiBaseURL, githubToken, owner, repo, branchName, defaultBranch,
		fmt.Sprintf("[engine-cli] %s", truncate(problemStatement, 60)),
		fmt.Sprintf("**Problem:** %s\n\n_Created by engine-cli test harness._", problemStatement),
	)
	if err != nil {
		return fmt.Errorf("failed to set up branch and PR: %w", err)
	}
	fmt.Printf("🔗 Pull request: %s\n", setup.PRURL)

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

	lastEventKind := ""
	repeatCount := 0
	prNumber := setup.PRNumber
	callbacks := server.Callbacks{
		OnJobFetched: func() {
			fmt.Println("📋 Engine fetched job details")
		},
		OnProgressEvent: func(event server.ProgressEvent) {
			kind := resolveKind(event.Kind, event.Content)

			// Update PR on progress and summary events
			if kind == "report_progress" || kind == "pr_summary" {
				var ev struct {
					PRTitle       string `json:"pr_title"`
					PRDescription string `json:"pr_description"`
				}
				if json.Unmarshal(event.Content, &ev) == nil && (ev.PRTitle != "" || ev.PRDescription != "") {
					if err := updatePullRequest(apiBaseURL, githubToken, owner, repo, prNumber, ev.PRTitle, ev.PRDescription); err != nil {
						fmt.Printf("\n⚠️  Failed to update PR: %v\n", err)
					}
				}
			}

			if engineLogs {
				return
			}

			// Collapse repeated events of the same kind into a counter
			if kind == lastEventKind {
				repeatCount++
				icon := eventIcon(kind)
				fmt.Printf("\r\033[K%s %s (%d events)", icon, kind, repeatCount)
				return
			}

			// Finish the previous repeat line if any
			if repeatCount > 0 {
				fmt.Println()
			}
			lastEventKind = kind
			repeatCount = 1

			// Events with no meaningful details render as a compact inline counter
			if !hasEventDetails(kind, event.Content) {
				icon := eventIcon(kind)
				fmt.Printf("%s %s (1 event)", icon, kind)
				return
			}

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
			if engineLogs {
				fmt.Printf("│ %s\n", line)
			}
		},
		OnStderr: func(line string) {
			if engineLogs {
				fmt.Printf("│ \033[31m%s\033[0m\n", line) // Red for stderr
			}
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

	// Finish any pending repeat counter
	if repeatCount > 1 {
		fmt.Println()
	}

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
