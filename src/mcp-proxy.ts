/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP Proxy Discovery
 *
 * Discovers user-provided MCP servers from the platform's MCP proxy.
 * The proxy runs out-of-process (outside the firewall) and exposes
 * user MCP servers as HTTP MCP endpoints.
 */

export interface MCPServerEntry {
    name: string;
    proxyEndpoint: string;
}

export interface DiscoveredMCPServer {
    type: "http";
    url: string;
}

export interface MCPProxyAvailabilityOptions {
    /** Aborts the health check in progress. */
    signal?: AbortSignal;
}

export interface MCPDiscoveryOptions {
    /** Aborts discovery (both the health check and the server-list request) in progress. */
    signal?: AbortSignal;
    /** Overall time budget in milliseconds for the whole discovery call. Defaults to 10000. */
    timeoutMs?: number;
}

export type MCPDiscoveryOutcome =
    | { status: "ok"; servers: Record<string, DiscoveredMCPServer> }
    | { status: "unavailable" }
    | { status: "timed-out" }
    | { status: "cancelled" }
    | { status: "invalid-response"; reason: string };

/**
 * Combines multiple abort signals into one that aborts as soon as any input
 * signal aborts. `AbortSignal.any` isn't used here because it landed in
 * Node 20.3, and this package supports Node >=20.0.
 */
function combineSignals(signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose: () => void } {
    const noop = (): void => {};
    const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (present.length <= 1) {
        return { signal: present[0] ?? new AbortController().signal, dispose: noop };
    }

    const controller = new AbortController();
    const attached: Array<{ signal: AbortSignal; onAbort: () => void }> = [];
    const dispose = (): void => {
        for (const entry of attached) {
            entry.signal.removeEventListener("abort", entry.onAbort);
        }
        attached.length = 0;
    };

    for (const signal of present) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            dispose();
            return { signal: controller.signal, dispose: noop };
        }
        const onAbort = (): void => controller.abort(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        attached.push({ signal, onAbort });
    }
    return { signal: controller.signal, dispose };
}

function isMCPServerEntry(value: unknown): value is MCPServerEntry {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return typeof entry.name === "string" && typeof entry.proxyEndpoint === "string";
}

function buildServerMap(proxyUrl: string, entries: MCPServerEntry[]): Record<string, DiscoveredMCPServer> {
    const servers: Record<string, DiscoveredMCPServer> = {};
    for (const server of entries) {
        const endpoint = server.proxyEndpoint.startsWith("http") ? server.proxyEndpoint : `${proxyUrl}${server.proxyEndpoint}`;
        servers[server.name] = {
            type: "http",
            url: endpoint,
        };
    }
    return servers;
}

/**
 * Checks whether the MCP proxy is available at the given URL.
 */
export async function isMCPProxyAvailable(proxyUrl: string, options: MCPProxyAvailabilityOptions = {}): Promise<boolean> {
    const signal = options.signal ?? AbortSignal.timeout(5000);
    try {
        const response = await fetch(`${proxyUrl}/health`, { signal });
        await response.body?.cancel();
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Discovers available MCP servers from the proxy and reports a structured
 * outcome that distinguishes a valid empty server list from a proxy that
 * could not be reached, timed out, was cancelled, or returned a response
 * discovery could not use.
 *
 * The health check and the server-list request share one overall deadline
 * (`options.timeoutMs`, default 10000ms) rather than each owning its own
 * timeout, so the total wait is bounded instead of additive. Passing
 * `options.signal` lets the caller cancel either request; cancellation
 * clears the deadline timer so nothing keeps running in the background.
 */
export async function discoverMCPServersDetailed(proxyUrl: string, options: MCPDiscoveryOptions = {}): Promise<MCPDiscoveryOutcome> {
    const { signal: callerSignal, timeoutMs = 10_000 } = options;

    if (callerSignal?.aborted) {
        return { status: "cancelled" };
    }

    let deadlineExceeded = false;
    const deadlineController = new AbortController();
    const timer = setTimeout(() => {
        deadlineExceeded = true;
        deadlineController.abort();
    }, timeoutMs);
    const sharedSignals = combineSignals([callerSignal, deadlineController.signal]);
    const sharedSignal = sharedSignals.signal;

    const classifyAbort = (): MCPDiscoveryOutcome => {
        if (callerSignal?.aborted) {
            return { status: "cancelled" };
        }
        if (deadlineExceeded) {
            return { status: "timed-out" };
        }
        return { status: "unavailable" };
    };

    try {
        const available = await isMCPProxyAvailable(proxyUrl, { signal: sharedSignal });
        if (!available) {
            return classifyAbort();
        }

        let response: Response;
        try {
            response = await fetch(`${proxyUrl}/mcp/servers`, { signal: sharedSignal });
        } catch {
            return classifyAbort();
        }

        if (!response.ok) {
            return { status: "invalid-response", reason: `server-list request failed with status ${response.status}` };
        }

        let data: unknown;
        try {
            data = await response.json();
        } catch {
            if (sharedSignal.aborted) {
                return classifyAbort();
            }
            return { status: "invalid-response", reason: "server-list response body was not valid JSON" };
        }

        if (typeof data !== "object" || data === null) {
            return { status: "invalid-response", reason: "server-list response body was not a JSON object" };
        }

        const servers = (data as { servers?: unknown }).servers;
        if (!Array.isArray(servers)) {
            return { status: "invalid-response", reason: "server-list response body did not include a servers array" };
        }

        if (!servers.every(isMCPServerEntry)) {
            return {
                status: "invalid-response",
                reason: "server-list response body had an entry without a name and proxyEndpoint string",
            };
        }

        return { status: "ok", servers: buildServerMap(proxyUrl, servers) };
    } finally {
        clearTimeout(timer);
        deadlineController.abort();
        sharedSignals.dispose();
    }
}

/**
 * Discovers available MCP servers from the proxy and returns configs
 * ready to pass to the Copilot SDK's createSession mcpServers option.
 *
 * Returns an empty object if the proxy is unavailable, discovery times
 * out, or the response could not be used. Prefer `discoverMCPServersDetailed`
 * for callers that need to cancel discovery or tell those outcomes apart.
 */
export async function discoverMCPServers(proxyUrl: string): Promise<Record<string, DiscoveredMCPServer>> {
    const outcome = await discoverMCPServersDetailed(proxyUrl);

    switch (outcome.status) {
        case "ok": {
            const count = Object.keys(outcome.servers).length;
            if (count > 0) {
                console.log(`[MCP] Discovered ${count} servers: ${Object.keys(outcome.servers).join(", ")}`);
            } else {
                console.log(`[MCP] Proxy available but no servers configured`);
            }
            return outcome.servers;
        }
        case "unavailable":
            console.log(`[MCP] Proxy not available at ${proxyUrl}`);
            return {};
        case "timed-out":
            console.warn(`[MCP] Discovery timed out for ${proxyUrl}`);
            return {};
        case "cancelled":
            console.warn(`[MCP] Discovery was cancelled for ${proxyUrl}`);
            return {};
        case "invalid-response":
            console.warn(`[MCP] Failed to discover servers: ${outcome.reason}`);
            return {};
    }
}
