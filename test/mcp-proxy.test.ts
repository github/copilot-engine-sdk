/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";

import { discoverMCPServersDetailed, isMCPProxyAvailable } from "../src/mcp-proxy.js";

/**
 * A minimal MCP proxy stand-in. `health` and `list` each control how the
 * corresponding endpoint responds; omit a handler to leave that request
 * hanging (simulating an unresponsive proxy).
 */
async function startProxy(handlers: {
    health?: (res: http.ServerResponse) => void;
    list?: (res: http.ServerResponse) => void;
}): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        if (req.url === "/health") {
            handlers.health?.(res);
            return;
        }
        if (req.url === "/mcp/servers") {
            handlers.list?.(res);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
            server.closeAllConnections();
        }),
    };
}

for (const [method, phase, status] of [
    ["availability", "health", 200],
    ["availability", "health", 503],
    ["discovery", "health", 200],
    ["discovery", "health", 503],
    ["discovery", "list", 503],
] as const) {
    test(`${method} closes the unread ${phase} HTTP ${status} body`, async (t) => {
        let socket: Socket | undefined;
        const stall = (res: http.ServerResponse): void => {
            socket = res.socket ?? undefined;
            res.writeHead(status);
            res.write("incomplete");
        };
        const proxy = await startProxy({
            health: phase === "health" ? stall : (res) => res.end(),
            list: phase === "list" ? stall : (res) => res.end(JSON.stringify({ servers: [] })),
        });
        try {
            if (method === "availability") {
                assert.equal(await isMCPProxyAvailable(proxy.url), status === 200);
            } else {
                const outcome = await discoverMCPServersDetailed(proxy.url);
                assert.equal(outcome.status, status === 200 ? "ok" : phase === "health" ? "unavailable" : "invalid-response");
            }
            assert.ok(socket);
            if (!socket.destroyed) {
                await once(socket, "close", { signal: AbortSignal.timeout(1000) });
            }
            t.diagnostic(JSON.stringify({ method, phase, status, connection_closed: socket.destroyed }));
            assert.equal(socket.destroyed, true);
        } finally {
            await proxy.close();
        }
    });
}

test("healthy proxy with one server returns ok with that server", async () => {
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        list: (res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ servers: [{ name: "fs", proxyEndpoint: "/mcp/fs" }] }));
        },
    });
    try {
        const outcome = await discoverMCPServersDetailed(proxy.url);
        assert.deepEqual(outcome, {
            status: "ok",
            servers: { fs: { type: "http", url: `${proxy.url}/mcp/fs` } },
        });
    } finally {
        await proxy.close();
    }
});

test("healthy proxy with an empty server list returns ok with no servers", async () => {
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        list: (res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ servers: [] }));
        },
    });
    try {
        const outcome = await discoverMCPServersDetailed(proxy.url);
        assert.deepEqual(outcome, { status: "ok", servers: {} });
    } finally {
        await proxy.close();
    }
});

test("health endpoint that never responds times out on the shared deadline", async () => {
    const proxy = await startProxy({}); // no health handler: request hangs
    try {
        const start = Date.now();
        const outcome = await discoverMCPServersDetailed(proxy.url, { timeoutMs: 50 });
        const elapsed = Date.now() - start;
        assert.deepEqual(outcome, { status: "timed-out" });
        // Well under the pre-fix additive worst case (5000ms health + 10000ms list).
        assert.ok(elapsed < 2000, `expected a bounded wait, got ${elapsed}ms`);
    } finally {
        await proxy.close();
    }
});

test("list endpoint that never responds after a successful health check times out", async () => {
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        // no list handler: request hangs
    });
    try {
        const start = Date.now();
        const outcome = await discoverMCPServersDetailed(proxy.url, { timeoutMs: 50 });
        const elapsed = Date.now() - start;
        assert.deepEqual(outcome, { status: "timed-out" });
        assert.ok(elapsed < 2000, `expected a bounded wait, got ${elapsed}ms`);
    } finally {
        await proxy.close();
    }
});

test("cancelling during health discovery reports cancelled", async () => {
    const proxy = await startProxy({}); // health never responds
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    try {
        const outcome = await discoverMCPServersDetailed(proxy.url, { signal: controller.signal, timeoutMs: 5000 });
        assert.deepEqual(outcome, { status: "cancelled" });
    } finally {
        await proxy.close();
    }
});

test("cancelling during list discovery reports cancelled", async () => {
    const controller = new AbortController();
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        // Abort once the list request has actually arrived, so the cancelled
        // phase is deterministic rather than racing a timer against health.
        // The response is never sent.
        list: () => controller.abort(),
    });
    try {
        const outcome = await discoverMCPServersDetailed(proxy.url, { signal: controller.signal, timeoutMs: 5000 });
        assert.deepEqual(outcome, { status: "cancelled" });
    } finally {
        await proxy.close();
    }
});

test("a connection failure reports unavailable", async () => {
    // Reserve a port, then close it immediately so nothing is listening.
    const probe = await startProxy({});
    const { url } = probe;
    await probe.close();

    const outcome = await discoverMCPServersDetailed(url, { timeoutMs: 2000 });
    assert.deepEqual(outcome, { status: "unavailable" });
});

test("a non-success list response reports invalid-response", async () => {
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        list: (res) => {
            res.writeHead(500);
            res.end("boom");
        },
    });
    try {
        const outcome = await discoverMCPServersDetailed(proxy.url);
        assert.equal(outcome.status, "invalid-response");
    } finally {
        await proxy.close();
    }
});

test("a malformed list response body reports invalid-response", async () => {
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        list: (res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("not json");
        },
    });
    try {
        const outcome = await discoverMCPServersDetailed(proxy.url);
        assert.equal(outcome.status, "invalid-response");
    } finally {
        await proxy.close();
    }
});

test("a list response missing the servers array reports invalid-response", async () => {
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        list: (res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ notServers: [] }));
        },
    });
    try {
        const outcome = await discoverMCPServersDetailed(proxy.url);
        assert.equal(outcome.status, "invalid-response");
    } finally {
        await proxy.close();
    }
});

test("a null list response body reports invalid-response", async () => {
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        list: (res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("null");
        },
    });
    try {
        const outcome = await discoverMCPServersDetailed(proxy.url);
        assert.equal(outcome.status, "invalid-response");
    } finally {
        await proxy.close();
    }
});

test("a server entry missing its string fields reports invalid-response", async () => {
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        list: (res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ servers: [{}] }));
        },
    });
    try {
        const outcome = await discoverMCPServersDetailed(proxy.url);
        assert.equal(outcome.status, "invalid-response");
    } finally {
        await proxy.close();
    }
});

test("the overall deadline is a single shared budget, not the sum of two request timeouts", async () => {
    // Health answers after most of the budget has already elapsed, then list
    // never answers. Under one shared budget the whole call ends at about
    // BUDGET_MS. If health and list each owned BUDGET_MS the call would
    // instead run to about HEALTH_DELAY_MS + BUDGET_MS, so the upper bound
    // below sits between the two and separates them.
    const HEALTH_DELAY_MS = 600;
    const BUDGET_MS = 700;
    const ADDITIVE_MS = HEALTH_DELAY_MS + BUDGET_MS;
    const UPPER_BOUND_MS = 1000;

    const proxy = await startProxy({
        health: (res) => {
            setTimeout(() => {
                res.writeHead(200);
                res.end();
            }, HEALTH_DELAY_MS);
        },
        // list never responds
    });
    try {
        const start = Date.now();
        const outcome = await discoverMCPServersDetailed(proxy.url, { timeoutMs: BUDGET_MS });
        const elapsed = Date.now() - start;
        assert.deepEqual(outcome, { status: "timed-out" });
        assert.ok(
            elapsed >= HEALTH_DELAY_MS,
            `expected the call to outlast the health response, got ${elapsed}ms`
        );
        assert.ok(
            elapsed < UPPER_BOUND_MS,
            `expected one shared ${BUDGET_MS}ms budget, not an additive ${ADDITIVE_MS}ms, got ${elapsed}ms`
        );
    } finally {
        await proxy.close();
    }
});

test("a long-lived caller signal does not accumulate abort listeners across calls", async () => {
    const proxy = await startProxy({
        health: (res) => {
            res.writeHead(200);
            res.end();
        },
        list: (res) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ servers: [] }));
        },
    });
    const controller = new AbortController();
    let attached = 0;
    const signal = controller.signal;
    const addEventListener = signal.addEventListener.bind(signal);
    const removeEventListener = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === "abort") attached++;
        return (addEventListener as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
        if (type === "abort") attached--;
        return (removeEventListener as (...args: unknown[]) => void)(type, ...rest);
    }) as typeof signal.removeEventListener;

    try {
        for (let i = 0; i < 5; i++) {
            const outcome = await discoverMCPServersDetailed(proxy.url, { signal });
            assert.deepEqual(outcome, { status: "ok", servers: {} });
        }
        assert.equal(attached, 0, `expected no abort listeners to remain, got ${attached}`);
    } finally {
        await proxy.close();
    }
});
