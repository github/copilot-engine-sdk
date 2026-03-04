# @github/copilot-engine-sdk

SDK for building engines on the GitHub Copilot agent platform.

## Overview

The Copilot Engine SDK provides the building blocks for engines that run on the GitHub Copilot agent platform. It handles:

- **Platform event reporting** — send structured events (assistant messages, tool executions, model call failures) to the platform API
- **Git utilities** — clone repositories, commit and push changes with proper credential configuration
- **MCP server** — a Model Context Protocol server exposing `report_progress` and `reply_to_comment` tools for use with any LLM SDK

## Installation

This package is hosted as a private GitHub repository. Add it to your `package.json`:

```json
{
  "dependencies": {
    "@github/copilot-engine-sdk": "github:github/copilot-engine-sdk#main"
  }
}
```

Then run `npm install`. Git credentials must be available for private repo access (e.g., `GITHUB_TOKEN`, SSH keys, or git credential helper).

### Local Development

For local development with a cloned copy of the SDK:

```bash
# In the SDK directory — register for linking and build
cd copilot-engine-sdk
npm link

# In your engine directory — link to local SDK
cd ../your-engine
npm link @github/copilot-engine-sdk
```

Changes to the SDK source are reflected immediately after running `npm run build` in the SDK directory.

## Quick Start

```typescript
import {
  PlatformClient,
  cloneRepo,
  finalizeChanges,
  createEngineMcpServer,
} from "@github/copilot-engine-sdk";

// Initialize the platform client for event reporting
const platform = new PlatformClient({
  apiUrl: process.env.GITHUB_PLATFORM_API_URL!,
  jobId: process.env.GITHUB_JOB_ID!,
  token: process.env.GITHUB_PLATFORM_API_TOKEN!,
});

// Clone the target repository
const repoLocation = cloneRepo({
  serverUrl: "https://github.com",
  repository: "owner/repo",
  gitToken: process.env.GITHUB_GIT_TOKEN!,
  branchName: "copilot/fix-issue-123",
  commitLogin: "copilot[bot]",
  commitEmail: "copilot@github.com",
});

// Send events to the platform
await platform.sendAssistantMessage({
  turn: 1,
  callId: "call-123",
  content: "I'll help you with that.",
  toolCalls: [],
});

// Finalize and push any remaining changes
finalizeChanges(repoLocation, "Apply fixes");
```

## API Reference

### PlatformClient

The main client for communicating with the platform API.

```typescript
const platform = new PlatformClient({
  apiUrl: string;   // Platform API URL
  jobId: string;    // Job identifier
  token: string;    // API authentication token
  nonce?: string;   // Optional job nonce
});
```

**Methods:**
- `sendAssistantMessage(opts)` — report an assistant response
- `sendToolExecution(opts)` — report a tool call and its result
- `sendModelCallFailure(opts)` — report a model invocation failure
- `sendTruncation(opts)` — report context truncation
- `sendResponse(opts)` — report a final response
- `sendReportProgress(opts)` — update PR description/progress

### Git Utilities

```typescript
import { cloneRepo, commitAndPush, finalizeChanges } from "@github/copilot-engine-sdk";

// Clone a repository with branch setup
const repoPath = cloneRepo({
  serverUrl: string;
  repository: string;      // "owner/repo"
  gitToken: string;
  branchName: string;
  commitLogin: string;
  commitEmail: string;
  cloneDir?: string;       // default: "/tmp/workspace"
});

// Commit and push changes
const result = commitAndPush(repoPath, "commit message");

// Finalize: commit + push any remaining uncommitted changes
finalizeChanges(repoPath, "final commit message");
```

### MCP Server

The SDK includes an MCP server that can be used with any LLM SDK that supports the Model Context Protocol.

```typescript
import { createEngineMcpServer, startEngineMcpServer } from "@github/copilot-engine-sdk";

const server = createEngineMcpServer({
  workingDir: "/path/to/repo",
  push: true,                    // push commits to remote (default: true)
  platformClient: platform,      // optional: enables PR description updates
  logFile: "/tmp/mcp.log",       // optional: log file path (default: /tmp/mcp-server.log)
});

// Start as STDIO MCP server
await startEngineMcpServer(server);
```

**Standalone usage** (spawned as a child process):

```bash
node dist/mcp-server.js /path/to/working-directory
```

Environment variables read by the standalone server:
- `GITHUB_PLATFORM_API_URL` — platform API endpoint
- `GITHUB_JOB_ID` — job identifier
- `GITHUB_PLATFORM_API_TOKEN` — API token
- `GITHUB_JOB_NONCE` — optional job nonce

### Event Factories

For advanced usage, you can create event objects directly:

```typescript
import {
  createAssistantMessageEvent,
  createToolExecutionEvent,
  createModelCallFailureEvent,
  createTruncationEvent,
  createResponseEvent,
} from "@github/copilot-engine-sdk";
```

## Environment Variables

Engines receive these environment variables from the platform:

| Variable | Description |
|----------|-------------|
| `GITHUB_JOB_ID` | Unique job identifier |
| `GITHUB_PLATFORM_API_TOKEN` | Token for platform API authentication |
| `GITHUB_PLATFORM_API_URL` | Platform API base URL |
| `GITHUB_JOB_NONCE` | Job nonce for request signing |
| `GITHUB_INFERENCE_TOKEN` | Token for LLM inference calls |
| `GITHUB_INFERENCE_URL` | Inference API endpoint |
| `GITHUB_GIT_TOKEN` | Token for git operations |

## License

MIT
