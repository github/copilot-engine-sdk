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
 * - reply_to_comment: Posts a reply to a PR comment
 * - report_dreaming_artifact: Reports a Dreaming artifact back to the platform
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
import type { PlatformClient, DreamingArtifact } from "./client.js";
import { commitAndPush, withCoAuthorTrailer } from "./git.js";

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

export interface EngineMcpServerConfig {
    /** Working directory for git operations */
    workingDir: string;
    /** Whether to push commits to remote (default: true) */
    push?: boolean;
    /** Platform client for sending progress updates to the service */
    platformClient?: PlatformClient;
    /** Path to the MCP server log file (default: /tmp/mcp-server.log) */
    logFile?: string;
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

export const REPORT_DREAMING_ARTIFACT_TOOL_NAME = "report_dreaming_artifact";

/**
 * Maximum size (in bytes) of the serialized artifact content. Progress payloads
 * are forwarded onto a hydro topic with a bounded message size, so the tool
 * rejects oversized artifacts rather than failing downstream. Provisional value
 * (see github/agents issue 1476).
 */
export const MAX_DREAMING_ARTIFACT_CONTENT_BYTES = 256 * 1024;

export const reportDreamingArtifactInputSchema = z.object({
    title: z.string().describe("Short human-readable title for the artifact"),
    summary: z.string().describe("Markdown summary describing what the dream produced"),
    data: z.record(z.string(), z.unknown()).optional().describe("Optional structured payload for machine consumers"),
});

export type ReportDreamingArtifactInput = z.infer<typeof reportDreamingArtifactInputSchema>;

export const reportDreamingArtifactToolDescription = `Report a Dreaming artifact produced by this job back to the platform.
* Call this when the dream has produced a result worth persisting (e.g. a summary of findings or decisions)
* Provide a short title and a markdown summary; include structured details in data when useful
* The artifact is sent to the platform over the job-progress channel; do not include secrets
* Keep the payload small; oversized artifacts are rejected`;

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

    log("executeReportProgress", { commitMessage, prDescriptionLength: prDescription.length });

    // Handle git commit and push
    try {
        if (config.push !== false) {
            const gitResult = commitAndPush(config.workingDir, commitMessage);
            log("git commit and push", { hadChanges: gitResult.hadChanges, message: gitResult.message });
            results.push(gitResult.message);
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

    // Register the report_dreaming_artifact tool
    server.tool(
        REPORT_DREAMING_ARTIFACT_TOOL_NAME,
        reportDreamingArtifactToolDescription,
        reportDreamingArtifactInputSchema.shape,
        async (params: ReportDreamingArtifactInput) => {
            log("report_dreaming_artifact called", { title: params.title });

            if (!config.platformClient) {
                log("report_dreaming_artifact: no platform client available");
                return {
                    content: [{ type: "text" as const, text: "Cannot report artifact: platform client not configured" }],
                    isError: true,
                };
            }

            const artifact: DreamingArtifact = {
                title: params.title,
                summary: params.summary,
                ...(params.data !== undefined ? { data: params.data } : {}),
            };

            const contentBytes = Buffer.byteLength(JSON.stringify(artifact), "utf8");
            if (contentBytes > MAX_DREAMING_ARTIFACT_CONTENT_BYTES) {
                log("report_dreaming_artifact: payload too large", { contentBytes });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Artifact too large: ${contentBytes} bytes exceeds the ${MAX_DREAMING_ARTIFACT_CONTENT_BYTES} byte limit. Shorten the summary or move detail into a smaller data payload.`,
                        },
                    ],
                    isError: true,
                };
            }

            try {
                const result = await config.platformClient.sendDreamingArtifact(artifact);

                if (result.success) {
                    log("report_dreaming_artifact: sent successfully");
                    return {
                        content: [{ type: "text" as const, text: "Artifact reported successfully." }],
                        isError: false,
                    };
                }

                log("report_dreaming_artifact: failed", { error: result.error?.message });
                return {
                    content: [{ type: "text" as const, text: `Failed to report artifact: ${result.error?.message}` }],
                    isError: true,
                };
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                log("report_dreaming_artifact: error", { error: errorMessage });
                return {
                    content: [{ type: "text" as const, text: `Error reporting artifact: ${errorMessage}` }],
                    isError: true,
                };
            }
        }
    );

    return server;
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

    const config: EngineMcpServerConfig = {
        workingDir,
        push: true,
        platformClient,
    };

    const server = createEngineMcpServer(config);
    await startEngineMcpServer(server);

    log("MCP server ready");
}

// Run if executed directly (check filename to avoid firing when bundled into another entry)
if (process.argv[1]?.endsWith("mcp-server.js")) {
    main().catch((error) => {
        log("FATAL", { error: String(error) });
        console.error("Failed to start MCP server:", error);
        process.exit(1);
    });
}
