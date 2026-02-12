import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import { InMemoryRunCallbackRepository } from "../../src/repositories/in-memory-run-callback-repository.js";
import { withHttpServer } from "./http-test-utils.js";

describe("Run Callbacks API E2E", () => {
  test("callbacks should support bind, dedupe and usage finalize-once", async () => {
    const callbackRepository = new InMemoryRunCallbackRepository();
    const app = createControlPlaneApp({
      callbackRepository,
      providerAdapters: [],
    });

    await withHttpServer(app, async (baseUrl) => {
      const bindResponse = await fetch(`${baseUrl}/api/runs/run-callback-e2e/bind`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: "sess-e2e-1",
        }),
      });

      expect(bindResponse.status).toBe(200);

      const firstCallback = await fetch(`${baseUrl}/api/runs/run-callback-e2e/callbacks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          eventId: "evt-message-stop-1",
          type: "message.stop",
        }),
      });

      expect(firstCallback.status).toBe(200);
      const firstBody = (await firstCallback.json()) as { action: string; duplicate: boolean };
      expect(firstBody.action).toBe("message_stop_synced");
      expect(firstBody.duplicate).toBe(false);

      const duplicated = await fetch(`${baseUrl}/api/runs/run-callback-e2e/callbacks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          eventId: "evt-message-stop-1",
          type: "message.stop",
        }),
      });

      expect(duplicated.status).toBe(200);
      const duplicatedBody = (await duplicated.json()) as {
        action: string;
        duplicate: boolean;
      };
      expect(duplicatedBody.action).toBe("duplicate_ignored");
      expect(duplicatedBody.duplicate).toBe(true);

      const finishA = await fetch(`${baseUrl}/api/runs/run-callback-e2e/callbacks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          eventId: "evt-finish-1",
          type: "run.finished",
          status: "succeeded",
          usage: {
            inputTokens: 10,
            outputTokens: 20,
          },
        }),
      });

      expect(finishA.status).toBe(200);

      const finishB = await fetch(`${baseUrl}/api/runs/run-callback-e2e/callbacks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          eventId: "evt-finish-2",
          type: "run.finished",
          status: "succeeded",
          usage: {
            inputTokens: 999,
            outputTokens: 888,
          },
        }),
      });

      expect(finishB.status).toBe(200);
      expect(callbackRepository.getUsage("run-callback-e2e")).toEqual({
        inputTokens: 10,
        outputTokens: 20,
      });
    });
  });
});
