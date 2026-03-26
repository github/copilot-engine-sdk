# Building a Copilot Coding Agent Engine

> v1.0.0

> **⚠️ Work in Progress** — This guide describes an API and SDK that are actively under development. Interfaces, response shapes, and behaviors may change before the final release.

This guide walks you through building a custom **engine** — a program that receives a coding task from the Copilot platform, runs an agentic loop against a repository, and streams progress back to users in real time.

> **📦 Reference Implementation** — See [`github/agent-platform-engine-example`](https://github.com/github/agent-platform-engine-example) for a complete working engine built with this SDK.

## What Is an Engine?

An engine is a program that the platform executes when a user triggers a coding task — such as assigning Copilot to an issue, requesting changes on a PR, or invoking a task via the API. The platform creates a **job**, launches your engine in a secure runner environment, and your engine does the work.

You can write an engine in **any language**. The initial SDK we provide is TypeScript, but engines are not limited to TypeScript. If you're using a different language, the SDK source (once open-sourced) documents the HTTP APIs you'd call directly.

### How It Works

```mermaid
sequenceDiagram
    participant User
    participant Platform
    participant Engine as Your Engine
    participant Repo as GitHub Repository

    User->>Platform: Assigns issue / comments on PR / triggers task
    Platform->>Platform: Creates job
    Platform->>Engine: Launches engine with environment variables
    Engine->>Platform: GET /jobs/{jobId} — fetch job details
    Platform-->>Engine: Problem statement, repo metadata, action type, commit attribution
    Engine->>Repo: Clone repository
    loop Each turn
        Engine->>Platform: LLM inference via inference API
        Platform-->>Engine: Model response
        Engine->>Platform: POST /jobs/{jobId}/progress — stream events
    end
    Engine->>Repo: Commit and push changes
```

### Engine Responsibilities

1. **Fetch job details** from the platform API (problem statement, repo metadata, action type)
2. **Clone the repository** using job metadata + `GITHUB_GIT_TOKEN`
3. **Run an agentic loop** using your inference client and `GITHUB_INFERENCE_TOKEN`
4. **Stream progress events** so users can follow the agent's work in the GitHub UI
5. **Commit and push** the resulting changes

## Getting Started

### Prerequisites

- A runtime for your language of choice (the example uses Node.js 20+)
- The Engine SDK (TypeScript: `@github/copilot-engine-sdk`) — optional but recommended; handles platform communication and git operations

### Project Structure

A minimal engine:

```
my-engine/
├── engine.yaml          # Engine definition (required)
├── src/
│   └── index.ts         # Entry point (or your language equivalent)
├── package.json
└── tsconfig.json
```

## Step 1: Define Your Engine

Create an `engine.yaml` file at the root of your repository. This tells the platform how to execute your engine. The `entrypoint` is the fully qualified command that will be run — there is no implicit runtime setup.

```yaml
name: 'My Custom Engine'
description: 'A custom coding agent engine'
author: 'Your Name'

# The fully qualified command to run the engine.
# The platform executes this command directly — no implicit runtime setup.
entrypoint: 'node --enable-source-maps dist/index.js'
```

> **Note:** This is not a GitHub Action. The platform reads `entrypoint` from `engine.yaml` and runs it directly. All paths in the entrypoint are resolved relative to the engine's root directory.

### Environment Variables Reference

The platform injects these environment variables into the engine process at runtime:

| Variable | Required | Description |
|---|---|---|
| `GITHUB_JOB_ID` | Yes | Unique job identifier. Used to fetch job details and report progress. |
| `GITHUB_PLATFORM_API_TOKEN` | Yes | Token for authenticating with the platform API. |
| `GITHUB_PLATFORM_API_URL` | Yes | Base URL for all platform API calls. |
| `GITHUB_JOB_NONCE` | No | Nonce for request validation (included in API headers when present). |
| `GITHUB_INFERENCE_TOKEN` | Yes | Token used by your inference client / SDK for model calls. |
| `GITHUB_INFERENCE_URL` | Yes | Base URL for the inference API (e.g. Copilot API). Use this along with `GITHUB_INFERENCE_TOKEN` to make LLM inference calls. |
| `GITHUB_GIT_TOKEN` | Yes | Token used for authenticated `git clone` / `git push`. |
| `GITHUB_SELECTED_ENGINE` | No | Engine family selected for this run (e.g. `claude`, `codex`). Only set when model selection is enabled. |
| `GITHUB_SELECTED_MODEL` | No | Model selected by the platform for this run. Only set when model selection is enabled. |
| `GITHUB_DEFAULT_MODEL` | No | Default model for the selected engine. Only set when model selection is enabled. |
| `GITHUB_AVAILABLE_MODELS` | No | JSON array of models the engine can choose from (e.g. `["claude-sonnet-4.5","claude-opus-4.1"]`). Only set when model selection is enabled. |
| `GITHUB_MODEL_VENDOR` | No | Model vendor for filtering (e.g. `Anthropic`, `OpenAI`). Only set when model selection is enabled. |

## Step 2: Fetch Job Details

The **first thing your engine should do** is fetch the job details. This call returns task metadata (problem statement, repository info, action type, commit attribution, and optional custom instructions).

### Using the SDK

```typescript
import { PlatformClient } from "@github/copilot-engine-sdk";

const platform = new PlatformClient({
  apiUrl: process.env.GITHUB_PLATFORM_API_URL!,
  jobId: process.env.GITHUB_JOB_ID!,
  token: process.env.GITHUB_PLATFORM_API_TOKEN!,
  nonce: process.env.GITHUB_JOB_NONCE,
});

const job = await platform.fetchJobDetails();
```

### Calling the API Directly

If you're not using the TypeScript SDK, this is a standard HTTP call:

```
GET {GITHUB_PLATFORM_API_URL}/jobs/{GITHUB_JOB_ID}

Headers:
  Authorization: Bearer {GITHUB_PLATFORM_API_TOKEN}
  X-GitHub-Job-Nonce: {GITHUB_JOB_NONCE}    # if nonce is provided
```

### Response Shape

> **Note:** This response shape is not finalized and may change. Treat field names and structure as preliminary.

```json
{
  "ID": "job-123",
  "problem_statement": {
    "content": "The login page throws a 500 error when..."
  },
  "action": "fix",
  "organization_custom_instructions": "Always use TypeScript strict mode...",
  "repository": "octocat/my-repo",
  "server_url": "https://github.com",
  "branch_name": "copilot/fix-123",
  "commit_login": "copilot-bot",
  "commit_email": "copilot-bot@users.noreply.github.com",
  "features": {
    "model_selection": true
  },
  "selected_engine": "claude",
  "selected_model": "claude-sonnet-4.5",
  "default_model": "claude-sonnet-4.5",
  "available_models": ["claude-sonnet-4.5", "claude-opus-4.1"],
  "model_vendor": "Anthropic",
  "mcp_proxy_url": "http://127.0.0.1:2301"
}
```

| Field | Description |
|---|---|
| `problem_statement.content` | The issue body, PR comment, or task description the agent should address. |
| `action` | The type of task: `fix`, `fix-pr-comment`, or `task`. See [Handle Action Types](#step-4-handle-action-types). |
| `organization_custom_instructions` | Optional instructions from the repository's organization to include in your system message. |
| `repository` | Target repository in `owner/repo` format. |
| `server_url` | GitHub server URL (e.g., `https://github.com`). |
| `branch_name` | Branch to checkout or create. |
| `commit_login` | Git author name for commits. |
| `commit_email` | Git author email for commits. |
| `features` | Optional feature flags. Currently supports `model_selection` (boolean). |
| `selected_engine` | Engine family selected for this run (e.g. `claude` or `codex`). Present when `features.model_selection` is `true`. |
| `selected_model` | Model selected by the platform for this run. Present when `features.model_selection` is `true`. |
| `default_model` | Default model for the selected engine. Present when `features.model_selection` is `true`. |
| `available_models` | List of models the engine can choose from. Present when `features.model_selection` is `true`. |
| `model_vendor` | Model vendor for filtering (e.g. `Anthropic`, `OpenAI`). Present when `features.model_selection` is `true`. |
| `mcp_proxy_url` | Optional URL of the MCP proxy server. When present, use it to discover user-provided MCP servers. See [User-Provided MCP Servers](#user-provided-mcp-servers). |

Use `GITHUB_INFERENCE_TOKEN` for model calls and `GITHUB_GIT_TOKEN` for git operations; those are bootstrap action inputs, not job response fields.
The job response may also include additional fields (for example, custom agent configuration) that are not shown in the minimal payload above.

## Step 3: Clone the Repository

Using repository metadata from the job response and `GITHUB_GIT_TOKEN`, clone the target repository.

### Using the SDK

The SDK's `cloneRepo` function handles authentication, branch checkout, and git author configuration:

```typescript
import { cloneRepo } from "@github/copilot-engine-sdk";

const repoLocation = cloneRepo({
  serverUrl: job.server_url,
  repository: job.repository,
  gitToken: process.env.GITHUB_GIT_TOKEN!,
  branchName: job.branch_name,
  commitLogin: job.commit_login,
  commitEmail: job.commit_email,
});
```

### Doing It Yourself

If you're not using the SDK, the clone process is:

1. Build the authenticated URL: `https://x-access-token:{GITHUB_GIT_TOKEN}@github.com/{repository}.git`
2. Try to clone the specific branch: `git clone -b {branch_name} --single-branch --depth 2 {url} {dest}`
3. If the branch doesn't exist on the remote, clone the default branch and create a new local branch: `git checkout -b {branch_name}`
4. Configure the git author:
   ```
   git config user.name "{commit_login}"
   git config user.email "{commit_email}"
   ```

A `branch_name` is always provided in the job response. For `fix` and `task` actions the branch is typically new (your engine creates it), while for `fix-pr-comment` the branch already exists on the remote.

## Step 4: Handle Action Types

The `action` field in the job response tells your engine what type of task it's handling. Your engine should adapt its behavior — particularly the system message — based on this value.

| Action | Trigger | What to Do |
|---|---|---|
| `fix` | Issue assigned to Copilot | Solve the problem described in the issue. Create a new branch, make changes, push. |
| `fix-pr-comment` | Comment or review on a PR | Address the feedback on an existing PR. The branch already exists; make changes and push to it. |
| `task` | API call | Complete a generic task. May or may not involve code changes. |

### Key Differences

- **`fix`**: The problem statement is an issue body. Your agent should analyze the codebase, implement a solution, and push to a new branch. Tailor your system message for problem-solving.
- **`fix-pr-comment`**: The problem statement includes the PR context and reviewer comments. Your agent should address the specific feedback — which may mean making code changes, reverting changes, or providing an explanation. The branch already exists. Tailor your system message for responding to feedback.
- **`task`**: The problem statement is a free-form task description. Handle it flexibly.

```typescript
// Example: branching system message based on action
switch (job.action) {
  case "fix":
    systemMessage = "You are a coding assistant. Solve the problem with minimal changes...";
    break;
  case "fix-pr-comment":
    systemMessage = "You are a coding assistant. Address the PR feedback...";
    break;
  case "task":
    systemMessage = "You are a coding assistant. Complete the described task...";
    break;
}
```

## Step 5: Stream Progress Events

As your agentic loop runs, send progress events to the platform so users can follow the agent's work in the GitHub UI.

### Using the SDK

```typescript
import { PlatformClient } from "@github/copilot-engine-sdk";

const platform = new PlatformClient({
  apiUrl: process.env.GITHUB_PLATFORM_API_URL,
  jobId: process.env.GITHUB_JOB_ID,
  token: process.env.GITHUB_PLATFORM_API_TOKEN,
  nonce: process.env.GITHUB_JOB_NONCE,
});

// When the LLM produces a message (with optional tool calls)
await platform.sendAssistantMessage({
  turn: 0,
  callId: "unique-id",
  content: "I'll start by examining the code...",
  toolCalls: [
    { id: "tc-1", name: "read_file", arguments: '{"path": "src/main.ts"}' },
  ],
});

// When a tool finishes executing
await platform.sendToolMessage({
  turn: 0,
  callId: "unique-id",
  toolCallId: "tc-1",
  toolName: "read_file",
  content: "// file contents here...",
});

// When a tool execution completes (telemetry)
await platform.sendToolExecution({
  turn: 0,
  callId: "unique-id",
  toolCallId: "tc-1",
  toolName: "read_file",
  result: "// file contents...",
  success: true,
});

// When an error occurs
await platform.sendModelCallFailure({
  turn: 0,
  callId: "unique-id",
  error: "Rate limit exceeded",
});
```

### Event Flow

For each LLM turn, the typical event sequence is:

```mermaid
sequenceDiagram
    participant Engine
    participant Inference as Inference API
    participant Platform

    Engine->>Inference: Send prompt + tool results
    Inference-->>Engine: Response with text + tool calls
    Engine->>Platform: sendAssistantMessage (text + tool calls)

    loop For each tool call
        Engine->>Engine: Execute tool
        Engine->>Platform: sendToolMessage (tool result)
        Engine->>Platform: sendToolExecution (telemetry)
    end

    Note over Engine,Platform: Repeat for each turn until LLM finishes
```

### Calling the API Directly

If you're not using the SDK, progress events are sent via:

```
POST {GITHUB_PLATFORM_API_URL}/jobs/{GITHUB_JOB_ID}/progress

Headers:
  Authorization: Bearer {GITHUB_PLATFORM_API_TOKEN}
  Content-Type: application/json
  X-GitHub-Job-Nonce: {GITHUB_JOB_NONCE}    # if nonce is provided

Body:
{
  "namespace": "sessions-v2",
  "kind": "log",
  "version": 0,
  "content": "<JSON-encoded event>"
}
```

The `sessions-v2` namespace tells the platform to accept clean, semantic event payloads. The platform translates them into the wire format the UI expects. If you're implementing progress reporting without the SDK, the event schemas are documented below.

#### Side-Effect Kinds

Three special `sessions-v2` kinds trigger side-effects beyond storing the event:

**`report_progress`** — Updates the PR title and/or description (incremental, during the loop):
```json
{
  "namespace": "sessions-v2",
  "kind": "report_progress",
  "version": 0,
  "content": "{\"pr_title\":\"Fix null pointer in UserService\",\"pr_description\":\"Added null checks...\"}"
}
```

**`comment_reply`** — Replies to a PR comment (for `fix-pr-comment` actions):
```json
{
  "namespace": "sessions-v2",
  "kind": "comment_reply",
  "version": 0,
  "content": "{\"comment_id\":12345,\"message\":\"I've addressed the issue.\"}"
}
```

**`pr_summary`** — Final PR title and description (sent once after the loop, see [Step 8](#step-8-generate-a-pr-summary)):
```json
{
  "namespace": "sessions-v2",
  "kind": "pr_summary",
  "version": 0,
  "content": "{\"pr_title\":\"Fix null pointer in UserService\",\"pr_description\":\"Added null checks to prevent crashes when...\"}"
}
```

All three kinds are stored as progress events first, then the side-effect runs. If the side-effect fails (e.g., the PR doesn't exist), the progress event is still stored and the HTTP response is still `201 Created`.

### PlatformClient API

```typescript
interface PlatformClientConfig {
  apiUrl: string;        // Platform API base URL
  jobId: string;         // Job ID
  token: string;         // Platform API token
  nonce?: string;        // Job nonce
  namespace?: string;    // Event namespace (default: "sessions-v2")
}

class PlatformClient {
  sendAssistantMessage(options): Promise<SendResult>;
  sendToolMessage(options): Promise<SendResult>;
  sendToolExecution(options): Promise<SendResult>;
  sendModelCallFailure(options): Promise<SendResult>;
  sendTruncation(options): Promise<SendResult>;
  sendResponse(options): Promise<SendResult>;
  sendReportProgress(options): Promise<SendResult>;  // Update PR title/description
  sendCommentReply(options): Promise<SendResult>;     // Reply to a PR comment
  sendProgress(event: Event): Promise<SendResult>;    // Low-level: send any event

  // Generic progress APIs — for session history and custom persistence (see Step 8)
  sendRawProgress(payloads: ProgressPayload | ProgressPayload[]): Promise<SendResult>;
  fetchProgress(options?: { namespace?: string; history?: boolean }): Promise<ProgressRecord[] | null>;
}
```

## Step 6: Provide Tools via MCP

Engines provide tools to the LLM via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers. The Engine SDK includes a built-in MCP server with the `report_progress` tool (and optionally `reply_to_comment` for PR comment actions), which commits changes and reports progress to users.

```typescript
// The SDK provides a pre-built MCP server
const mcpServerPath = require.resolve("@github/copilot-engine-sdk/mcp-server");

// Configure it when creating your LLM session
// For "fix" actions, provide report_progress
// For "fix-pr-comment" actions, also include reply_to_comment
const tools = action === "fix-pr-comment"
  ? ["report_progress", "reply_to_comment"]
  : ["report_progress"];

const session = await llmClient.createSession({
  mcpServers: {
    "engine-tools": {
      command: "node",
      args: [mcpServerPath, repoLocation],
      tools,
    },
  },
});
```

### The `report_progress` Tool

This is the primary tool your agent uses to save and share its work. When called, it:

1. Stages all changes (`git add .`)
2. Commits with the provided message
3. Pushes to the remote branch
4. Sends a `report_progress` event to update the PR title and description

```
report_progress(
  commitMessage: "Fix null pointer in user service",
  prDescription: "## Plan\n- [x] Identify the bug\n- [x] Add null check\n- [ ] Add tests"
)
```

The platform receives the `report_progress` event and updates the associated pull request. It preserves auto-generated suffixes and tips in the PR body.

### The `reply_to_comment` Tool

This tool is available when the action is `fix-pr-comment`. It replies to the PR comment that triggered the job:

```
reply_to_comment(
  commentId: 12345,
  message: "I've fixed the issue you mentioned. The null check has been added."
)
```

When called, it sends a `comment_reply` event to the platform, which posts a reply to the original comment with a truncated quote of the original text and removes the 👀 reaction.

### User-Provided MCP Servers

Users can configure their own MCP servers (for example, code search, documentation tools, or database access) through the platform. These servers are **started by the platform before your engine is launched** and run outside the firewall so they have unrestricted network access.

The job response includes an `mcp_proxy_url` field when user MCP servers are configured. The proxy is an HTTP server that bridges your engine to the user's MCP servers. Your engine discovers available servers from the proxy and connects to them as HTTP MCP endpoints.

#### Discovery Flow

```mermaid
sequenceDiagram
    participant Engine
    participant Proxy as MCP Proxy (localhost:2301)
    participant MCP as User MCP Server

    Engine->>Proxy: GET /health
    Proxy-->>Engine: 200 OK
    Engine->>Proxy: GET /mcp/servers
    Proxy-->>Engine: { servers: [{ name: "my-tools", proxyEndpoint: "/mcp/my-tools" }] }
    Note over Engine: Build HTTP MCP configs
    Engine->>Proxy: MCP protocol via /mcp/my-tools
    Proxy->>MCP: Forward to actual server
    MCP-->>Proxy: Tool results
    Proxy-->>Engine: Tool results
```

#### Using the SDK

```typescript
import { discoverMCPServers } from "@github/copilot-engine-sdk";

// Discover user MCP servers from the proxy URL in job details
const userMCPServers = job.mcp_proxy_url
  ? await discoverMCPServers(job.mcp_proxy_url)
  : {};

// Pass to createSession — they merge with your built-in tools
const session = await llmClient.createSession({
  mcpServers: {
    // Built-in engine tools (stdio)
    "engine-tools": {
      command: "node",
      args: [mcpServerPath, repoLocation],
      tools: ["report_progress"],
    },
    // User-provided servers (HTTP, via proxy)
    ...userMCPServers,
  },
});
```

#### Doing It Yourself

If you're not using the SDK, the discovery is two HTTP calls:

1. **Health check**: `GET {mcp_proxy_url}/health` — returns 200 if proxy is available
2. **List servers**: `GET {mcp_proxy_url}/mcp/servers` — returns `{ "servers": [{ "name": "...", "proxyEndpoint": "..." }] }`

For each discovered server, connect to `{mcp_proxy_url}{proxyEndpoint}` (using the `proxyEndpoint` from the response) as an HTTP MCP endpoint using the standard [MCP protocol](https://modelcontextprotocol.io/). If `proxyEndpoint` is an absolute URL, use it directly.

All tools from all servers are exposed. There is no per-server tool filtering.

If you're not using the SDK, connect to each configured MCP server as a standard MCP client, using the auth fields provided in its config. The MCP protocol specification is available at [modelcontextprotocol.io](https://modelcontextprotocol.io/).

### Custom Tools

You can also bundle your own MCP servers alongside the built-in and user-provided ones. Any tool your LLM supports as an MCP server will work.

## Step 7: Finalize Changes

After your agentic loop completes, run a final sweep to commit and push any remaining changes. The `report_progress` tool is called by the LLM during execution, but since that's non-deterministic, your engine should always do a final check.

### Using the SDK

```typescript
import { finalizeChanges } from "@github/copilot-engine-sdk";

// After the agentic loop
finalizeChanges(repoLocation, "Finalize changes");
```

### Doing It Yourself

```bash
# Check for uncommitted changes
git status --porcelain

# If there are changes, stage and commit
git add .
git commit -m "Finalize changes"

# Always push (catches any locally committed changes too)
git push --set-upstream origin HEAD
```

This should be non-fatal — if there's nothing to commit or the push fails, log the outcome but don't fail the engine.

### SDK Git Utilities API

```typescript
function cloneRepo(options: CloneRepoOptions): string;
function commitAndPush(repoLocation: string, commitMessage: string): CommitAndPushResult;
function finalizeChanges(repoLocation: string, commitMessage: string): void;

interface CommitAndPushResult {
  success: boolean;
  hadChanges: boolean;
  message: string;
}
```

## Step 8: Generate a PR Summary

For `fix` and `fix-pr-comment` actions, your engine should generate a final, polished PR title and description after the agentic loop completes. This replaces the incremental `report_progress` checklist with a proper summary that reads well on the pull request.

Skip this step for `task` actions — they may not produce a pull request.

### How It Works

After the agentic loop finishes, send a follow-up prompt to the LLM asking it to summarize the work as a PR title and description. The LLM has the full conversation context (all tool calls, code changes, reasoning), so it can produce an accurate summary. Then send the result as a `pr_summary` progress event.

### Using the SDK

```typescript
// After the agentic loop completes (sendAndWait returned)
if (action !== "task") {
  // Send a follow-up in the same session — the LLM retains full context
  const response = await session.sendAndWait({
    prompt: `Write a final PR title and description for the changes you made.
Respond with <pr_title>...</pr_title> and <pr_description>...</pr_description> XML tags.
Do NOT use any tools.`,
  });

  // Parse the XML tags from the response
  const content = response?.data?.content ?? "";
  const titleMatch = content.match(/<pr_title>\s*([\s\S]*?)\s*<\/pr_title>/);
  const descMatch = content.match(/<pr_description>\s*([\s\S]*?)\s*<\/pr_description>/);

  if (titleMatch && descMatch) {
    await platform.sendRawProgress({
      namespace: "sessions-v2",
      kind: "pr_summary",
      version: 0,
      content: JSON.stringify({
        pr_title: titleMatch[1].trim(),
        pr_description: descMatch[1].trim(),
      }),
    });
  }
}
```

### Calling the API Directly

```
POST {GITHUB_PLATFORM_API_URL}/jobs/{GITHUB_JOB_ID}/progress

Headers:
  Authorization: Bearer {GITHUB_PLATFORM_API_TOKEN}
  Content-Type: application/json
  X-GitHub-Job-Nonce: {GITHUB_JOB_NONCE}    # if nonce is provided

Body:
{
  "namespace": "sessions-v2",
  "kind": "pr_summary",
  "version": 0,
  "content": "{\"pr_title\":\"Fix null pointer in UserService\",\"pr_description\":\"Added null checks to prevent crashes when...\"}"
}
```

The platform receives the `pr_summary` event and updates the associated pull request's title and description — the same behavior as `report_progress`, but semantically this is the final, polished version.

### Key Differences from `report_progress`

| | `report_progress` | `pr_summary` |
|---|---|---|
| **When** | During the agentic loop (multiple times) | Once, after the loop completes |
| **Content** | Incremental checklist of completed/remaining work | Final, polished PR title and description |
| **Who sends it** | The LLM via the `report_progress` tool | Your engine code, after prompting the LLM |
| **For actions** | All actions | `fix` and `fix-pr-comment` only |

### For `fix-pr-comment` Actions

When responding to PR feedback, the scope of changes may be minor (fixing linters, style tweaks). If the LLM determines the existing PR title and description are still accurate, it can skip the update. Design your prompt to allow this — for example, by accepting a `NO_CONTENT` sentinel in lieu of XML tags.

## Step 9: Persist and Restore Session History (Optional)

Engines run in a secure runner environment, which means your process may be restarted (container preemption, timeout retry, follow-up jobs on the same assignment). The progress API doubles as a **persistence layer** — you can save arbitrary session state as progress events and retrieve it on the next run to resume where you left off.

This works because:
- Progress events are stored durably by the platform
- The `history=true` query parameter returns events from **previous jobs** on the same assignment
- You control the `namespace` and `kind` fields, so your history events don't collide with UI-facing events

### How It Works

```mermaid
sequenceDiagram
    participant Engine as Engine (Run N)
    participant Platform
    participant Engine2 as Engine (Run N+1)

    Note over Engine: Agentic loop completes
    Engine->>Platform: POST /progress — save session state
    Note over Platform: Events stored durably

    Note over Engine2: New run starts
    Engine2->>Platform: GET /progress?namespace=my-engine&history=true
    Platform-->>Engine2: Events from run N
    Engine2->>Engine2: Restore session state
    Engine2->>Engine2: Resume agentic loop
```

### Saving State

Use `sendRawProgress` to save your session state under a **custom namespace**. The namespace can be any string — pick something unique to your engine to avoid collisions with UI events (`sessions-v2`) or other engines.

#### Using the SDK

```typescript
import { PlatformClient, ProgressPayload } from "@github/copilot-engine-sdk";

const platform = new PlatformClient({ apiUrl, jobId, token, nonce });

// Save a metadata record (e.g., session ID, checkpoint info)
await platform.sendRawProgress({
  namespace: "my-engine",
  kind: "session-meta",
  version: 0,
  content: JSON.stringify({ sessionId: "abc-123", model: "claude-sonnet-4.5" }),
});

// Save session state — could be anything: conversation log, file snapshots, etc.
await platform.sendRawProgress({
  namespace: "my-engine",
  kind: "session-state",
  version: 0,
  content: JSON.stringify({ messages: [...], checkpointId: "cp-42" }),
});
```

#### Batching

For large state (e.g., hundreds of conversation turns), send multiple records in a single call. The platform supports batch creates — pass an array instead of a single object:

```typescript
const records: ProgressPayload[] = lines.map(line => ({
  namespace: "my-engine",
  kind: "conversation-line",
  version: 0,
  content: line,
}));

// Send in batches of 100
for (let i = 0; i < records.length; i += 100) {
  await platform.sendRawProgress(records.slice(i, i + 100));
}
```

#### Calling the API Directly

```
POST {GITHUB_PLATFORM_API_URL}/jobs/{GITHUB_JOB_ID}/progress

Headers:
  Authorization: Bearer {GITHUB_PLATFORM_API_TOKEN}
  Content-Type: application/json
  X-GitHub-Job-Nonce: {GITHUB_JOB_NONCE}    # if nonce is provided

Body (single):
{
  "namespace": "my-engine",
  "kind": "session-meta",
  "version": 0,
  "content": "{\"sessionId\":\"abc-123\"}"
}

Body (batch):
[
  { "namespace": "my-engine", "kind": "session-meta", "version": 0, "content": "..." },
  { "namespace": "my-engine", "kind": "session-state", "version": 0, "content": "..." }
]
```

### Restoring State

On startup, fetch progress with `history=true` and your namespace to retrieve events from previous runs:

#### Using the SDK

```typescript
const records = await platform.fetchProgress({
  namespace: "my-engine",
  history: true,
});

if (records && records.length > 0) {
  // Find your metadata
  const meta = records.find(r => r.kind === "session-meta");
  const stateRecords = records.filter(r => r.kind === "session-state");

  // Restore your session from the retrieved records
  if (meta) {
    const { sessionId } = JSON.parse(meta.content);
    // ... rebuild your session state
  }
}
```

#### Calling the API Directly

```
GET {GITHUB_PLATFORM_API_URL}/jobs/{GITHUB_JOB_ID}/progress?namespace=my-engine&history=true

Headers:
  Authorization: Bearer {GITHUB_PLATFORM_API_TOKEN}
  X-GitHub-Job-Nonce: {GITHUB_JOB_NONCE}    # if nonce is provided
```

Returns an array of `ProgressRecord` objects:

```json
[
  {
    "id": "evt-1",
    "namespace": "my-engine",
    "kind": "session-meta",
    "version": 0,
    "content": "{\"sessionId\":\"abc-123\"}",
    "created_at": 1706000000
  },
  {
    "id": "evt-2",
    "namespace": "my-engine",
    "kind": "session-state",
    "version": 0,
    "content": "{\"messages\":[...]}",
    "created_at": 1706000001
  }
]
```

### Design Considerations

**Namespace isolation.** Use a namespace unique to your engine. The `sessions-v2` namespace is reserved for UI-facing events. The platform only dispatches side-effects (PR updates, comment replies) for `sessions-v2` events — your custom namespace events are stored without side-effects.

**Content is opaque.** The `content` field is a JSON string that the platform stores but does not interpret. You can put anything in it — serialized conversation history, binary-encoded checkpoints (base64), file contents, or structured metadata. The format is entirely up to your engine.

**Kind as a discriminator.** Use different `kind` values to distinguish record types within your namespace (e.g., `session-meta` vs `session-state` vs `conversation-line`). This makes filtering and parsing straightforward on restore.

**History spans jobs, not assignments.** The `history=true` flag returns events from the **previous job** on the same assignment. If an assignment goes through multiple retries or follow-up jobs, each run can see what the prior run saved.

**Batch size limits.** The platform accepts up to 100 records per batch request. For larger payloads, chunk your records into batches of 100.

**Idempotency.** Progress events are append-only. Saving the same state twice creates duplicate records. If your engine might restart mid-save, design your restore logic to handle duplicates (e.g., use the latest meta record, or deduplicate by content).

## Putting It All Together

Here's the complete flow of a minimal engine:

```mermaid
flowchart LR
    A[Read env vars] --> B[Fetch job details]
    B --> C[Clone repo]
    C --> D{History exists?}
    D -- Yes --> E[Restore session]
    D -- No --> F[Run agentic loop]
    E --> F
    F --> G{Action ≠ task?}
    G -- Yes --> H[Generate PR summary]
    G -- No --> I[Finalize changes]
    H --> I
    I --> J[Save session history]
```

```typescript
import { PlatformClient, cloneRepo, finalizeChanges, resolveSelectedModel } from "@github/copilot-engine-sdk";
import { CopilotClient } from "@github/copilot-sdk";

async function main() {
  // 1. Read bootstrap inputs from environment
  const jobId = process.env.GITHUB_JOB_ID!;
  const apiToken = process.env.GITHUB_PLATFORM_API_TOKEN!;
  const apiUrl = process.env.GITHUB_PLATFORM_API_URL!;
  const nonce = process.env.GITHUB_JOB_NONCE;
  const gitToken = process.env.GITHUB_GIT_TOKEN!;
  const inferenceToken = process.env.GITHUB_INFERENCE_TOKEN!;

  const platform = new PlatformClient({
    apiUrl,
    jobId,
    token: apiToken,
    nonce,
  });

  // 2. Fetch job details (problem statement, repo metadata, action type)
  const job = await platform.fetchJobDetails();

  // 3. Clone the repository
  const repoLocation = cloneRepo({
    serverUrl: job.server_url,
    repository: job.repository,
    gitToken,
    branchName: job.branch_name,
    commitLogin: job.commit_login,
    commitEmail: job.commit_email,
  });

  // 4. Initialize platform client for streaming progress
  const platform = new PlatformClient({ apiUrl, jobId, token: apiToken, nonce });

  // 5. Build system message based on action type
  const systemMessage = buildSystemMessage(job.action, job);
  const model = resolveSelectedModel(job, {
    fallbackModel: "claude-sonnet-4.5",
  }) ?? "claude-sonnet-4.5";

  // 6. Run your agentic loop with your inference client
  const client = new CopilotClient({
    cwd: repoLocation,
    githubToken: inferenceToken,
  });

  const mcpServerPath = require.resolve("@github/copilot-engine-sdk/mcp-server");

  const session = await client.createSession({
    model,
    systemMessage: { content: systemMessage },
    mcpServers: {
      "engine-tools": {
        command: "node",
        args: [mcpServerPath, repoLocation],
        tools: ["report_progress"],
      },
    },
  });

  session.on((event) => {
    // Map session events → platform progress events
    platform.sendAssistantMessage({ ... });
    platform.sendToolMessage({ ... });
  });

  await session.sendAndWait({ prompt: job.problem_statement.content });

  // 7. Finalize — commit and push any remaining changes
  finalizeChanges(repoLocation, "Finalize changes");
}
```

## Architecture Notes

### Tokens

Your engine uses three bootstrap tokens:

| Token | Purpose | Example Prefix |
|---|---|---|
| `GITHUB_PLATFORM_API_TOKEN` | Platform API authentication (`GET /jobs/{id}`, `POST /jobs/{id}/progress`). | `ghp_*` |
| `GITHUB_GIT_TOKEN` | Git operations only (`clone`, `push`). | `ghs_*` / `ghp_*` |
| `GITHUB_INFERENCE_TOKEN` | Inference authentication for your model client / SDK. | `ghp_*` |

### Inference

For inference, authenticate your model client/SDK with `GITHUB_INFERENCE_TOKEN`. In the TypeScript example, `@github/copilot-sdk` uses this token via `githubToken`.

### Event Format

Engines send clean, semantic events (assistant messages, tool results, errors) under the `sessions-v2` namespace. The platform translates these into the wire format the UI renders. The `PlatformClient` in the SDK handles building and sending these events automatically. If you're building without the SDK, use the `sessions-v2` namespace and the event schemas documented above.

### Progress Events Are Async

When you send a progress event, it flows through an asynchronous pipeline before reaching the UI. This means there may be a brief delay between sending an event and seeing it rendered. Events are delivered reliably and in order, but not instantaneously.

### Runtime Environment

Your engine runs in a **secure runner environment**, which means:

- Common language runtimes (Node.js, Python, Go, etc.) are usually available under the default runner image. If your runtime is not available, your entrypoint command should install it.
- **Git** is available on PATH
- **Network access** to the platform API and GitHub (for git operations)
- Standard runner filesystem behavior applies
