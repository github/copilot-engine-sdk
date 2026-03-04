// Copyright (c) Microsoft Corporation. All rights reserved.

// Package runner handles spawning and managing engine processes.
package runner

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Environment contains the platform environment variables for the engine.
type Environment struct {
	JobID          string
	APIToken       string
	APIURL         string
	JobNonce       string
	InferenceToken string
	GitToken       string
}

// Callbacks contains optional callbacks for runner events.
type Callbacks struct {
	OnStdout func(line string)
	OnStderr func(line string)
}

// Options contains additional options for running an engine.
type Options struct {
	WorkingDir string
	ExtraEnv   map[string]string
}

// Result contains the result of running an engine.
type Result struct {
	ExitCode int
	Error    error
}

// Run executes the engine command with the specified environment.
func Run(ctx context.Context, command string, env Environment, opts Options, callbacks Callbacks) Result {
	// Parse command
	parts := parseCommand(command)
	if len(parts) == 0 {
		return Result{ExitCode: 1, Error: fmt.Errorf("empty command")}
	}

	// Create command
	cmd := exec.CommandContext(ctx, parts[0], parts[1:]...)

	// Set working directory
	if opts.WorkingDir != "" {
		cmd.Dir = opts.WorkingDir
	}

	// Build environment
	cmd.Env = buildEnv(env, opts.ExtraEnv)

	// Set up stdout pipe
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{ExitCode: 1, Error: fmt.Errorf("failed to create stdout pipe: %w", err)}
	}

	// Set up stderr pipe
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return Result{ExitCode: 1, Error: fmt.Errorf("failed to create stderr pipe: %w", err)}
	}

	// Start the command
	if err := cmd.Start(); err != nil {
		return Result{ExitCode: 1, Error: fmt.Errorf("failed to start command: %w", err)}
	}

	// Read stdout in a goroutine
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			if callbacks.OnStdout != nil {
				callbacks.OnStdout(scanner.Text())
			}
		}
	}()

	// Read stderr in a goroutine
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			if callbacks.OnStderr != nil {
				callbacks.OnStderr(scanner.Text())
			}
		}
	}()

	// Wait for the command to finish
	err = cmd.Wait()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return Result{ExitCode: 1, Error: err}
		}
	}

	return Result{ExitCode: exitCode}
}

func buildEnv(env Environment, extra map[string]string) []string {
	// Start with current environment
	result := os.Environ()

	// Add platform environment variables
	// Note: We use GITHUB_* prefix for consistency with GitHub platform conventions
	platformVars := map[string]string{
		"GITHUB_JOB_ID":              env.JobID,
		"GITHUB_JOB_NONCE":           env.JobNonce,
		"GITHUB_PLATFORM_API_TOKEN":  env.APIToken,
		"GITHUB_PLATFORM_API_URL":    env.APIURL,
		"GITHUB_INFERENCE_TOKEN":     env.InferenceToken,
		"GITHUB_GIT_TOKEN":           env.GitToken,
	}

	for k, v := range platformVars {
		result = append(result, fmt.Sprintf("%s=%s", k, v))
	}

	// Add extra environment variables
	for k, v := range extra {
		result = append(result, fmt.Sprintf("%s=%s", k, v))
	}

	return result
}

func parseCommand(command string) []string {
	var parts []string
	var current strings.Builder
	inQuote := false
	quoteChar := rune(0)

	for _, char := range command {
		if inQuote {
			if char == quoteChar {
				inQuote = false
			} else {
				current.WriteRune(char)
			}
		} else if char == '"' || char == '\'' {
			inQuote = true
			quoteChar = char
		} else if char == ' ' {
			if current.Len() > 0 {
				parts = append(parts, current.String())
				current.Reset()
			}
		} else {
			current.WriteRune(char)
		}
	}

	if current.Len() > 0 {
		parts = append(parts, current.String())
	}

	return parts
}
