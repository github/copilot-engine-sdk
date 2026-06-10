/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Engine SDK Git Utilities
 *
 * Provides git operations for engine implementations:
 * - cloneRepo: Clone a repository, handle branch checkout, configure author
 * - commitAndPush: Stage, commit, and push changes
 * - finalizeChanges: Safety net to commit/push any remaining changes after the agent loop
 */

import { execFileSync } from "child_process";
import { existsSync } from "fs";

const DEFAULT_CLONE_DIR = "/tmp/workspace";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Checks if a branch exists on the remote using ls-remote.
 * This avoids masking auth/network errors as "branch not found".
 */
function branchExistsOnRemote(repoLocation: string, branchName: string): boolean {
    const output = execFileSync("git", ["ls-remote", "--heads", "origin", branchName], {
        cwd: repoLocation,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output.length > 0;
}

// =============================================================================
// Types
// =============================================================================

/**
 * Options for cloning a repository.
 */
export interface CloneRepoOptions {
    /** GitHub server URL (e.g., https://github.com) */
    serverUrl: string;
    /** Repository in owner/repo format */
    repository: string;
    /** Git token for authentication (installation token) */
    gitToken: string;
    /** Branch name to checkout or create */
    branchName?: string;
    /** Git author name for commits */
    commitLogin: string;
    /** Git author email for commits */
    commitEmail: string;
    /** Base directory for cloning (default: /tmp/workspace) */
    cloneDir?: string;
    /** Whether to exclude the repository subfolder (owner/repo) when cloning (default: false) */
    excludeRepoSubfolder?: boolean;
    /** If set, use an environment variable name for Git credential helper rather than embedding the token in the config (default: undefined) */
    credentialHelperEnvVar?: string;
}

/**
 * Result of a commit-and-push operation.
 */
export interface CommitAndPushResult {
    /** Whether the operation succeeded */
    success: boolean;
    /** Whether there were changes to commit */
    hadChanges: boolean;
    /** Human-readable message describing the outcome */
    message: string;
}

// =============================================================================
// Clone
// =============================================================================

/**
 * Clones a repository, handles branch checkout, and configures git author.
 *
 * Branch handling:
 * - If branchName is provided, tries to clone the existing remote branch first
 * - Falls back to cloning the default branch and creating a new local branch
 * - If no branchName, clones the default branch
 *
 * @returns The local path where the repository was cloned
 */
export function cloneRepo(options: CloneRepoOptions): string {
    const { serverUrl, repository, gitToken, credentialHelperEnvVar, excludeRepoSubfolder, branchName, commitLogin, commitEmail } = options;
    const cloneDir = options.cloneDir ?? DEFAULT_CLONE_DIR;
    const repoLocation = excludeRepoSubfolder ? cloneDir : `${cloneDir}/${repository}`;

    const cloneUrl = `${serverUrl.replace(/\/$/, "")}/${repository}.git`;

    const configureGit = () => {
        execFileSync("git", ["config", "user.name", commitLogin], { cwd: repoLocation });
        execFileSync("git", ["config", "user.email", commitEmail], { cwd: repoLocation });
        execFileSync("git", ["config", "credential.username", "x-access-token"], { cwd: repoLocation });
        execFileSync("git", ["config", "credential.helper",
            `!f() { test "$1" = get && echo "password=${credentialHelperEnvVar ? '${' + credentialHelperEnvVar + '}' : gitToken}"; }; f`], { cwd: repoLocation });
        execFileSync("git", ["remote", "set-url", "origin", cloneUrl], { cwd: repoLocation });
    };

    if (existsSync(`${repoLocation}/.git`)) {
        console.log(`[Engine SDK] Repository already cloned at ${repoLocation}`);

        // Configure credentials before fetch
        configureGit();

        // Reset to a clean state and switch to the correct branch
        execFileSync("git", ["clean", "-fd"], { cwd: repoLocation });
        execFileSync("git", ["checkout", "-f", "HEAD"], { cwd: repoLocation });

        if (branchName) {
            // Check if branch exists on remote before attempting fetch
            const remoteBranchExists = branchExistsOnRemote(repoLocation, branchName);
            if (remoteBranchExists) {
                execFileSync("git", ["fetch", "--depth", "2", "origin", branchName], { cwd: repoLocation, stdio: "pipe" });
                execFileSync("git", ["checkout", "-B", branchName, "FETCH_HEAD"], { cwd: repoLocation });
                console.log(`[Engine SDK] Checked out existing branch: ${branchName}`);
            } else {
                // Branch doesn't exist on remote — fetch default branch and create new branch from it
                execFileSync("git", ["fetch", "--depth", "2", "origin"], { cwd: repoLocation, stdio: "pipe" });
                execFileSync("git", ["checkout", "-B", branchName, "FETCH_HEAD"], { cwd: repoLocation });
                console.log(`[Engine SDK] Created new branch: ${branchName}`);
            }
        }
    } else {
        const authHeader = `Authorization: basic ${Buffer.from(`x-access-token:${gitToken}`).toString("base64")}`;

        // Try to clone the existing remote branch directly.
        // If the branch doesn't exist yet, fall back to a default clone + new branch.
        let clonedExistingBranch = false;
        if (branchName) {
            try {
                console.log(`[Engine SDK] Cloning ${repository} (branch: ${branchName}) to ${repoLocation}...`);
                execFileSync(
                    "git",
                    ["-c", `http.extraHeader=${authHeader}`, "clone", "-b", branchName, "--single-branch", "--depth", "2", cloneUrl, repoLocation],
                    { stdio: "inherit" }
                );
                clonedExistingBranch = true;
            } catch {
                console.log(`[Engine SDK] Branch ${branchName} not found on remote, cloning default branch...`);
            }
        }

        if (!clonedExistingBranch) {
            console.log(`[Engine SDK] Cloning ${repository} to ${repoLocation}...`);
            execFileSync("git", ["-c", `http.extraHeader=${authHeader}`, "clone", "--depth", "2", cloneUrl, repoLocation], {
                stdio: "inherit",
            });

            if (branchName) {
                console.log(`[Engine SDK] Creating branch: ${branchName}`);
                execFileSync("git", ["checkout", "-b", branchName], { cwd: repoLocation });
            }
        }

        // Configure credentials and remote URL
        configureGit();
        console.log(`[Engine SDK] Clone complete.`);
    }

    return repoLocation;
}

// =============================================================================
// Commit and Push
// =============================================================================

/**
 * Stages all changes, commits with the given message, and pushes to origin.
 * If there are no changes to commit, only pushes (to catch any prior local commits).
 */
export function commitAndPush(repoLocation: string, commitMessage: string): CommitAndPushResult {
    const status = execFileSync("git", ["status", "--porcelain"], {
        cwd: repoLocation,
        encoding: "utf-8",
    }).trim();

    let hadChanges = false;

    if (status) {
        hadChanges = true;
        execFileSync("git", ["add", "."], { cwd: repoLocation });
        execFileSync("git", ["commit", "-m", commitMessage], { cwd: repoLocation });
    }

    execFileSync("git", ["push", "--set-upstream", "origin", "HEAD"], { cwd: repoLocation });

    return {
        success: true,
        hadChanges,
        message: hadChanges
            ? `Committed and pushed: ${commitMessage}`
            : "No changes to commit. Pushed existing commits.",
    };
}

// =============================================================================
// Finalize
// =============================================================================

/**
 * Safety net called after the agent loop completes.
 * Stages, commits, and pushes any remaining uncommitted changes that the
 * model's report_progress calls may have missed.
 *
 * This is non-fatal — errors are logged but not thrown, since the agent
 * work is already done at this point.
 */
export function finalizeChanges(repoLocation: string, commitMessage: string): void {
    try {
        const result = commitAndPush(repoLocation, commitMessage);
        if (result.hadChanges) {
            console.log(`[Engine SDK] Finalize: committed and pushed remaining changes.`);
        } else {
            console.log(`[Engine SDK] Finalize: no uncommitted changes. Push complete.`);
        }
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[Engine SDK] Finalize: failed - ${msg}`);
    }
}
