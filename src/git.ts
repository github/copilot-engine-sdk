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

// Environment variables carrying the platform-served commit co-author, set by
// the ccav3 app from job details. Used to append a `Co-authored-by` trailer to
// commits this SDK creates (the finalize safety-net commit), mirroring the
// trailer the runtime emits for report_progress commits.
const COAUTHOR_LOGIN_ENV = "GITHUB_COPILOT_COMMIT_COAUTHOR_LOGIN";
const COAUTHOR_EMAIL_ENV = "GITHUB_COPILOT_COMMIT_COAUTHOR_EMAIL";

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

/**
 * Appends a `Co-authored-by` trailer built from the platform-served commit
 * co-author (exposed via GITHUB_COPILOT_COMMIT_COAUTHOR_LOGIN/GITHUB_COPILOT_COMMIT_COAUTHOR_EMAIL)
 * to the commit message. The served email is used verbatim so it matches the
 * trailer the runtime emits and the server-side signing check. Returns the
 * message unchanged when the variables are unset or the trailer is already
 * present.
 */
export function withCoAuthorTrailer(commitMessage: string): string {
    const login = process.env[COAUTHOR_LOGIN_ENV];
    const email = process.env[COAUTHOR_EMAIL_ENV];
    if (!login || !email) {
        return commitMessage;
    }
    const trailer = `Co-authored-by: ${login} <${email}>`;
    const normalizedMessage = commitMessage.trimEnd();
    const lastParagraph = normalizedMessage.split(/\r?\n(?:\r?\n)+/).pop() ?? "";
    if (lastParagraph.split(/\r?\n/).includes(trailer)) {
        return commitMessage;
    }
    return `${normalizedMessage}\n\n${trailer}`;
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
    /**
     * SHA of the commit at HEAD after the push succeeded.
     * Undefined if the SHA could not be resolved; a successful push is never
     * reported as a failure just because this lookup did not work.
     */
    commitSha?: string;
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

    if (credentialHelperEnvVar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialHelperEnvVar)) {
        throw new Error(`Invalid credentialHelperEnvVar: must be a valid environment variable name (letters, digits, underscores; cannot start with a digit)`);
    }

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
 * Runs a git command capturing stdout/stderr. On failure, throws an Error whose
 * message includes git's combined output so the real reason (e.g. a rejected
 * push) is preserved rather than the bare "Command failed: git ..." string.
 */
function git(args: string[], repoLocation: string): string {
    try {
        return execFileSync("git", args, {
            cwd: repoLocation,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        });
    } catch (error) {
        throw new Error(`git ${args.join(" ")} failed: ${gitErrorOutput(error)}`);
    }
}

/** Extracts git's combined stdout/stderr (falling back to the error message) from a thrown exec error. */
function gitErrorOutput(error: unknown): string {
    const e = error as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string } | null;
    const stderr = e?.stderr ? e.stderr.toString().trim() : "";
    const stdout = e?.stdout ? e.stdout.toString().trim() : "";
    const combined = [stdout, stderr].filter(Boolean).join("\n");
    return combined || e?.message || String(error);
}

/** True when a push was rejected because the remote branch has advanced past our local tip. */
function isNonFastForwardError(output: string): boolean {
    return /\(fetch first\)|\(non-fast-forward\)|\[rejected\]|Updates were rejected|tip of your current branch is behind/i.test(
        output,
    );
}

/**
 * Timeout (ms) applied to every git subprocess spawned by the non-fast-forward
 * fallback below. Repos are cloned shallowly (see `cloneRepo`'s `--depth 2`),
 * so any of these operations should complete in seconds; a large value here
 * only exists to fail fast instead of hanging silently until the caller's own
 * (often much longer) timeout kills the process out from under us.
 */
const GIT_SUBPROCESS_TIMEOUT_MS = 60_000;

/**
 * Pushes the current HEAD to origin. If the push is rejected because the remote
 * branch is ahead (non-fast-forward), reconciles onto the new remote tip and
 * retries. Any other failure is rethrown with git's output preserved.
 *
 * Reconciliation deliberately does NOT use `git rebase`. This SDK clones
 * repositories shallowly (`--depth 2`, see `cloneRepo`), so the local branch
 * frequently has no common ancestor with the fetched remote tip once the
 * remote has advanced or been rewritten (e.g. squash-merge, force-push,
 * branch protection workflows). Without a shared base, `git rebase` falls
 * back to replaying every local commit individually via a full patch-id
 * search and three-way merge, each invoking any configured hooks - which is
 * slow, and unbounded, on a large repository, and gets worse linearly with
 * the number of local commits being reapplied. This is a real hang we saw in
 * production: safe pushes to a large monorepo stalled for tens of minutes
 * with no further log output.
 *
 * Instead, we squash our own commits since the last known base into a single
 * diff and apply that diff directly on top of the fetched remote tip. This
 * is O(size of our diff), not O(number of local commits x remote history
 * since diverging), and works correctly even when there is no common
 * ancestor at all. Content-level conflicts (rather than ancestry conflicts)
 * are still detected and rejected the same way `git rebase` would - we
 * simply do not pay the cost of walking commit history to find them.
 *
 * The repository's local git hooks (e.g. pre-push) are intentionally left
 * enabled so we never silently bypass checks the repository owner
 * configured.
 */
function pushWithRebaseFallback(repoLocation: string): void {
    // Capture our current tip before attempting the push. If the push is
    // rejected, this is the commit whose changes (relative to the previous
    // remote tip we forked from) need to be reapplied on top of the new one.
    const localTip = git(["rev-parse", "HEAD"], repoLocation).trim();

    try {
        gitWithTimeout(["push", "--set-upstream", "origin", "HEAD"], repoLocation);
        return;
    } catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        if (!isNonFastForwardError(output)) {
            throw error;
        }
        // Note: stderr, not stdout — commitAndPush runs inside the stdio MCP
        // server (src/mcp-server.ts) where stdout is reserved for the MCP protocol.
        console.error(
            "[Engine SDK] Push rejected because the remote branch is ahead; fetching and reapplying our changes on the new tip...",
        );
    }

    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repoLocation).trim();

    // Find the most recent commit we share with the remote before it moved.
    // This is our own previous push (or the commit we cloned/branched from),
    // so it is always a real ancestor of our local tip - regardless of what
    // has since happened upstream. `@{upstream}` reflects the remote tip as
    // of our last fetch/push, which is exactly the base our own commits were
    // built on top of.
    let previousBase: string;
    try {
        previousBase = git(["rev-parse", `${branch}@{upstream}`], repoLocation).trim();
    } catch (error) {
        // No upstream is configured yet (e.g. first push attempt on a branch
        // created locally without ever fetching). Fall back to the branch's
        // own root - our full local history is then treated as "our diff".
        previousBase = git(["rev-list", "--max-parents=0", "HEAD"], repoLocation).trim().split("\n")[0] ?? localTip;
    }

    // Fetch only the target branch, matching the shallow depth used at clone
    // time - we only need the new tip, not full history, to reapply on top
    // of it.
    gitWithTimeout(["fetch", "--depth", "2", "--no-tags", "origin", branch], repoLocation);
    const newRemoteTip = git(["rev-parse", `origin/${branch}`], repoLocation).trim();

    if (newRemoteTip === previousBase) {
        // The remote didn't actually move relative to what we forked from
        // (e.g. a concurrent push landed and was since superseded, or this
        // is a transient/duplicate rejection). Retrying the plain push is
        // enough; no reconciliation is needed.
        gitWithTimeout(["push", "--set-upstream", "origin", "HEAD"], repoLocation);
        return;
    }

    // Squash everything we've done locally since `previousBase` into a
    // single diff, rather than replaying each commit. We only need the net
    // content change to end up on the remote - the commit boundaries in
    // between are an implementation detail of how the agent got there.
    const diff = git(["diff", "--binary", previousBase, localTip], repoLocation);

    if (diff.trim().length === 0) {
        // Our local commits net out to no content change (e.g. a revert).
        // Nothing to reapply - just move our branch to the new remote tip.
        git(["reset", "--hard", newRemoteTip], repoLocation);
        gitWithTimeout(["push", "--set-upstream", "origin", "HEAD"], repoLocation);
        return;
    }

    // Reset our branch onto the new remote tip, then reapply the diff as a
    // single new commit. `reset --hard` (not checkout of a new branch) keeps
    // us on the same branch ref throughout, so a crash between steps leaves
    // the repo in an obviously-recoverable state rather than a detached
    // reapply branch.
    const priorTip = git(["rev-parse", "HEAD"], repoLocation).trim();
    git(["reset", "--hard", newRemoteTip], repoLocation);

    try {
        // `-3` enables a content-level three-way merge for hunks that don't
        // apply cleanly line-for-line but don't truly conflict (using the
        // blobs recorded in the diff itself, which are still present locally
        // since we just produced this diff from our own history). Real
        // content conflicts still fail loudly, the same as a rebase
        // conflict would, and are reported without silently committing
        // partial/garbled content.
        execFileSync("git", ["apply", "-3", "--index"], {
            cwd: repoLocation,
            input: diff,
            stdio: ["pipe", "pipe", "pipe"],
            timeout: GIT_SUBPROCESS_TIMEOUT_MS,
        });
    } catch (applyError) {
        // Best-effort cleanup: restore our prior local tip so a failed
        // reconciliation doesn't leave the working tree on a bare remote
        // checkout with unmerged/conflicted state.
        try {
            execFileSync("git", ["merge", "--abort"], { cwd: repoLocation, stdio: "pipe" });
        } catch {
            // no merge in progress; ignore
        }
        try {
            execFileSync("git", ["reset", "--hard", priorTip], { cwd: repoLocation, stdio: "pipe" });
        } catch {
            // best-effort cleanup
        }
        throw new Error(
            `Failed to reapply local changes on top of the updated remote branch (likely a genuine content conflict): ${gitErrorOutput(applyError)}`,
        );
    }

    // Recreate a single commit carrying our squashed changes. Using the
    // original commit message set of the local tip keeps this understandable
    // in history, at the cost of losing intermediate commit boundaries -
    // an acceptable trade for a safety-net push.
    const originalMessage = git(["log", "-1", "--format=%B", localTip], repoLocation);
    git(["commit", "-m", originalMessage.trim() || "Reapply changes on updated remote branch"], repoLocation);

    gitWithTimeout(["push", "--set-upstream", "origin", "HEAD"], repoLocation);
}

/**
 * Runs a git subprocess with a bounded timeout so a stalled network call
 * (e.g. a proxy hiccup) fails fast instead of hanging until an external
 * watchdog (like a CI job timeout) tears things down from underneath it.
 */
function gitWithTimeout(args: string[], repoLocation: string): string {
    try {
        return execFileSync("git", args, {
            cwd: repoLocation,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: GIT_SUBPROCESS_TIMEOUT_MS,
        });
    } catch (error) {
        throw new Error(`git ${args.join(" ")} failed: ${gitErrorOutput(error)}`);
    }
}

/**
 * Stages all changes, commits with the given message, and pushes to origin.
 * If there are no changes to commit, only pushes (to catch any prior local commits).
 *
 * The push transparently rebases onto the remote branch if it has advanced. The
 * repository's local git hooks are left enabled so automated CCA pushes do not
 * bypass checks the repository owner configured.
 */
export function commitAndPush(repoLocation: string, commitMessage: string): CommitAndPushResult {
    const status = git(["status", "--porcelain"], repoLocation).trim();

    let hadChanges = false;

    if (status) {
        hadChanges = true;
        git(["add", "."], repoLocation);
        git(["commit", "-m", withCoAuthorTrailer(commitMessage)], repoLocation);
    }

    pushWithRebaseFallback(repoLocation);

    // Resolved only after the push succeeded, so the SHA always refers to a commit
    // that is actually on the remote. Deliberately isolated in its own try/catch:
    // a rev-parse failure must never turn an already-successful push into a
    // reported error, which callers could retry into a duplicate commit.
    let commitSha: string | undefined;
    try {
        commitSha = git(["rev-parse", "HEAD"], repoLocation).trim();
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // Note: stderr, not stdout — commitAndPush runs inside the stdio MCP
        // server (src/mcp-server.ts) where stdout is reserved for the MCP protocol.
        console.error(`[Engine SDK] Push succeeded but resolving the commit SHA failed - ${msg}`);
    }

    return {
        success: true,
        hadChanges,
        message: hadChanges
            ? `Committed and pushed: ${commitMessage}`
            : "No changes to commit. Pushed existing commits.",
        commitSha,
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
