/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Engine SDK Platform Client
 *
 * A self-contained client for sending events to the platform API.
 * Uses only native fetch, no external dependencies.
 */

import type { Event, AssistantMessageEvent, ToolExecutionEvent, ToolCall } from "./types.js";
import {
    type CreateModelCallFailureOptions,
    type CreateAssistantMessageOptions,
    type CreateToolMessageOptions,
    type CreateToolExecutionOptions,
    type CreateTruncationOptions,
    type CreateResponseOptions,
    createModelCallFailureEvent,
    createAssistantMessageEvent,
    createToolMessageEvent,
    createToolExecutionEvent,
    createTruncationEvent,
    createResponseEvent,
} from "./events.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for the PlatformClient.
 */
export interface PlatformClientConfig {
    /** Base URL for the platform API (e.g., from COPILOT_API_URL) */
    apiUrl: string;
    /** Job ID for this engine execution (e.g., from GITHUB_JOB_ID) */
    jobId: string;
    /** Authentication token (e.g., from COPILOT_API_TOKEN) */
    token: string;
    /** Optional job nonce for validation */
    nonce?: string;
    /** Optional trace parent for distributed tracing */
    traceParent?: string;
    /** Optional namespace for progress events (default: "sessions-v2") */
    namespace?: string;
}

/**
 * Payload format for the progress API.
 */
export interface ProgressPayload {
    namespace: string;
    kind: string;
    version: number;
    content: string;
}

/**
 * Response from the progress API (may contain user messages for mid-session steering).
 */
export interface ProgressResponse {
    user_messages?: Array<{
        id: string;
        actor_id: number;
        content: string;
        timestamp: number;
    }>;
}

/**
 * Result of sending a progress event.
 */
export interface SendResult {
    success: boolean;
    response?: ProgressResponse;
    error?: Error;
}

// =============================================================================
// Platform Client
// =============================================================================

/**
 * Client for sending events to the platform API.
 *
 * @example
 * ```typescript
 * const client = new PlatformClient({
 *   apiUrl: process.env.GITHUB_PLATFORM_API_URL!,
 *   jobId: process.env.GITHUB_JOB_ID!,
 *   token: process.env.GITHUB_PLATFORM_API_TOKEN!,
 * });
 *
 * // Send events using convenience methods
 * await client.sendModelCallSuccess({ turn: 1, callId: "...", content: "..." });
 * await client.sendAssistantMessage({ turn: 1, callId: "...", content: "..." });
 * ```
 */
export class PlatformClient {
    private readonly baseUrl: URL;
    private readonly _jobId: string;
    private readonly _apiUrl: string;
    private readonly _token: string;
    private readonly _nonce?: string;
    private readonly headers: Record<string, string>;
    private readonly namespace: string;
    // Tracks assistant message context by tool call ID so tool_execution
    // events can be enriched with the original call context before sending.
    private readonly toolCallContext = new Map<string, { callId: string; model: string; toolCall: ToolCall }>();

    constructor(config: PlatformClientConfig) {
        // Store original config values for external access
        this._apiUrl = config.apiUrl;
        this._token = config.token;
        this._jobId = config.jobId;
        this._nonce = config.nonce;

        // Ensure URL ends with trailing slash for proper path joining
        let apiUrl = config.apiUrl;
        if (!apiUrl.endsWith("/")) {
            apiUrl += "/";
        }
        this.baseUrl = new URL(apiUrl);
        this.namespace = config.namespace ?? "sessions-v2";

        // Build headers
        this.headers = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
        };

        if (config.nonce) {
            this.headers["X-GitHub-Job-Nonce"] = config.nonce;
        }

        if (config.traceParent) {
            this.headers["X-Copilot-Traceparent"] = config.traceParent;
        }
    }

    /** Get the API URL */
    get apiUrl(): string {
        return this._apiUrl;
    }

    /** Get the API token */
    get token(): string {
        return this._token;
    }

    /** Get the job ID */
    get jobId(): string {
        return this._jobId;
    }

    /** Get the job nonce */
    get nonce(): string | undefined {
        return this._nonce;
    }

    // =========================================================================
    // Core Methods
    // =========================================================================

    /**
     * Sends a progress event to the platform API.
     * Enriches tool_execution events with context from the originating
     * assistant message so the event carries complete tool-call context.
     *
     * @param event - The event to send
     * @returns Result containing success status and optional response
     */
    async sendProgress(event: Event): Promise<SendResult> {
        const url = new URL(`jobs/${this._jobId}/progress`, this.baseUrl);

        // Track assistant message tool calls for later enrichment
        if (event.kind === "message" && event.message.role === "assistant") {
            const assistantEvent = event as AssistantMessageEvent;
            if (assistantEvent.message.tool_calls) {
                for (const tc of assistantEvent.message.tool_calls) {
                    this.toolCallContext.set(tc.id, {
                        callId: assistantEvent.callId || "",
                        model: assistantEvent.modelCall?.model || "unknown",
                        toolCall: tc,
                    });
                }
            }
        }

        // Enrich tool_execution events with original assistant call context
        let enrichedEvent: Event = event;
        if (event.kind === "tool_execution") {
            const execEvent = event as ToolExecutionEvent;
            const ctx = this.toolCallContext.get(execEvent.toolCallId);
            if (ctx) {
                enrichedEvent = { ...execEvent, originalCall: ctx };
                this.toolCallContext.delete(execEvent.toolCallId);
            }
        }

        const payload: ProgressPayload = {
            namespace: this.namespace,
            kind: "log",
            version: 0,
            content: JSON.stringify(enrichedEvent),
        };

        try {
            const response = await fetch(url.toString(), {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                return {
                    success: false,
                    error: new Error(`HTTP ${response.status}: ${response.statusText}`),
                };
            }

            // Try to parse response (may contain user_messages)
            const text = await response.text();
            let parsed: ProgressResponse | undefined;
            try {
                parsed = text.trim() ? (JSON.parse(text) as ProgressResponse) : undefined;
            } catch {
                // Invalid JSON in response — treat as success with no parsed body
            }

            return {
                success: true,
                response: parsed,
            };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err : new Error(String(err)),
            };
        }
    }

    // =========================================================================
    // Convenience Methods
    // =========================================================================

    /**
     * Creates and sends a model call failure event.
     */
    async sendModelCallFailure(options: CreateModelCallFailureOptions): Promise<SendResult> {
        return this.sendProgress(createModelCallFailureEvent(options));
    }

    /**
     * Creates and sends an assistant message event.
     */
    async sendAssistantMessage(options: CreateAssistantMessageOptions): Promise<SendResult> {
        return this.sendProgress(createAssistantMessageEvent(options));
    }

    /**
     * Creates and sends a tool message event.
     */
    async sendToolMessage(options: CreateToolMessageOptions): Promise<SendResult> {
        return this.sendProgress(createToolMessageEvent(options));
    }

    /**
     * Creates and sends a tool execution event.
     */
    async sendToolExecution(options: CreateToolExecutionOptions): Promise<SendResult> {
        return this.sendProgress(createToolExecutionEvent(options));
    }

    /**
     * Creates and sends a truncation event.
     */
    async sendTruncation(options: CreateTruncationOptions): Promise<SendResult> {
        return this.sendProgress(createTruncationEvent(options));
    }

    /**
     * Creates and sends a response event.
     */
    async sendResponse(options: CreateResponseOptions): Promise<SendResult> {
        return this.sendProgress(createResponseEvent(options));
    }

    /**
     * Sends a report_progress event to update the PR title and/or description.
     * This triggers the platform to update the pull request associated with the job.
     */
    async sendReportProgress(options: { prTitle?: string; prDescription?: string }): Promise<SendResult> {
        const url = new URL(`jobs/${this._jobId}/progress`, this.baseUrl);
        const contentObj: Record<string, string> = {};
        if (options.prTitle !== undefined) {
            contentObj.pr_title = options.prTitle;
        }
        if (options.prDescription !== undefined) {
            contentObj.pr_description = options.prDescription;
        }
        const payload: ProgressPayload = {
            namespace: this.namespace,
            kind: "report_progress",
            version: 0,
            content: JSON.stringify(contentObj),
        };

        try {
            const response = await fetch(url.toString(), {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                return {
                    success: false,
                    error: new Error(`HTTP ${response.status}: ${response.statusText}`),
                };
            }

            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err : new Error(String(err)),
            };
        }
    }

    /**
     * Sends a comment_reply event to post a reply to a PR comment.
     * Used for fix-pr-comment actions to respond to reviewer feedback.
     */
    async sendCommentReply(options: { commentId: number; message: string }): Promise<SendResult> {
        const url = new URL(`jobs/${this._jobId}/progress`, this.baseUrl);
        const payload: ProgressPayload = {
            namespace: this.namespace,
            kind: "comment_reply",
            version: 0,
            content: JSON.stringify({
                comment_id: options.commentId,
                message: options.message,
            }),
        };

        try {
            const response = await fetch(url.toString(), {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                return {
                    success: false,
                    error: new Error(`HTTP ${response.status}: ${response.statusText}`),
                };
            }

            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err : new Error(String(err)),
            };
        }
    }

    // =========================================================================
    // Generic Progress API
    // =========================================================================

    /**
     * Sends one or more raw progress payloads to the platform.
     * Use this for custom namespaces/kinds not covered by the convenience methods.
     */
    async sendRawProgress(payloads: ProgressPayload | ProgressPayload[]): Promise<SendResult> {
        const url = new URL(`jobs/${this._jobId}/progress`, this.baseUrl);

        try {
            const response = await fetch(url.toString(), {
                method: "POST",
                headers: this.headers,
                body: JSON.stringify(payloads),
            });

            if (!response.ok) {
                return {
                    success: false,
                    error: new Error(`HTTP ${response.status}: ${response.statusText}`),
                };
            }

            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err : new Error(String(err)),
            };
        }
    }

    /**
     * Fetches progress records from the platform, optionally filtered by
     * namespace and including history from previous jobs.
     *
     * @param options.namespace Restrict results to a single namespace.
     * @param options.history When true, walk back to previous jobs in the
     *   same assignment for cross-job context. The platform's default
     *   walk-back returns only the most recent previous job's records.
     * @param options.sessionId When set together with `history: true`,
     *   scope the walk-back to a specific session id rather than the
     *   default newest-job-only behavior. Used by resume-after-permission-
     *   timeout flows where the target session may not be the most recent
     *   in the assignment, so an unrelated newer sibling job would
     *   otherwise shadow the session's progress snapshot. Empty/undefined
     *   preserves the existing newest-job-only behavior.
     */
    async fetchProgress(options?: {
        namespace?: string;
        history?: boolean;
        sessionId?: string;
    }): Promise<ProgressRecord[] | null> {
        const url = new URL(`jobs/${this._jobId}/progress`, this.baseUrl);
        if (options?.namespace) {
            url.searchParams.set("namespace", options.namespace);
        }
        if (options?.history) {
            url.searchParams.set("history", "true");
        }
        if (options?.sessionId) {
            url.searchParams.set("session_id", options.sessionId);
        }

        try {
            const response = await fetch(url.toString(), {
                headers: this.headers,
            });

            if (!response.ok) {
                return null;
            }

            return (await response.json()) as ProgressRecord[];
        } catch {
            return null;
        }
    }

    /**
     * Fetches job details from the platform API.
     *
     * @returns Job details including problem statement, repository info, and branch
     */
    async fetchJobDetails(): Promise<JobDetails> {
        const url = new URL(`jobs/${this._jobId}`, this.baseUrl);

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: this.headers,
        });

        if (!response.ok) {
            throw new Error(
                `Failed to fetch job details: HTTP ${response.status} ${response.statusText}`
            );
        }

        const data = (await response.json()) as JobDetails;

        if (!data.problem_statement?.content) {
            throw new Error("Job details missing required field: problem_statement.content");
        }

        return data;
    }
}

// =============================================================================
// Job Details Types
// =============================================================================

/** Problem statement from the job */
export interface ProblemStatement {
    content: string;
}

/** Job details returned from the platform API */
export interface JobDetails {
    ID: string;
    problem_statement: ProblemStatement;
    organization_custom_instructions?: string;
    action: string;
    repository: string;
    server_url: string;
    branch_name?: string;
    commit_login: string;
    commit_email: string;
    mcp_proxy_url?: string;
    /** Model selected by the platform for this run. Present when model selection is enabled. */
    selected_model?: string;
    /** Default model for the selected engine. Present when model selection is enabled. */
    default_model?: string;
    /** Models the engine can choose from. Present when model selection is enabled. */
    available_models?: string[];
    /** Model vendors for filtering (e.g. ["Anthropic", "OpenAI"]). Present when model selection is enabled. */
    model_vendors?: string[];
    /** Feature flags enabled for this job. */
    features?: {
        /** Whether the platform has enabled model selection for this job. */
        model_selection?: boolean;
    };
}

/**
 * Check whether the platform has enabled model selection for this job.
 *
 * When this returns `false`, engines should use their own hardcoded model.
 */
export function isModelSelectionEnabled(job: Pick<JobDetails, "features">): boolean {
    return job.features?.model_selection === true;
}

/**
 * Resolve which model an engine should use for a job.
 *
 * Returns `undefined` when model selection is not enabled for the job
 * (i.e. `features.model_selection` is not `true`), allowing engines that
 * do not support model selection to ignore it entirely.
 *
 * When enabled, the selection order is:
 * 1) caller preferred model
 * 2) model selected by platform (`selected_model`)
 * 3) platform-provided engine default (`default_model`)
 * 4) caller fallback model
 *
 * If `available_models` is present the resolved model must appear in that
 * list.  When no candidate matches, the first available model is returned
 * and a warning is logged if `selected_model` was set but missing from the
 * list (indicates a platform misconfiguration).
 */
/** Options for {@link resolveSelectedModel}. */
export interface ResolveSelectedModelOptions {
    /** Model the engine prefers to use, checked first. */
    preferredModel?: string;
    /** Model to fall back to when no platform-provided candidate matches. */
    fallbackModel?: string;
}

export function resolveSelectedModel(
    job: Pick<JobDetails, "selected_model" | "default_model" | "available_models" | "features">,
    options?: ResolveSelectedModelOptions,
): string | undefined {
    // Model selection must be explicitly enabled via feature flag
    if (job.features?.model_selection !== true) {
        return undefined;
    }

    const availableModels = job.available_models
        ?.map((model) => model.trim())
        .filter((model) => model.length > 0) ?? [];

    const candidates = [
        options?.preferredModel,
        job.selected_model,
        job.default_model,
        options?.fallbackModel,
    ].map((model) => model?.trim())
     .filter((model): model is string => Boolean(model && model.length > 0));

    if (availableModels.length === 0) {
        return candidates[0];
    }

    for (const candidate of candidates) {
        if (availableModels.includes(candidate)) {
            return candidate;
        }
    }

    // Warn when the platform-selected model is not in the available list
    const trimmedSelectedModel = job.selected_model?.trim();
    if (trimmedSelectedModel && !availableModels.includes(trimmedSelectedModel)) {
        console.warn(
            `resolveSelectedModel: selected_model "${trimmedSelectedModel}" is not in available_models [${availableModels.join(", ")}]. ` +
            `Falling back to "${availableModels[0]}".`
        );
    }

    return availableModels[0];
}

/**
 * A progress record returned by the platform API.
 */
export interface ProgressRecord {
    id: string;
    namespace: string;
    kind: string;
    version: number;
    content: string;
    created_at: number;
}
