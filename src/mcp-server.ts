/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Engine MCP Server
 *
 * An MCP server that provides essential tools for engine implementations.
 * This server can be used by any engine, regardless of which LLM SDK they use.
 *
 * Tools provided:
 * - report_progress: Commits changes and reports progress to the platform
 *
 * Usage:
 *   // Start as standalone server
 *   node mcp-server.js /path/to/repo
 *
 *   // Or programmatically
 *   import { createEngineMcpServer, startEngineMcpServer } from './mcp-server';
 *   const server = createEngineMcpServer(config);
 *   await startEngineMcpServer(server);
 */

import { appendFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { commitAndPush, withCoAuthorTrailer } from "./git.js";
import type { PlatformClient } from "./client.js";

// =============================================================================
// Debug Logging (writes to file since stdout is used for MCP protocol)
// =============================================================================

const DEFAULT_LOG_FILE = "/tmp/mcp-server.log";

let _logFile = DEFAULT_LOG_FILE;

function log(message: string, data?: unknown): void {
    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] [MCP] ${message}`;
    if (data !== undefined) {
        logLine += ` ${JSON.stringify(data)}`;
    }
    // Write to stderr so it appears in container logs (stdout is for MCP protocol)
    process.stderr.write(logLine + "\n");
    try {
        appendFileSync(_logFile, logLine + "\n");
    } catch {
        // Ignore logging errors
    }
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Memory tools configuration for engines that want to use Copilot Memory.
 * When provided, memory tools (inject_memories, store_memory, vote_memory)
 * are registered on the MCP server alongside engine tools.
 */
export interface EngineMemoryConfig {
    /** CAPI token for authentication. */
    token: string;
    /** Integration ID (e.g., "copilot-swe-agent"). */
    integrationId: string;
    /** Scope of memory operations. */
    scope: "repository" | "user";
    /** Repository owner (required for repository scope). */
    owner?: string;
    /** Repository name (required for repository scope). */
    repo?: string;
    /** Agent name for telemetry. */
    agent?: string;
    /** Optional interaction/session ID. */
    interactionId?: string;
    /** Optional base model name. */
    baseModel?: string;
}

export interface EngineMcpServerConfig {
    /** Working directory for git operations */
    workingDir: string;
    /** Whether to push commits to remote (default: true) */
    push?: boolean;
    /** Platform client for sending progress updates to the service */
    platformClient?: PlatformClient;
    /** Path to the MCP server log file (default: /tmp/mcp-server.log) */
    logFile?: string;
    /**
     * Memory tools configuration. When provided, memory tools from
     * @github/copilot-agentic-tools are registered on this server.
     */
    memory?: EngineMemoryConfig;
}

// =============================================================================
// Tool Schemas
// =============================================================================

export const REPORT_PROGRESS_TOOL_NAME = "report_progress";

export const reportProgressInputSchema = z.object({
    commitMessage: z.string().describe("A short single line of text to use as the commit message"),
    prDescription: z.string().describe("A markdown checklist showing completed and remaining work"),
});

export type ReportProgressInput = z.infer<typeof reportProgressInputSchema>;

export const reportProgressToolDescription = `Report progress on the task. Call when you complete a meaningful unit of work.
* Commits and pushes any pending changes in the repository
* Updates the progress summary shown to the user
* Use markdown checklists to show progress (- [x] for completed items, - [ ] for pending items)
* Keep the checklist structure consistent between updates
* Only include the checklist in prDescription, no headers or summaries`;

export const REPLY_TO_COMMENT_TOOL_NAME = "reply_to_comment";

export const replyToCommentInputSchema = z.object({
    commentId: z.number().describe("The ID of the PR comment/review to reply to"),
    message: z.string().describe("The reply message to post on the PR comment"),
});

export type ReplyToCommentInput = z.infer<typeof replyToCommentInputSchema>;

export const replyToCommentToolDescription = `Reply to a pull request comment or review.
* Posts a reply to the specified comment on the pull request
* Use this to respond to reviewer feedback or questions
* The reply will be visible on the pull request as a comment from the agent`;

// =============================================================================
// Tool Implementation
// =============================================================================

interface ReportProgressResult {
    success: boolean;
    message: string;
}

async function executeReportProgress(
    input: ReportProgressInput,
    config: EngineMcpServerConfig
): Promise<ReportProgressResult> {
    const { commitMessage, prDescription } = input;
    const results: string[] = [];
    let hasError = false;
    // Stays undefined unless a push actually happened and the SHA was resolved,
    // so the local-only and error paths never report a SHA that is not on the remote.
    let pushedCommitSha: string | undefined;

    log("executeReportProgress", { commitMessage, prDescriptionLength: prDescription.length });

    // Handle git commit and push
    try {
        if (config.push !== false) {
            const gitResult = commitAndPush(config.workingDir, commitMessage);
            log("git commit and push", { hadChanges: gitResult.hadChanges, message: gitResult.message });
            results.push(gitResult.message);
            pushedCommitSha = gitResult.commitSha;
        } else {
            // Local-only mode: just stage and commit without pushing
            const { execFileSync } = await import("child_process");
            const status = execFileSync("git", ["status", "--porcelain"], {
                cwd: config.workingDir,
                encoding: "utf-8",
            }).trim();

            if (status) {
                execFileSync("git", ["add", "."], { cwd: config.workingDir });
                execFileSync("git", ["commit", "-m", withCoAuthorTrailer(commitMessage)], { cwd: config.workingDir });
                log("git commit complete (local only)", { message: commitMessage });
                results.push(`Committed locally: ${commitMessage}`);
            } else {
                log("no changes to commit");
                results.push("No changes to commit.");
            }
        }
    } catch (error) {
        hasError = true;
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push(`Git error: ${errorMessage}`);
        log("git error in report_progress", { error: errorMessage });
    }

    // Include progress checklist in response for visibility
    results.push("");
    results.push("Progress:");
    results.push(prDescription);

    // Send progress update to the platform API (PR title/description)
    if (config.platformClient) {
        try {
            const sendResult = await config.platformClient.sendReportProgress({
                prDescription,
                commitSha: pushedCommitSha,
            });
            if (sendResult.success) {
                log("sent report_progress to platform");
            } else {
                log("failed to send report_progress to platform", { error: sendResult.error?.message });
                results.push(`Warning: Failed to update PR description: ${sendResult.error?.message}`);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log("error sending report_progress to platform", { error: errorMessage });
        }
    }

    log("executeReportProgress complete", { success: !hasError });

    return {
        success: !hasError,
        message: results.join("\n"),
    };
}

// =============================================================================
// MCP Server Factory
// =============================================================================

/**
 * Creates an MCP server that exposes engine tools.
 *
 * @param config - Configuration for the MCP server
 * @returns The configured MCP server instance
 */
export function createEngineMcpServer(config: EngineMcpServerConfig): McpServer {
    // Set the log file path for this server instance
    _logFile = config.logFile ?? DEFAULT_LOG_FILE;

    const server = new McpServer({
        name: "engine-tools",
        version: "1.0.0",
    });

    // Register the report_progress tool
    server.tool(
        REPORT_PROGRESS_TOOL_NAME,
        reportProgressToolDescription,
        reportProgressInputSchema.shape,
        async (params: ReportProgressInput) => {
            log("report_progress called", { commitMessage: params.commitMessage });
            const result = await executeReportProgress(params, config);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: result.message,
                    },
                ],
                isError: !result.success,
            };
        }
    );

    // Register the reply_to_comment tool
    server.tool(
        REPLY_TO_COMMENT_TOOL_NAME,
        replyToCommentToolDescription,
        replyToCommentInputSchema.shape,
        async (params: ReplyToCommentInput) => {
            log("reply_to_comment called", { commentId: params.commentId });

            if (!config.platformClient) {
                log("reply_to_comment: no platform client available");
                return {
                    content: [{ type: "text" as const, text: "Cannot reply to comments: platform client not configured" }],
                    isError: true,
                };
            }

            try {
                const result = await config.platformClient.sendCommentReply({
                    commentId: params.commentId,
                    message: params.message,
                });

                if (result.success) {
                    log("reply_to_comment: sent successfully");
                    return {
                        content: [{ type: "text" as const, text: "Reply posted successfully." }],
                        isError: false,
                    };
                }

                log("reply_to_comment: failed", { error: result.error?.message });
                return {
                    content: [{ type: "text" as const, text: `Failed to post reply: ${result.error?.message}` }],
                    isError: true,
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                log("reply_to_comment: error", { error: errorMessage });
                return {
                    content: [{ type: "text" as const, text: `Error posting reply: ${errorMessage}` }],
                    isError: true,
                };
            }
        }
    );

    return server;
}

/**
 * Creates an MCP server with engine tools and optional memory tools.
 * This is an async version that supports dynamic loading of memory tools.
 *
 * @param config - Configuration for the MCP server
 * @returns Promise resolving to the configured MCP server instance
 */
export async function createEngineMcpServerAsync(config: EngineMcpServerConfig): Promise<McpServer> {
    const server = createEngineMcpServer(config);

    // Register memory tools if configured
    if (config.memory) {
        await registerMemoryTools(server, config.memory);
    }

    return server;
}

/**
 * Registers memory tools from @github/copilot-agentic-tools on an MCP server.
 * This dynamically imports the package to keep it optional.
 *
 * @param server - The MCP server to register tools on
 * @param memoryConfig - Memory tools configuration
 */
async function registerMemoryTools(server: McpServer, memoryConfig: EngineMemoryConfig): Promise<void> {
    try {
        // Dynamic import to keep @github/copilot-agentic-tools optional
        const {
            fetchMemoryPrompts,
            storeMemory,
            voteMemory,
        } = await import("@github/copilot-agentic-tools/memory");
        const {
            INJECT_MEMORIES_TOOL_NAME,
            STORE_MEMORY_TOOL_NAME,
            VOTE_MEMORY_TOOL_NAME,
        } = await import("@github/copilot-agentic-tools/mcp");

        const { scope, owner, repo, agent = "engine", interactionId, baseModel, token, integrationId } = memoryConfig;

        // Validate repository scope config
        if (scope === "repository" && (!owner || !repo)) {
            throw new Error("Repository scope requires owner and repo to be specified");
        }

        // Build API options
        const baseApiOptions = {
            token,
            integrationId,
            logger: {
                info: (msg: string) => log(`[memory] ${msg}`),
                error: (msg: string) => log(`[memory] ERROR: ${msg}`),
            },
        };

        const apiOptions = scope === "user"
            ? { ...baseApiOptions, scope: "user" as const }
            : { ...baseApiOptions, scope: "repository" as const, owner: owner!, repo: repo! };

        // Register inject_memories tool
        server.tool(
            INJECT_MEMORIES_TOOL_NAME,
            "Inject memories from previous sessions into the current context",
            {},
            async () => {
                try {
                    const prompts = await fetchMemoryPrompts(apiOptions);
                    if (prompts?.memoriesContext?.prompt) {
                        const count = prompts.memoriesContext.memoriesCount ?? 0;
                        log(`inject_memories: Retrieved ${count} memories`);
                        return { content: [{ type: "text" as const, text: prompts.memoriesContext.prompt }] };
                    }
                    log("inject_memories: No memories available");
                    return { content: [{ type: "text" as const, text: "No memories available for this repository." }] };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    log(`inject_memories failed: ${errorMessage}`);
                    return { content: [{ type: "text" as const, text: "No memories available (loading failed)." }] };
                }
            },
        );

        // Register store_memory tool
        const storeMemorySchema = z.object({
            subject: z.string().describe("Brief title for the memory (e.g., 'Code style preference')"),
            fact: z.string().describe("The information to store as a memory"),
            citations: z.array(z.string()).describe("File paths that support this memory"),
            reason: z.string().describe("Why this memory is being stored"),
        });

        server.tool(
            STORE_MEMORY_TOOL_NAME,
            "Store a new memory about the codebase or user preferences",
            storeMemorySchema.shape,
            async (params: z.infer<typeof storeMemorySchema>) => {
                try {
                    const result = await storeMemory(
                        { subject: params.subject, fact: params.fact, citations: params.citations, reason: params.reason },
                        { ...apiOptions, agent, interactionId, baseModel },
                    );
                    if (result.success) {
                        log(`store_memory: Stored memory "${params.subject}"`);
                        return { content: [{ type: "text" as const, text: `Memory stored: ${params.subject}` }] };
                    }
                    log(`store_memory failed: ${result.error}`);
                    return { content: [{ type: "text" as const, text: `Failed to store memory: ${result.error}` }], isError: true };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    log(`store_memory error: ${errorMessage}`);
                    return { content: [{ type: "text" as const, text: `Error storing memory: ${errorMessage}` }], isError: true };
                }
            },
        );

        // Register vote_memory tool
        const voteMemorySchema = z.object({
            fact: z.string().describe("The fact/content of the memory to vote on"),
            direction: z.enum(["upvote", "downvote"]).describe("Vote direction"),
            reason: z.string().describe("Why you are voting this way"),
        });

        server.tool(
            VOTE_MEMORY_TOOL_NAME,
            "Vote on a memory to improve its ranking",
            voteMemorySchema.shape,
            async (params: z.infer<typeof voteMemorySchema>) => {
                try {
                    const result = await voteMemory(
                        { fact: params.fact, direction: params.direction, reason: params.reason },
                        { ...apiOptions, agent, interactionId, baseModel },
                    );
                    if (result.success) {
                        log(`vote_memory: Voted ${params.direction} on memory`);
                        return { content: [{ type: "text" as const, text: `Vote recorded: ${params.direction}` }] };
                    }
                    log(`vote_memory failed: ${result.error}`);
                    return { content: [{ type: "text" as const, text: `Failed to vote: ${result.error}` }], isError: true };
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    log(`vote_memory error: ${errorMessage}`);
                    return { content: [{ type: "text" as const, text: `Error voting: ${errorMessage}` }], isError: true };
                }
            },
        );

        log("Memory tools registered", { scope, hasOwnerRepo: !!(owner && repo) });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`Failed to register memory tools: ${errorMessage}. Install @github/copilot-agentic-tools to enable.`);
        // Don't throw - memory tools are optional
    }
}

/**
 * Starts the MCP server using STDIO transport.
 * This is used when running the server as a standalone process.
 *
 * @param server - The MCP server instance to start
 */
export async function startEngineMcpServer(server: McpServer): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

// =============================================================================
// Standalone Entry Point
// =============================================================================

/**
 * Run as standalone MCP server when executed directly.
 * Working directory is passed as the first command line argument.
 * Platform API credentials are read from environment variables.
 */
async function main(): Promise<void> {
    const workingDir = process.argv[2];
    if (!workingDir) {
        throw new Error("Usage: node mcp-server.js <working-directory>");
    }

    log("MCP server starting", { workingDir });

    // Import PlatformClient here to avoid circular dependency issues at top level
    const { PlatformClient } = await import("./client.js");

    // Create platform client from environment variables passed via MCP server config
    let platformClient: PlatformClient | undefined;
    const apiUrl = process.env.GITHUB_PLATFORM_API_URL;
    const jobId = process.env.GITHUB_JOB_ID;
    const apiToken = process.env.GITHUB_PLATFORM_API_TOKEN;
    if (apiUrl && jobId && apiToken) {
        platformClient = new PlatformClient({
            apiUrl,
            jobId,
            token: apiToken,
            nonce: process.env.GITHUB_JOB_NONCE,
        });
        log("Platform client initialized for report_progress updates");
    } else {
        log("Platform client not initialized (missing env vars), PR updates disabled", {
            hasApiUrl: !!apiUrl,
            hasJobId: !!jobId,
            hasApiToken: !!apiToken,
        });
    }

    // Build memory config from environment variables (optional)
    let memory: EngineMemoryConfig | undefined;
    const memoryToken = process.env.COPILOT_TOKEN;
    const memoryIntegrationId = process.env.COPILOT_INTEGRATION_ID;
    if (memoryToken && memoryIntegrationId) {
        const owner = process.env.GITHUB_OWNER;
        const repo = process.env.GITHUB_REPO;
        const scope: "repository" | "user" = owner && repo ? "repository" : "user";
        memory = {
            token: memoryToken,
            integrationId: memoryIntegrationId,
            scope,
            owner,
            repo,
            agent: process.env.AGENT_NAME ?? "engine",
            interactionId: process.env.INTERACTION_ID,
            baseModel: process.env.BASE_MODEL,
        };
        log("Memory tools enabled", { scope, hasOwnerRepo: !!(owner && repo) });
    } else {
        log("Memory tools disabled (COPILOT_TOKEN or COPILOT_INTEGRATION_ID not set)");
    }

    const config: EngineMcpServerConfig = {
        workingDir,
        push: process.env.COPILOT_AGENT_PUSH !== "false",
        platformClient,
        memory,
    };

    // Use async version to support memory tool registration
    const server = await createEngineMcpServerAsync(config);
    await startEngineMcpServer(server);

    log("MCP server ready");
}

// Run if executed directly (matches both mcp-server.js and mcp-server.bundled.js)
if (process.argv[1]?.includes("mcp-server")) {
    main().catch((error) => {
        log("FATAL", { error: String(error) });
        console.error("Failed to start MCP server:", error);
        process.exit(1);
    });
}
