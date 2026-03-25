// Copyright (c) Microsoft Corporation. All rights reserved.

// Package main implements the engine-cli command.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
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
	enableModelSelection     bool
	selectedEngine           string
	selectedModel            string
	defaultModel             string
	availableModels          []string
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
	runCmd.Flags().BoolVar(&enableModelSelection, "enable-model-selection", false, "Enable the model selection feature flag in the job response")
	runCmd.Flags().StringVar(&selectedEngine, "selected-engine", "", "Selected engine family for this job (for example: claude or codex)")
	runCmd.Flags().StringVar(&selectedModel, "selected-model", "", "Selected model for this job")
	runCmd.Flags().StringVar(&defaultModel, "default-model", "", "Default model for this engine")
	runCmd.Flags().StringSliceVar(&availableModels, "available-model", nil, "Available model for this engine (repeatable)")

	_ = runCmd.MarkFlagRequired("repo")
}

func runEngine(cmd *cobra.Command, args []string) error {
	command := args[0]

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
	parsedURL, _ := url.Parse(serverURL)
	apiBaseURL := serverURL + "/api/v3"
	if parsedURL != nil && (parsedURL.Host == "github.com" || parsedURL.Host == "www.github.com") {
		apiBaseURL = "https://api.github.com"
	}

	// Fetch the default branch
	defaultBranch, err := getDefaultBranch(apiBaseURL, githubToken, owner, repo)
	if err != nil {
		return fmt.Errorf("failed to get default branch: %w", err)
	}

	branchName := fmt.Sprintf("engine-cli-test-%d", time.Now().UnixNano())

	// Create branch with empty commit and PR (best-effort — may fail if token lacks permissions)
	setup, err := setupBranchAndPR(apiBaseURL, githubToken, owner, repo, branchName, defaultBranch,
		fmt.Sprintf("[engine-cli] %s", truncate(problemStatement, 60)),
		fmt.Sprintf("**Problem:** %s\n\n_Created by engine-cli test harness._", problemStatement),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  warning: could not pre-create branch/PR: %v\n", err)
		fmt.Fprintf(os.Stderr, "  (the engine will create the branch on push)\n")
		setup = &SetupResult{BranchName: branchName}
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
		EnableModelSelection:     enableModelSelection,
		SelectedEngine:           selectedEngine,
		SelectedModel:            selectedModel,
		DefaultModel:             defaultModel,
		AvailableModels:          availableModels,
	}

	prNumber := setup.PRNumber

	// Track suppressed events for the summary
	type eventKey struct{ namespace, kind string }
	suppressedCounts := make(map[eventKey]int)

	callbacks := server.Callbacks{
		OnJobFetched: func() {
			fmt.Println(separator)
			fmt.Printf("  %s %s\n", greenStyle.Render("●"), dimStyle.Render("Job details fetched"))
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
						fmt.Fprintf(os.Stderr, "  warning: failed to update PR: %v\n", err)
					}
				}
			}

			if engineLogs {
				// Track all events as suppressed when in engine-logs mode
				suppressedCounts[eventKey{event.Namespace, kind}]++
				return
			}

			// Try to print the event; if nothing was printed, track it
			if !printEvent(event) {
				suppressedCounts[eventKey{event.Namespace, kind}]++
			}
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

	// Print header
	fmt.Println()
	fmt.Printf("  %s %s\n", dimStyle.Render("repo:"), boldStyle.Render(repoNWO))
	fmt.Printf("  %s %s\n", dimStyle.Render("branch:"), mutedStyle.Render(branchName))
	if setup.PRURL != "" {
		fmt.Printf("  %s %s\n", dimStyle.Render("pr:"), cyanStyle.Render(setup.PRURL))
	}
	fmt.Printf("  %s %s\n", dimStyle.Render("job:"), mutedStyle.Render(jobID))
	fmt.Printf("  %s %s\n", dimStyle.Render("cmd:"), mutedStyle.Render(command))
	fmt.Printf("  %s %s\n", dimStyle.Render("timeout:"), mutedStyle.Render(timeout.String()))

	// Set up context with timeout and signal handling
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigChan
		cancel()
	}()

	// Create runner callbacks
	runnerCallbacks := runner.Callbacks{
		OnStdout: func(line string) {
			if engineLogs {
				fmt.Printf("  %s %s\n", dimStyle.Render("│"), line)
			}
		},
		OnStderr: func(line string) {
			if engineLogs {
				fmt.Printf("  %s %s\n", redStyle.Render("│"), line)
			}
		},
	}

	inferenceURL := os.Getenv("GITHUB_INFERENCE_URL")
	if inferenceURL == "" {
		inferenceURL = "https://api.githubcopilot.com"
	}

	env := runner.Environment{
		JobID:          jobID,
		APIToken:       githubToken,
		APIURL:         apiURL,
		JobNonce:       mockServer.Nonce(),
		InferenceToken: githubToken,
		InferenceURL:   inferenceURL,
		GitToken:       githubToken,
	}

	if enableModelSelection {
		env.SelectedEngine = selectedEngine
		env.SelectedModel = selectedModel
		env.DefaultModel = defaultModel
		env.AvailableModels = availableModels
	}

	result := runner.Run(ctx, command, env, runner.Options{WorkingDir: workingDir}, runnerCallbacks)

	// Summary
	allEvents := mockServer.Events()
	totalSuppressed := 0
	for _, c := range suppressedCounts {
		totalSuppressed += c
	}
	displayed := len(allEvents) - totalSuppressed

	fmt.Println(separator)
	if result.ExitCode == 0 {
		fmt.Printf("  %s %s\n", greenStyle.Render("●"), boldStyle.Render("Done"))
	} else {
		fmt.Printf("  %s %s\n", redStyle.Render("●"), boldStyle.Render(fmt.Sprintf("Failed (exit code %d)", result.ExitCode)))
	}
	fmt.Printf("    %s %d displayed, %d total\n", dimStyle.Render("events:"), displayed, len(allEvents))
	if len(suppressedCounts) > 0 {
		// Only show non-platform namespaces in the "other" section
		hasCustom := false
		for key := range suppressedCounts {
			if key.namespace != "" && key.namespace != "sessions-v2" {
				hasCustom = true
				break
			}
		}
		if hasCustom {
			fmt.Printf("    %s\n", dimStyle.Render("other:"))
			for key, count := range suppressedCounts {
				if key.namespace == "" || key.namespace == "sessions-v2" {
					continue
				}
				label := key.namespace + ":" + key.kind
				fmt.Printf("      %s %s\n", mutedStyle.Render(label), mutedStyle.Render(fmt.Sprintf("(%d)", count)))
			}
		}
	}

	// Save history
	if assignmentID != "" && len(allEvents) > 0 {
		records := make([]store.Record, len(allEvents))
		for i, ev := range allEvents {
			records[i] = store.Record{
				ID:        fmt.Sprintf("progress-%d", i+1),
				Namespace: ev.Namespace,
				Kind:      ev.Kind,
				Version:   ev.Version,
				Content:   ev.Content,
				CreatedAt: ev.Timestamp.Unix(),
			}
		}
		_ = store.Save(assignmentID, records)
	}

	if result.ExitCode != 0 {
		return fmt.Errorf("engine exited with code %d", result.ExitCode)
	}
	return nil
}
