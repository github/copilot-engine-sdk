# @github/copilot-engine-sdk

> **NOTE:** This is a library that is used internally for certain integrations. It is not a supported integration path, preview, or released product.

SDK for building engines on the GitHub Copilot agent platform.

## Overview

The Copilot Engine SDK provides everything you need to build an engine that runs on the GitHub Copilot agent platform:

- **Platform Client** — send structured events (assistant messages, tool executions, progress updates) to the platform API
- **Git Utilities** — clone repositories, commit and push changes with secure credential handling
- **MCP Server** — a Model Context Protocol server exposing `report_progress` and `reply_to_comment` tools
- **MCP Proxy Discovery** — discover and connect to user-configured MCP servers
- **Event Factories** — create typed platform events for custom event pipelines
- **CLI** — local testing harness that simulates the platform for development
- **[Integration Guide](docs/integration-guide.md)** — step-by-step guide to building an engine

## Installation

Until this package is published to a package registry, install it directly from GitHub:

```json
{
  "dependencies": {
    "@github/copilot-engine-sdk": "github:github/copilot-engine-sdk#main"
  }
}
```

Then run `npm install`.

### Consuming canary builds from the internal feed

Canary builds are published from `main` to the internal Azure Artifacts
`copilot-canary` feed **only** — never to public npm — by
`.github/workflows/canary-publish.yml`. They are versioned
`<next-patch>-canary.<run>.g<sha>` under the `canary` dist-tag, so they sort
above the current public `latest` and below the eventual real release.

To install a canary, point the `@github` scope at the feed and authenticate.
Add an `.npmrc` next to your `package.json`:

```ini
# .npmrc — resolve the @github scope from the copilot-canary feed.
# All other packages continue to resolve from your default registry.
@github:registry=https://pkgs.dev.azure.com/devdiv/_packaging/copilot-canary/npm/registry/
//pkgs.dev.azure.com/devdiv/_packaging/copilot-canary/npm/:_authToken=${AZURE_ARTIFACTS_TOKEN}
//pkgs.dev.azure.com/devdiv/_packaging/copilot-canary/npm/registry/:_authToken=${AZURE_ARTIFACTS_TOKEN}
```

Supply `AZURE_ARTIFACTS_TOKEN` at install time. In CI, mint a short-lived AAD
token the same way the publish workflow does (OIDC via `azure/login`, ADO
resource id `499b84ac-1321-427f-aa17-267ca6975798`):

```bash
export AZURE_ARTIFACTS_TOKEN="$(az account get-access-token \
  --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)"
npm install @github/copilot-engine-sdk@canary
```

Locally, use an Azure DevOps Personal Access Token with **Packaging: Read**
scope as `AZURE_ARTIFACTS_TOKEN`. Only the `@github` scope needs the feed; the
SDK's own runtime deps (`@modelcontextprotocol/sdk`, `zod`) resolve from public
npm.

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

The main client for communicating with the platform API. Handles event reporting, progress updates, and history persistence.

```typescript
const platform = new PlatformClient({
  apiUrl: string;   // Platform API URL
  jobId: string;    // Job identifier
  token: string;    // API authentication token
  nonce?: string;   // Optional job nonce
});
```

**Event Methods:**
- `sendAssistantMessage(opts)` — report an assistant response with optional tool calls
- `sendToolMessage(opts)` — report a tool result message
- `sendToolExecution(opts)` — report a tool call and its result
- `sendModelCallFailure(opts)` — report a model invocation failure
- `sendTruncation(opts)` — report context truncation
- `sendResponse(opts)` — report a final response

**Progress Methods:**
- `sendReportProgress(opts)` — update PR title and description
- `sendCommentReply(opts)` — reply to a PR comment

**History Methods:**
- `sendRawProgress(payloads)` — send raw progress payloads (used for session history persistence)
- `fetchProgress(opts)` — retrieve previously stored progress records

### Git Utilities

Secure git operations with credential handling via `http.extraHeader` (tokens never appear in URLs or process listings).

```typescript
import { cloneRepo, commitAndPush, finalizeChanges } from "@github/copilot-engine-sdk";

// Clone a repository with branch setup
const repoPath = cloneRepo({
  serverUrl: string;       // e.g., "https://github.com"
  repository: string;      // "owner/repo"
  gitToken: string;        // installation token
  branchName: string;      // branch to checkout or create
  commitLogin: string;     // git author name
  commitEmail: string;     // git author email
  cloneDir?: string;       // default: "/tmp/workspace"
});

// Commit and push changes (force push for engine-owned branches)
const result = commitAndPush(repoPath, "commit message");

// Finalize: commit + push any remaining uncommitted changes (non-fatal)
finalizeChanges(repoPath, "final commit message");
```

**Branch handling:**
- If the branch exists on remote, it checks out the existing branch
- If the branch doesn't exist, it creates a new branch from the default branch
- Uses `git ls-remote` to distinguish "branch not found" from auth/network errors

### MCP Server

The SDK includes an MCP server that can be used with any LLM SDK that supports the Model Context Protocol.

**Tools provided:**
- `report_progress` — commits changes and updates the PR description with a progress checklist
- `reply_to_comment` — replies to a PR review comment

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

### MCP Proxy Discovery

Discover user-configured MCP servers passed to the engine via the platform.

```typescript
import { discoverMCPServers, isMCPProxyAvailable } from "@github/copilot-engine-sdk";

// Check if MCP proxy is available
if (isMCPProxyAvailable()) {
  const servers = discoverMCPServers();
  // Returns discovered MCP servers the user has configured
}
```

### Event Factories

For advanced usage, create event objects directly:

```typescript
import {
  createAssistantMessageEvent,
  createToolMessageEvent,
  createToolExecutionEvent,
  createModelCallFailureEvent,
  createTruncationEvent,
  createResponseEvent,
} from "@github/copilot-engine-sdk";
```

## CLI — Local Testing

The SDK includes a CLI tool for testing engines locally without the full platform infrastructure. It simulates the platform API, clones a repo, and runs your engine command.

```bash
cd cli && go build ./cmd/engine-cli

engine-cli run "node dist/index.js" \
  --repo https://github.com/owner/repo \
  --problem-statement "Fix the bug in auth.ts" \
  --action fix \
  --timeout 5m
```

The CLI:
- Clones the target repository to a temp directory
- Starts a mock HTTP server that mimics the platform API
- Spawns your engine with the required environment variables
- Displays progress events in formatted output

See `engine-cli run --help` for all options.

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

## Documentation

- **[Integration Guide](docs/integration-guide.md)** — step-by-step guide to building an engine from scratch

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, build commands, and pull request guidance.

## Support

See [SUPPORT.md](SUPPORT.md) for how to ask questions or report bugs.

## Security

See [SECURITY.md](SECURITY.md) for how to report security vulnerabilities.

## License

See [LICENSE](LICENSE).
