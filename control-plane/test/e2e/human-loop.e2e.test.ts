import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import type {
  AgentProviderAdapter,
  ProviderRunHandle,
  ProviderRunInput,
} from "../../src/providers/types.js";
import { InMemoryRunCallbackRepository } from "../../src/repositories/in-memory-run-callback-repository.js";
import { withHttpServer } from "./http-test-utils.js";

class HumanLoopUnsupportedProvider implements AgentProviderAdapter {
  readonly kind = "opencode" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: true,
    buildPlanMode: true,
  };

  async run(_: ProviderRunInput): Promise<ProviderRunHandle> {
    throw new Error("should not run when human-loop is required");
  }
}

class HumanLoopSupportedProvider implements AgentProviderAdapter {
  readonly kind = "claude-code" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: true,
    todoStream: true,
    buildPlanMode: false,
  };

  async run(_: ProviderRunInput): Promise<ProviderRunHandle> {
    return {
      stream: async function* () {
        yield {
          type: "message.delta" as const,
          text: "human-loop-ready",
        };
        yield {
          type: "run.finished" as const,
          status: "succeeded",
        };
      },
      stop: async () => {},
    };
  }
}

class HumanLoopReplyProvider implements AgentProviderAdapter {
  readonly kind = "codex-cli" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: true,
    todoStream: true,
    buildPlanMode: false,
  };
  private readonly waiters = new Map<string, () => void>();

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    const waiters = this.waiters;
    return {
      stream: async function* () {
        yield {
          type: "message.delta" as const,
          text: "waiting-human-reply",
        };

        await new Promise<void>((resolve) => {
          waiters.set(input.runId, resolve);
        });

        yield {
          type: "run.finished" as const,
          status: "succeeded",
        };
      },
      stop: async () => {
        const resume = waiters.get(input.runId);
        if (resume) {
          waiters.delete(input.runId);
          resume();
        }
      },
    };
  }

  async reply(input: {
    runId: string;
    questionId: string;
    answer: string;
  }): Promise<void> {
    const resume = this.waiters.get(input.runId);
    if (!resume) {
      throw new Error("run does not wait for human reply");
    }
    this.waiters.delete(input.runId);
    resume();
  }
}

describe("Human Loop E2E", () => {
  test("should return 409 when provider does not support required human-loop", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [new HumanLoopUnsupportedProvider()],
    });

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runs/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "opencode",
          model: "openai/gpt-5.1-codex",
          messages: [{ role: "user", content: "请执行任务" }],
          requireHumanLoop: true,
        }),
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        accepted: boolean;
        reason: string;
      };
      expect(body.accepted).toBe(false);
      expect(body.reason).toContain("human-loop");
    });
  });

  test("should accept run when provider supports required human-loop", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [new HumanLoopSupportedProvider()],
    });

    await withHttpServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/runs/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId: "run-human-loop-ok",
          provider: "claude-code",
          model: "sonnet",
          messages: [{ role: "user", content: "继续执行" }],
          requireHumanLoop: true,
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        accepted: boolean;
        events: Array<{ type: string; status?: string; text?: string }>;
        snapshot: { status: string };
      };
      expect(body.accepted).toBe(true);
      expect(body.events.some((item) => item.type === "message.delta" && item.text === "human-loop-ready")).toBe(true);
      expect(
        body.events.some(
          (item) => item.type === "run.status" && item.status === "finished",
        ),
      ).toBe(true);
      expect(body.snapshot.status).toBe("succeeded");
    });
  });

  test("should list pending human-loop requests and accept reply", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [new HumanLoopReplyProvider()],
    });

    await withHttpServer(app, async (baseUrl) => {
      const runId = "run-human-loop-reply";
      const startPromise = fetch(`${baseUrl}/api/runs/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          provider: "codex-cli",
          model: "gpt-5.1-codex",
          messages: [{ role: "user", content: "等待用户回复后继续" }],
          requireHumanLoop: true,
        }),
      });

      await sleep(30);

      const bindResponse = await fetch(`${baseUrl}/api/runs/${runId}/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-human-loop-reply" }),
      });
      expect(bindResponse.status).toBe(200);

      const requested = await fetch(`${baseUrl}/api/runs/${runId}/callbacks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: "evt-human-loop-requested-1",
          type: "human_loop.requested",
          questionId: "q-human-loop-1",
          prompt: "请确认是否继续",
        }),
      });
      expect(requested.status).toBe(200);

      const pending = await fetch(
        `${baseUrl}/api/human-loop/pending?runId=${runId}`,
      );
      expect(pending.status).toBe(200);
      const pendingBody = (await pending.json()) as {
        total: number;
        requests: Array<{ questionId: string; status: string }>;
      };
      expect(pendingBody.total).toBe(1);
      expect(pendingBody.requests[0]).toMatchObject({
        questionId: "q-human-loop-1",
        status: "pending",
      });

      const reply = await fetch(`${baseUrl}/api/human-loop/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          questionId: "q-human-loop-1",
          answer: "继续执行",
        }),
      });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({
        ok: true,
        status: "resolved",
      });

      const pendingAfterReply = await fetch(
        `${baseUrl}/api/human-loop/pending?runId=${runId}`,
      );
      expect(pendingAfterReply.status).toBe(200);
      const pendingAfterReplyBody = (await pendingAfterReply.json()) as {
        total: number;
      };
      expect(pendingAfterReplyBody.total).toBe(0);

      const resolved = await fetch(
        `${baseUrl}/api/human-loop/requests?runId=${runId}&status=resolved`,
      );
      expect(resolved.status).toBe(200);
      const resolvedBody = (await resolved.json()) as {
        total: number;
        requests: Array<{ questionId: string; status: string; resolvedAt: string | null }>;
      };
      expect(resolvedBody.total).toBe(1);
      expect(resolvedBody.requests[0]).toMatchObject({
        questionId: "q-human-loop-1",
        status: "resolved",
      });
      expect(resolvedBody.requests[0]?.resolvedAt).not.toBeNull();

      const startResponse = await startPromise;
      expect(startResponse.status).toBe(200);
      const startBody = (await startResponse.json()) as {
        accepted: boolean;
        snapshot: { status: string };
      };
      expect(startBody.accepted).toBe(true);
      expect(startBody.snapshot.status).toBe("succeeded");
    });
  });

  test("should cancel pending human-loop requests when run is stopped", async () => {
    const callbackRepository = new InMemoryRunCallbackRepository();
    const app = createControlPlaneApp({
      callbackRepository,
      providerAdapters: [new HumanLoopReplyProvider()],
    });

    await withHttpServer(app, async (baseUrl) => {
      const runId = "run-human-loop-stop";
      const questionId = "q-human-loop-stop-1";

      const startPromise = fetch(`${baseUrl}/api/runs/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runId,
          provider: "codex-cli",
          model: "gpt-5.1-codex",
          messages: [{ role: "user", content: "等待 stop 触发取消" }],
          requireHumanLoop: true,
        }),
      });

      await sleep(30);

      const bindResponse = await fetch(`${baseUrl}/api/runs/${runId}/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "sess-human-loop-stop" }),
      });
      expect(bindResponse.status).toBe(200);

      const requested = await fetch(`${baseUrl}/api/runs/${runId}/callbacks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: "evt-human-loop-requested-stop-1",
          type: "human_loop.requested",
          questionId,
          prompt: "请确认是否继续",
        }),
      });
      expect(requested.status).toBe(200);

      const stopResponse = await fetch(`${baseUrl}/api/runs/${runId}/stop`, {
        method: "POST",
      });
      expect(stopResponse.status).toBe(200);
      expect(await stopResponse.json()).toEqual({ ok: true });

      const pending = await fetch(`${baseUrl}/api/human-loop/pending?runId=${runId}`);
      expect(pending.status).toBe(200);
      const pendingBody = (await pending.json()) as { total: number };
      expect(pendingBody.total).toBe(0);

      const canceled = await fetch(
        `${baseUrl}/api/human-loop/requests?runId=${runId}&status=canceled`,
      );
      expect(canceled.status).toBe(200);
      const canceledBody = (await canceled.json()) as {
        total: number;
        requests: Array<{ questionId: string; status: string; resolvedAt: string | null }>;
      };
      expect(canceledBody.total).toBe(1);
      expect(canceledBody.requests[0]).toMatchObject({
        questionId,
        status: "canceled",
      });
      expect(canceledBody.requests[0]?.resolvedAt).not.toBeNull();

      expect(callbackRepository.getRunStatus(runId)).toBe("canceled");

      const startResponse = await startPromise;
      expect(startResponse.status).toBe(200);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
