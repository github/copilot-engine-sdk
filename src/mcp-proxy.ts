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

/**
 * Checks whether the MCP proxy is available at the given URL.
 */
export async function isMCPProxyAvailable(proxyUrl: string): Promise<boolean> {
    try {
        const response = await fetch(`${proxyUrl}/health`, {
            signal: AbortSignal.timeout(5000),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Discovers available MCP servers from the proxy and returns configs
 * ready to pass to the Copilot SDK's createSession mcpServers option.
 *
 * Returns an empty object if the proxy is unavailable or has no servers.
 */
export async function discoverMCPServers(
    proxyUrl: string,
): Promise<Record<string, DiscoveredMCPServer>> {
    if (!(await isMCPProxyAvailable(proxyUrl))) {
        console.log(`[MCP] Proxy not available at ${proxyUrl}`);
        return {};
    }

    try {
        const response = await fetch(`${proxyUrl}/mcp/servers`, {
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
            console.warn(`[MCP] Failed to list servers: ${response.status}`);
            return {};
        }

        const data = (await response.json()) as { servers: MCPServerEntry[] };
        const servers: Record<string, DiscoveredMCPServer> = {};

        for (const server of data.servers) {
            const endpoint = server.proxyEndpoint.startsWith("http")
                ? server.proxyEndpoint
                : `${proxyUrl}${server.proxyEndpoint}`;
            servers[server.name] = {
                type: "http",
                url: endpoint,
            };
        }

        if (Object.keys(servers).length > 0) {
            console.log(`[MCP] Discovered ${Object.keys(servers).length} servers: ${Object.keys(servers).join(", ")}`);
        } else {
            console.log(`[MCP] Proxy available but no servers configured`);
        }

        return servers;
    } catch (error) {
        console.warn(`[MCP] Failed to discover servers: ${error}`);
        return {};
    }
}
