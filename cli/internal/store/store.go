// Copyright (c) Microsoft Corporation. All rights reserved.

// Package store provides file-based persistence for progress events across
// engine CLI runs. When an assignment ID is provided, progress events from
// the current run are saved to disk and loaded as "history" on the next run,
// simulating the platform's cross-job history behavior.
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Record is a stored progress event (mirrors the platform's ProgressRecord).
type Record struct {
	ID        string          `json:"id"`
	Namespace string          `json:"namespace"`
	Kind      string          `json:"kind"`
	Version   int             `json:"version"`
	Content   json.RawMessage `json:"content"`
	CreatedAt int64           `json:"created_at"`
}

// historyDir returns ~/.engine-cli/history/{assignmentID}/.
func historyDir(assignmentID string) string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".engine-cli", "history", assignmentID)
}

func historyFile(assignmentID string) string {
	return filepath.Join(historyDir(assignmentID), "previous.json")
}

// Load reads previously saved progress records for the given assignment ID.
// Returns nil (not an error) if no history exists.
func Load(assignmentID string) ([]Record, error) {
	data, err := os.ReadFile(historyFile(assignmentID))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var records []Record
	if err := json.Unmarshal(data, &records); err != nil {
		return nil, err
	}
	return records, nil
}

// Save writes the current run's progress records to disk so the next run
// can load them as history.
func Save(assignmentID string, records []Record) error {
	dir := historyDir(assignmentID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(historyFile(assignmentID), data, 0o644)
}
