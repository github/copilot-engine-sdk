// Copyright (c) Microsoft Corporation. All rights reserved.

// Package server implements a mock platform server for testing engines.
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/github/copilot-engine-sdk/cli/internal/store"
)

// JobConfig contains the configuration for the mock job.
type JobConfig struct {
	JobID                    string
	ProblemStatement         string
	OrganizationInstructions string
	Action                   string
	Repository               string
	ServerURL                string
	BranchName               string
	CommitLogin              string
	CommitEmail              string
	MCPProxyURL              string
	EnableModelSelection     bool
	SelectedModel            string
	DefaultModel             string
	AvailableModels          []string
	ModelVendors             []string
}

// ProgressEvent represents a progress event received from an engine.
type ProgressEvent struct {
	Timestamp time.Time
	Namespace string
	Kind      string
	Version   int
	Content   json.RawMessage
}

// Callbacks contains optional callbacks for server events.
type Callbacks struct {
	OnProgressEvent func(event ProgressEvent)
	OnJobFetched    func()
}

// MockPlatformServer implements the platform API for testing engines.
type MockPlatformServer struct {
	jobConfig      JobConfig
	callbacks      Callbacks
	nonce          string
	server         *http.Server
	listener       net.Listener
	progressEvents []ProgressEvent
	previousEvents []store.Record // history from a previous run (loaded from disk)
	mu             sync.Mutex
}

// New creates a new mock platform server.
func New(config JobConfig, callbacks Callbacks) *MockPlatformServer {
	return &MockPlatformServer{
		jobConfig:      config,
		callbacks:      callbacks,
		nonce:          generateNonce(),
		progressEvents: make([]ProgressEvent, 0),
	}
}

// SetPreviousEvents loads history from a prior run so the GET progress
// endpoint can return them when ?history=true is requested.
func (s *MockPlatformServer) SetPreviousEvents(events []store.Record) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.previousEvents = events
}

func generateNonce() string {
	bytes := make([]byte, 16)
	_, _ = rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

// Nonce returns the job nonce for authentication.
func (s *MockPlatformServer) Nonce() string {
	return s.nonce
}

// Events returns a copy of all received progress events.
func (s *MockPlatformServer) Events() []ProgressEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	events := make([]ProgressEvent, len(s.progressEvents))
	copy(events, s.progressEvents)
	return events
}

// Start starts the mock server on the specified port (0 for random).
func (s *MockPlatformServer) Start(port int) (int, error) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleRequest)

	s.server = &http.Server{
		Handler: mux,
	}

	var err error
	s.listener, err = net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return 0, fmt.Errorf("failed to listen: %w", err)
	}

	go func() {
		_ = s.server.Serve(s.listener)
	}()

	return s.listener.Addr().(*net.TCPAddr).Port, nil
}

// Stop stops the mock server.
func (s *MockPlatformServer) Stop(ctx context.Context) error {
	if s.server != nil {
		return s.server.Shutdown(ctx)
	}
	return nil
}

var (
	getJobRegex   = regexp.MustCompile(`^/agent/jobs/([^/]+)$`)
	progressRegex = regexp.MustCompile(`^/agent/jobs/([^/]+)/progress$`)
)

func (s *MockPlatformServer) handleRequest(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	// Route: GET /agent/jobs/{jobId}
	if r.Method == http.MethodGet {
		if matches := getJobRegex.FindStringSubmatch(path); matches != nil {
			s.handleGetJob(w, r, matches[1])
			return
		}
		// Route: GET /agent/jobs/{jobId}/progress
		if matches := progressRegex.FindStringSubmatch(path); matches != nil {
			s.handleGetProgress(w, r, matches[1])
			return
		}
	}

	// Route: POST /agent/jobs/{jobId}/progress
	if r.Method == http.MethodPost {
		if matches := progressRegex.FindStringSubmatch(path); matches != nil {
			s.handlePostProgress(w, r, matches[1])
			return
		}
	}

	// 404 for unknown routes
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusNotFound)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "Not Found"})
}

func (s *MockPlatformServer) handleGetJob(w http.ResponseWriter, r *http.Request, jobID string) {
	// Validate nonce
	nonce := r.Header.Get("X-GitHub-Job-Nonce")
	if nonce != s.nonce {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid nonce"})
		return
	}

	// Validate job ID
	if jobID != s.jobConfig.JobID {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Job not found"})
		return
	}

	// Build response
	response := map[string]any{
		"ID": s.jobConfig.JobID,
		"problem_statement": map[string]string{
			"content": s.jobConfig.ProblemStatement,
		},
		"action":       s.jobConfig.Action,
		"repository":   s.jobConfig.Repository,
		"server_url":   s.jobConfig.ServerURL,
		"commit_login": s.jobConfig.CommitLogin,
		"commit_email": s.jobConfig.CommitEmail,
	}

	if s.jobConfig.BranchName != "" {
		response["branch_name"] = s.jobConfig.BranchName
	}

	if s.jobConfig.OrganizationInstructions != "" {
		response["organization_custom_instructions"] = s.jobConfig.OrganizationInstructions
	}

	if s.jobConfig.MCPProxyURL != "" {
		response["mcp_proxy_url"] = s.jobConfig.MCPProxyURL
	}

	if s.jobConfig.EnableModelSelection {
		response["features"] = map[string]any{
			"model_selection": true,
		}

		if s.jobConfig.SelectedModel != "" {
			response["selected_model"] = s.jobConfig.SelectedModel
		}

		if s.jobConfig.DefaultModel != "" {
			response["default_model"] = s.jobConfig.DefaultModel
		}

		if len(s.jobConfig.AvailableModels) > 0 {
			response["available_models"] = s.jobConfig.AvailableModels
		}

		if len(s.jobConfig.ModelVendors) > 0 {
			response["model_vendors"] = s.jobConfig.ModelVendors
		}
	}

	if s.callbacks.OnJobFetched != nil {
		s.callbacks.OnJobFetched()
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(response)
}

type progressPayload struct {
	Namespace string `json:"namespace"`
	Kind      string `json:"kind"`
	Version   int    `json:"version"`
	Content   string `json:"content"`
}

func (s *MockPlatformServer) handlePostProgress(w http.ResponseWriter, r *http.Request, jobID string) {
	// Validate nonce
	nonce := r.Header.Get("X-GitHub-Job-Nonce")
	if nonce != s.nonce {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid nonce"})
		return
	}

	// Validate job ID
	if jobID != s.jobConfig.JobID {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Job not found"})
		return
	}

	// Parse request body — accept single object or array
	var raw json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body"})
		return
	}

	var payloads []progressPayload
	isBatch := len(raw) > 0 && raw[0] == '['
	if isBatch {
		if err := json.Unmarshal(raw, &payloads); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body"})
			return
		}
	} else {
		var single progressPayload
		if err := json.Unmarshal(raw, &single); err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid request body"})
			return
		}
		payloads = []progressPayload{single}
	}

	var results []map[string]string
	for _, payload := range payloads {
		// Validate content is valid JSON
		if !json.Valid([]byte(payload.Content)) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid content JSON"})
			return
		}

		event := ProgressEvent{
			Timestamp: time.Now(),
			Namespace: payload.Namespace,
			Kind:      payload.Kind,
			Version:   payload.Version,
			Content:   json.RawMessage(payload.Content),
		}

		s.mu.Lock()
		s.progressEvents = append(s.progressEvents, event)
		eventCount := len(s.progressEvents)
		s.mu.Unlock()

		if s.callbacks.OnProgressEvent != nil {
			s.callbacks.OnProgressEvent(event)
		}

		results = append(results, map[string]string{"id": fmt.Sprintf("progress-%d", eventCount)})
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	if isBatch {
		_ = json.NewEncoder(w).Encode(results)
	} else {
		_ = json.NewEncoder(w).Encode(results[0])
	}
}

func (s *MockPlatformServer) handleGetProgress(w http.ResponseWriter, r *http.Request, jobID string) {
	// Validate nonce
	nonce := r.Header.Get("X-GitHub-Job-Nonce")
	if nonce != s.nonce {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Invalid nonce"})
		return
	}

	// Validate job ID
	if jobID != s.jobConfig.JobID {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Job not found"})
		return
	}

	// Parse query params
	query := r.URL.Query()
	includeHistory := query.Get("history") == "true"
	namespaces := parseNamespaces(query.Get("namespace"))

	var result []store.Record

	// Include history from previous run if requested
	if includeHistory {
		s.mu.Lock()
		prev := s.previousEvents
		s.mu.Unlock()
		for _, rec := range prev {
			if matchesNamespace(rec.Namespace, namespaces) {
				result = append(result, rec)
			}
		}
	}

	// Include current run events
	s.mu.Lock()
	current := make([]ProgressEvent, len(s.progressEvents))
	copy(current, s.progressEvents)
	s.mu.Unlock()

	for i, ev := range current {
		if matchesNamespace(ev.Namespace, namespaces) {
			result = append(result, store.Record{
				ID:        fmt.Sprintf("progress-%d", i+1),
				Namespace: ev.Namespace,
				Kind:      ev.Kind,
				Version:   ev.Version,
				Content:   ev.Content,
				CreatedAt: ev.Timestamp.Unix(),
			})
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(result)
}

// parseNamespaces splits a comma-separated namespace string into a slice.
func parseNamespaces(raw string) []string {
	if raw == "" {
		return nil
	}
	var ns []string
	for _, n := range strings.Split(raw, ",") {
		n = strings.TrimSpace(n)
		if n != "" {
			ns = append(ns, n)
		}
	}
	return ns
}

// matchesNamespace returns true if the given namespace matches the filter,
// or if no filter is applied.
func matchesNamespace(ns string, filter []string) bool {
	if len(filter) == 0 {
		return true
	}
	for _, f := range filter {
		if f == ns {
			return true
		}
	}
	return false
}
