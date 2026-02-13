import express, { type Express, type Response } from "express";
import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import { withHttpServer } from "./http-test-utils.js";

type ProviderKind = "claude-code" | "opencode" | "codex-cli";

type MockRunState = {
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly requireHumanLoop: boolean;
  readonly model: string;
  readonly messages: Array<{ role: string; content: string }>;
  streamResponse: Response | null;
  replied: boolean;
  stopped: boolean;
};

type MockExecutorManager = {
  app: Express;
  state: {
    starts: Array<{ runId: string; provider: ProviderKind; requireHumanLoop: boolean }>;
    replies: Array<{ runId: string; questionId: string; answer: string }>;
    stops: string[];
  };
};

describe("Executor-Manager Provider E2E", () => {
  test("should execute run through executor-manager provider path", async () => {
    const mock = createMockExecutorManager();

    await withHttpServer(mock.app, async (executorManagerBaseUrl) => {
      await withControlPlaneEnv(
        {
          EXECUTOR_MANAGER_BASE_URL: executorManagerBaseUrl,
          CONTROL_PLANE_PROVIDER_MODE: "real",
        },
        async () => {
          const app = createControlPlaneApp();

          await withHttpServer(app, async (baseUrl) => {
            const runId = `run-remote-basic-${Date.now()}`;
            const response = await fetch(`${baseUrl}/api/runs/start`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify({
                runId,
                provider: "opencode",
                model: "openai/gpt-5.1-codex",
                messages: [{ role: "user", content: "hello remote path" }],
              }),
            });

            expect(response.status).toBe(200);
            const body = (await response.json()) as {
              accepted: boolean;
              runId: string;
              events: Array<{ type: string; text?: string; status?: string }>;
              snapshot: { status: string };
            };

            expect(body.accepted).toBe(true);
            expect(body.runId).toBe(runId);
            expect(body.snapshot.status).toBe("succeeded");
            expect(
              body.events.some(
                (event) => event.type === "message.delta" && event.text === "mock-remote:opencode",
              ),
            ).toBe(true);
            expect(
              body.events.some(
                (event) => event.type === "run.status" && event.status === "finished",
              ),
            ).toBe(true);
          });
        },
      );
    });

    expect(mock.state.starts).toHaveLength(1);
    expect(mock.state.starts[0]).toMatchObject({
      provider: "opencode",
      requireHumanLoop: false,
    });
  });

  test("should forward human-loop reply to executor-manager provider", async () => {
    const mock = createMockExecutorManager();

    await withHttpServer(mock.app, async (executorManagerBaseUrl) => {
      await withControlPlaneEnv(
        {
          EXECUTOR_MANAGER_BASE_URL: executorManagerBaseUrl,
          CONTROL_PLANE_PROVIDER_MODE: "real",
        },
        async () => {
          const app = createControlPlaneApp();

          await withHttpServer(app, async (baseUrl) => {
            const runId = `run-remote-human-${Date.now()}`;
            const questionId = `q-remote-human-${Date.now()}`;

            const startPromise = fetch(`${baseUrl}/api/runs/start`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                runId,
                provider: "codex-cli",
                model: "gpt-5.1-codex",
                messages: [{ role: "user", content: "wait for human reply" }],
                requireHumanLoop: true,
              }),
            });

            await sleep(30);

            const bindResponse = await fetch(`${baseUrl}/api/runs/${runId}/bind`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: `sess-${runId}` }),
            });
            expect(bindResponse.status).toBe(200);

            const requested = await fetch(`${baseUrl}/api/runs/${runId}/callbacks`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                eventId: `evt-${questionId}`,
                type: "human_loop.requested",
                questionId,
                prompt: "请确认继续",
              }),
            });
            expect(requested.status).toBe(200);

            const reply = await fetch(`${baseUrl}/api/human-loop/reply`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                runId,
                questionId,
                answer: "继续",
              }),
            });
            expect(reply.status).toBe(200);
            expect(await reply.json()).toMatchObject({ ok: true, status: "resolved" });

            const startResponse = await startPromise;
            expect(startResponse.status).toBe(200);
            const startBody = (await startResponse.json()) as {
              accepted: boolean;
              snapshot: { status: string };
            };
            expect(startBody.accepted).toBe(true);
            expect(startBody.snapshot.status).toBe("succeeded");
          });
        },
      );
    });

    expect(mock.state.starts).toHaveLength(1);
    expect(mock.state.starts[0]).toMatchObject({
      provider: "codex-cli",
      requireHumanLoop: true,
    });
    expect(mock.state.replies).toHaveLength(1);
    expect(mock.state.replies[0]).toMatchObject({ answer: "继续" });
  });
});

function createMockExecutorManager(): MockExecutorManager {
  const app = express();
  app.use(express.json());

  const runs = new Map<string, MockRunState>();
  const starts: Array<{ runId: string; provider: ProviderKind; requireHumanLoop: boolean }> = [];
  const replies: Array<{ runId: string; questionId: string; answer: string }> = [];
  const stops: string[] = [];

  app.post("/api/provider-runs/start", (req, res) => {
    const body = req.body as {
      runId?: string;
      provider?: ProviderKind;
      model?: string;
      messages?: Array<{ role: string; content: string }>;
      requireHumanLoop?: boolean;
    };

    if (!body.runId || !body.provider || !body.model || !Array.isArray(body.messages)) {
      return res.status(400).json({ accepted: false, reason: "invalid payload" });
    }

    const state: MockRunState = {
      runId: body.runId,
      provider: body.provider,
      requireHumanLoop:
        body.requireHumanLoop === true || body.provider === "codex-cli",
      model: body.model,
      messages: body.messages,
      streamResponse: null,
      replied: false,
      stopped: false,
    };

    runs.set(body.runId, state);
    starts.push({
      runId: body.runId,
      provider: body.provider,
      requireHumanLoop: state.requireHumanLoop,
    });

    return res.json({
      runId: body.runId,
      accepted: true,
      warnings: [],
    });
  });

  app.get("/api/provider-runs/:runId/stream", (req, res) => {
    const runId = req.params.runId;
    const state = runs.get(runId);
    if (!state) {
      return res.status(404).json({ error: "run not found" });
    }

    setupSseResponse(res);
    writeProviderChunk(res, state, {
      type: "message.delta",
      text: `mock-remote:${state.provider}`,
    });

    if (!state.requireHumanLoop || state.replied || state.stopped) {
      const status = state.stopped ? "canceled" : "succeeded";
      writeProviderChunk(res, state, {
        type: "run.finished",
        status,
      });
      closeProviderStream(res, runId);
      return;
    }

    state.streamResponse = res;
    req.on("close", () => {
      if (state.streamResponse === res) {
        state.streamResponse = null;
      }
    });
  });

  app.post("/api/provider-runs/:runId/human-loop/reply", (req, res) => {
    const runId = req.params.runId;
    const state = runs.get(runId);
    if (!state) {
      return res.status(404).json({ ok: false, reason: "run not found" });
    }

    const body = req.body as { questionId?: string; answer?: string };
    if (!body.questionId || !body.answer) {
      return res.status(400).json({ ok: false, reason: "invalid reply" });
    }

    state.replied = true;
    replies.push({ runId, questionId: body.questionId, answer: body.answer });

    if (state.streamResponse) {
      writeProviderChunk(state.streamResponse, state, {
        type: "run.finished",
        status: "succeeded",
      });
      closeProviderStream(state.streamResponse, runId);
      state.streamResponse = null;
    }

    return res.json({ ok: true });
  });

  app.post("/api/provider-runs/:runId/stop", (req, res) => {
    const runId = req.params.runId;
    const state = runs.get(runId);
    if (!state) {
      return res.status(404).json({ error: "run not found" });
    }

    state.stopped = true;
    stops.push(runId);

    if (state.streamResponse) {
      writeProviderChunk(state.streamResponse, state, {
        type: "run.finished",
        status: "canceled",
      });
      closeProviderStream(state.streamResponse, runId);
      state.streamResponse = null;
    }

    return res.json({ ok: true });
  });

  return {
    app,
    state: {
      starts,
      replies,
      stops,
    },
  };
}

function setupSseResponse(res: Response): void {
  res.status(200);
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();
}

function writeProviderChunk(
  res: Response,
  state: MockRunState,
  chunk:
    | { type: "message.delta"; text: string }
    | { type: "run.finished"; status: "succeeded" | "failed" | "canceled" },
): void {
  const payload = {
    type: "provider.chunk",
    runId: state.runId,
    provider: state.provider,
    chunk,
    ts: new Date().toISOString(),
  };
  res.write(`event: provider.chunk\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function closeProviderStream(res: Response, runId: string): void {
  res.write(`event: provider.closed\n`);
  res.write(`data: ${JSON.stringify({ runId })}\n\n`);
  res.end();
}

async function withControlPlaneEnv(
  overrides: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }

  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
