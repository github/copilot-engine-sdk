/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copilot Engine SDK
 *
 * A standalone SDK for engine authors building on the GitHub Copilot agent platform.
 * Provides platform event reporting, git utilities, and an MCP server for tool execution.
 *
 * @example
 * ```typescript
 * import {
 *   PlatformClient,
 *   createAssistantMessageEvent,
 *   createToolExecutionEvent,
 *   createEngineMcpServer,
 * } from "@github/copilot-engine-sdk";
 *
 * // Create a client to send events to the platform
 * const client = new PlatformClient({
 *   apiUrl: process.env.GITHUB_PLATFORM_API_URL!,
 *   jobId: process.env.GITHUB_JOB_ID!,
 *   token: process.env.GITHUB_PLATFORM_API_TOKEN!,
 * });
 *
 * // Send events using convenience methods
 * await client.sendAssistantMessage({
 *   turn: 1,
 *   callId: "call-123",
 *   content: "I'll help you with that.",
 *   toolCalls: [{ id: "tc-1", name: "read_file", arguments: '{"path": "foo.txt"}' }],
 * });
 *
 * // Or create an MCP server for use with any LLM SDK
 * const mcpServer = createEngineMcpServer({
 *   workingDir: process.cwd(),
 *   branchName: "feature-branch",
 *   push: true,
 *   platform: client,
 * });
 * ```
 */

// =============================================================================
// Types
// =============================================================================

export type {
    // Event types
    Event,
    MessageEvent,
    ModelCallFailureEvent,
    AssistantMessageEvent,
    ToolMessageEvent,
    ToolExecutionEvent,
    TruncationEvent,
    ResponseEvent,
    // Supporting types
    ToolCall,
    ToolResult,
    ChatCompletionMessage,
    ModelCallParam,
} from "./types.js";

// =============================================================================
// Event Factories
// =============================================================================

export {
    // Factory functions
    createModelCallFailureEvent,
    createAssistantMessageEvent,
    createToolMessageEvent,
    createToolExecutionEvent,
    createTruncationEvent,
    createResponseEvent,
} from "./events.js";

// Factory input types
export type {
    CreateModelCallFailureOptions,
    CreateAssistantMessageOptions,
    CreateToolMessageOptions,
    CreateToolExecutionOptions,
    CreateTruncationOptions,
    CreateResponseOptions,
} from "./events.js";

// =============================================================================
// Platform Client
// =============================================================================

export { PlatformClient } from "./client.js";

export type { PlatformClientConfig, ProgressPayload, ProgressRecord, ProgressResponse, SendResult, JobDetails, ProblemStatement } from "./client.js";

// =============================================================================
// MCP Server
// =============================================================================

export {
    createEngineMcpServer,
    startEngineMcpServer,
    REPORT_PROGRESS_TOOL_NAME,
    reportProgressToolDescription,
    reportProgressInputSchema,
} from "./mcp-server.js";

export type {
    EngineMcpServerConfig,
    ReportProgressInput,
} from "./mcp-server.js";

// =============================================================================
// Git Utilities
// =============================================================================

export { cloneRepo, commitAndPush, finalizeChanges } from "./git.js";

export type { CloneRepoOptions, CommitAndPushResult } from "./git.js";

// =============================================================================
// MCP Proxy Discovery
// =============================================================================

export { discoverMCPServers, isMCPProxyAvailable } from "./mcp-proxy.js";

export type { MCPServerEntry, DiscoveredMCPServer } from "./mcp-proxy.js";
