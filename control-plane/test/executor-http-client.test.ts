import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import {
  ExecutorHttpClient,
  ExecutorRequestError,
} from "../src/adapters/executor-http-client.js";

describe("ExecutorHttpClient", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      ),
    );
    servers.length = 0;
  });

  test("should attach auth and trace headers", async () => {
    let authHeader = "";
    let traceRunId = "";
    let traceId = "";

    const baseUrl = await startServer(servers, (req, res) => {
      authHeader = String(req.headers.authorization ?? "");
      traceRunId = String(req.headers["x-trace-run-id"] ?? "");
      traceId = String(req.headers["x-trace-id"] ?? "");
      sendJson(res, 200, { ok: true });
    });

    const client = new ExecutorHttpClient({
      baseUrl,
      token: "test-token",
    });

    await client.syncWorkspace({
      sessionId: "sess-1",
      containerId: "ctr-1",
      workspaceS3Prefix: "app/a/project/default/u/session/sess-1/workspace",
      include: ["**"],
      exclude: ["node_modules/**"],
      reason: "pre.stop",
      trace: {
        traceId: "trace-1",
        sessionId: "sess-1",
        executorId: "ctr-1",
        operation: "workspace.sync.pre.stop",
        ts: "2026-02-12T10:00:00.000Z",
        runId: "run-1",
      },
    });

    expect(authHeader).toBe("Bearer test-token");
    expect(traceId).toBe("trace-1");
    expect(traceRunId).toBe("run-1");
  });

  test("should retry once on transient 500", async () => {
    let attempts = 0;

    const baseUrl = await startServer(servers, (_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        sendJson(res, 500, { error: "temporary_failure" });
        return;
      }
      sendJson(res, 200, { ok: true });
    });

    const client = new ExecutorHttpClient({
      baseUrl,
      maxRetries: 1,
      retryDelayMs: 1,
    });

    await client.syncWorkspace({
      sessionId: "sess-2",
      containerId: "ctr-2",
      workspaceS3Prefix: "app/a/project/default/u/session/sess-2/workspace",
      include: ["**"],
      exclude: [],
      reason: "pre.stop",
    });

    expect(attempts).toBe(2);
  });

  test("should not retry on 400", async () => {
    let attempts = 0;

    const baseUrl = await startServer(servers, (_req, res) => {
      attempts += 1;
      sendJson(res, 400, { error: "bad_request" });
    });

    const client = new ExecutorHttpClient({
      baseUrl,
      maxRetries: 3,
      retryDelayMs: 1,
    });

    const error = await client
      .syncWorkspace({
        sessionId: "sess-3",
        containerId: "ctr-3",
        workspaceS3Prefix: "app/a/project/default/u/session/sess-3/workspace",
        include: ["**"],
        exclude: [],
        reason: "pre.remove",
      })
      .catch((err) => err);

    expect(error).toBeInstanceOf(ExecutorRequestError);
    expect(error).toMatchObject({
      kind: "http",
      status: 400,
      attempt: 1,
    });
    expect(attempts).toBe(1);
  });
});

async function startServer(
  servers: Server[],
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }

  return `http://127.0.0.1:${address.port}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
