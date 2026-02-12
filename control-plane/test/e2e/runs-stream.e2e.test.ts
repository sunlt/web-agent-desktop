import { describe, expect, test } from "vitest";
import { createControlPlaneApp } from "../../src/app.js";
import type {
  AgentProviderAdapter,
  ProviderRunHandle,
  ProviderRunInput,
  ProviderStreamChunk,
} from "../../src/providers/types.js";
import { withHttpServer } from "./http-test-utils.js";

class StreamE2EProviderAdapter implements AgentProviderAdapter {
  readonly kind = "opencode" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: true,
    buildPlanMode: true,
  };

  async run(_input: ProviderRunInput): Promise<ProviderRunHandle> {
    const chunks: ProviderStreamChunk[] = [
      { type: "message.delta", text: "stream:hello" },
      {
        type: "todo.update",
        todo: {
          todoId: "todo-stream-1",
          content: "流式任务",
          status: "doing",
          order: 1,
        },
      },
      { type: "run.finished", status: "succeeded" },
    ];

    return {
      stream: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
      stop: async () => {},
    };
  }
}

type SseEvent = {
  id?: number;
  event: string;
  data: unknown;
};

describe("Runs Stream API E2E", () => {
  test("should stream run events via SSE and support cursor replay", async () => {
    const app = createControlPlaneApp({
      providerAdapters: [new StreamE2EProviderAdapter()],
    });

    await withHttpServer(app, async (baseUrl) => {
      const runId = "run-stream-e2e-1";

      const response = await fetch(`${baseUrl}/api/runs/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          runId,
          provider: "opencode",
          model: "openai/gpt-5.1-codex",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      const streamText = await response.text();
      const streamEvents = parseSseEvents(streamText);

      expect(
        streamEvents.some(
          (event) =>
            event.event === "run.status" &&
            (event.data as { status?: string }).status === "started",
        ),
      ).toBe(true);
      expect(
        streamEvents.some(
          (event) =>
            event.event === "message.delta" &&
            (event.data as { text?: string }).text === "stream:hello",
        ),
      ).toBe(true);
      expect(streamEvents.some((event) => event.event === "run.closed")).toBe(true);

      const replay = await fetch(
        `${baseUrl}/api/runs/${runId}/stream?cursor=1`,
        {
          headers: {
            accept: "text/event-stream",
          },
        },
      );
      expect(replay.status).toBe(200);

      const replayText = await replay.text();
      const replayEvents = parseSseEvents(replayText);

      const replayIds = replayEvents
        .map((event) => event.id)
        .filter((id): id is number => typeof id === "number");
      expect(replayIds.length).toBeGreaterThan(0);
      expect(replayIds.every((id) => id > 1)).toBe(true);
      expect(replayEvents.some((event) => event.event === "run.closed")).toBe(true);
    });
  });
});

function parseSseEvents(raw: string): SseEvent[] {
  const blocks = raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith(":"));

  return blocks
    .map((block) => {
      const lines = block.split("\n");
      let id: number | undefined;
      let event = "message";
      let dataText = "";

      for (const line of lines) {
        if (line.startsWith("id:")) {
          const parsed = Number(line.slice(3).trim());
          id = Number.isFinite(parsed) ? parsed : undefined;
          continue;
        }
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataText = line.slice(5).trim();
        }
      }

      let data: unknown = dataText;
      try {
        data = JSON.parse(dataText);
      } catch {
        data = dataText;
      }

      return {
        id,
        event,
        data,
      };
    })
    .filter((event) => event.event.length > 0);
}
