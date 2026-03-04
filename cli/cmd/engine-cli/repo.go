// Copyright (c) Microsoft Corporation. All rights reserved.

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

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

// SetupResult contains the results of the branch + PR setup.
type SetupResult struct {
	BranchName string
	PRURL      string
	PRNumber   int
}

// setupBranchAndPR creates a branch with an empty commit and opens a draft PR.
func setupBranchAndPR(apiBaseURL, token, owner, repo, branchName, defaultBranch, prTitle, prBody string) (*SetupResult, error) {
	apiURL := strings.TrimSuffix(apiBaseURL, "/")

	// 1. Get the HEAD SHA of the default branch
	headSHA, treeSHA, err := getCommitInfo(apiURL, token, owner, repo, defaultBranch)
	if err != nil {
		return nil, fmt.Errorf("failed to get HEAD commit: %w", err)
	}

	// 2. Create an empty commit (same tree as HEAD)
	commitSHA, err := createEmptyCommit(apiURL, token, owner, repo, headSHA, treeSHA, "Initial plan")
	if err != nil {
		return nil, fmt.Errorf("failed to create empty commit: %w", err)
	}

	// 3. Create the branch pointing at the empty commit
	if err := createBranch(apiURL, token, owner, repo, branchName, commitSHA); err != nil {
		return nil, fmt.Errorf("failed to create branch: %w", err)
	}

	// 4. Create a draft pull request
	prURL, prNumber, err := createPullRequest(apiURL, token, owner, repo, branchName, defaultBranch, prTitle, prBody)
	if err != nil {
		return nil, fmt.Errorf("failed to create pull request: %w", err)
	}

	return &SetupResult{BranchName: branchName, PRURL: prURL, PRNumber: prNumber}, nil
}

func getCommitInfo(apiURL, token, owner, repo, ref string) (commitSHA, treeSHA string, err error) {
	url := fmt.Sprintf("%s/repos/%s/%s/commits/%s", apiURL, owner, repo, ref)
	body, err := githubAPI("GET", url, token, nil)
	if err != nil {
		return "", "", err
	}
	var resp struct {
		SHA    string `json:"sha"`
		Commit struct {
			Tree struct {
				SHA string `json:"sha"`
			} `json:"tree"`
		} `json:"commit"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", "", err
	}
	return resp.SHA, resp.Commit.Tree.SHA, nil
}

func createEmptyCommit(apiURL, token, owner, repo, parentSHA, treeSHA, message string) (string, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/git/commits", apiURL, owner, repo)
	payload := map[string]any{
		"message": message,
		"tree":    treeSHA,
		"parents": []string{parentSHA},
	}
	body, err := githubAPI("POST", url, token, payload)
	if err != nil {
		return "", err
	}
	var resp struct {
		SHA string `json:"sha"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	return resp.SHA, nil
}

func createBranch(apiURL, token, owner, repo, branchName, sha string) error {
	url := fmt.Sprintf("%s/repos/%s/%s/git/refs", apiURL, owner, repo)
	payload := map[string]string{
		"ref": "refs/heads/" + branchName,
		"sha": sha,
	}
	_, err := githubAPI("POST", url, token, payload)
	return err
}

func createPullRequest(apiURL, token, owner, repo, head, base, title, body string) (string, int, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/pulls", apiURL, owner, repo)
	payload := map[string]any{
		"title": title,
		"body":  body,
		"head":  head,
		"base":  base,
		"draft": false,
	}
	respBody, err := githubAPI("POST", url, token, payload)
	if err != nil {
		return "", 0, err
	}
	var resp struct {
		HTMLURL string `json:"html_url"`
		Number  int    `json:"number"`
	}
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return "", 0, err
	}
	return resp.HTMLURL, resp.Number, nil
}

func updatePullRequest(apiURL, token, owner, repo string, prNumber int, title, body string) error {
	url := fmt.Sprintf("%s/repos/%s/%s/pulls/%d", apiURL, owner, repo, prNumber)
	payload := map[string]any{}
	if title != "" {
		payload["title"] = title
	}
	if body != "" {
		payload["body"] = body
	}
	_, err := githubAPI("PATCH", url, token, payload)
	return err
}

func githubAPI(method, url, token string, payload any) ([]byte, error) {
	var reqBody io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "token "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GitHub API %s %s returned %d: %s", method, url, resp.StatusCode, string(body))
	}

	return body, nil
}

// getDefaultBranch fetches the repository's default branch name.
func getDefaultBranch(apiURL, token, owner, repo string) (string, error) {
	url := fmt.Sprintf("%s/repos/%s/%s", apiURL, owner, repo)
	body, err := githubAPI("GET", url, token, nil)
	if err != nil {
		return "", err
	}
	var resp struct {
		DefaultBranch string `json:"default_branch"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return "", err
	}
	return resp.DefaultBranch, nil
}
