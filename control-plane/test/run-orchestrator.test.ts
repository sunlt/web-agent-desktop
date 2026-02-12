import { describe, expect, test } from "vitest";
import { ProviderRegistry } from "../src/providers/provider-registry.js";
import type {
  AgentProviderAdapter,
  ProviderRunHandle,
  ProviderRunInput,
} from "../src/providers/types.js";
import { RunOrchestrator } from "../src/services/run-orchestrator.js";

class FailingProviderAdapter implements AgentProviderAdapter {
  readonly kind = "opencode" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: false,
    buildPlanMode: true,
  };

  async run(_: ProviderRunInput): Promise<ProviderRunHandle> {
    throw new Error("provider crashed");
  }
}

class HealthyProviderAdapter implements AgentProviderAdapter {
  readonly kind = "codex-cli" as const;
  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: false,
    buildPlanMode: false,
  };

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    let stopped = false;

    return {
      stream: async function* () {
        yield {
          type: "message.delta" as const,
          text: `ok:${input.messages.length}`,
        };
        yield {
          type: "run.finished" as const,
          status: stopped ? "canceled" : "succeeded",
        };
      },
      stop: async () => {
        stopped = true;
      },
    };
  }
}

class HumanLoopUnsupportedAdapter implements AgentProviderAdapter {
  readonly kind = "codex-cli" as const;
  readonly capabilities = {
    resume: false,
    humanLoop: false,
    todoStream: false,
    buildPlanMode: false,
  };

  async run(_: ProviderRunInput): Promise<ProviderRunHandle> {
    throw new Error("run should be blocked before provider.run");
  }
}

class ResumeUnsupportedAdapter implements AgentProviderAdapter {
  readonly kind = "claude-code" as const;
  readonly capabilities = {
    resume: false,
    humanLoop: false,
    todoStream: false,
    buildPlanMode: false,
  };

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    let stopped = false;

    return {
      stream: async function* () {
        yield {
          type: "message.delta" as const,
          text: `resume:${input.resumeSessionId ?? "none"}`,
        };
        yield {
          type: "run.finished" as const,
          status: stopped ? "canceled" : "succeeded",
        };
      },
      stop: async () => {
        stopped = true;
      },
    };
  }
}

describe("RunOrchestrator", () => {
  test("should block run when human-loop is required but unsupported", async () => {
    const registry = new ProviderRegistry([new HumanLoopUnsupportedAdapter()]);
    const orchestrator = new RunOrchestrator(registry);

    const started = await orchestrator.startRun({
      provider: "codex-cli",
      model: "gpt-5.1-codex",
      messages: [{ role: "user", content: "hello" }],
      requireHumanLoop: true,
    });

    expect(started.accepted).toBe(false);
    expect(started.reason).toContain("human-loop");

    const snapshot = orchestrator.getRunSnapshot(started.runId);
    expect(snapshot?.status).toBe("blocked");
  });

  test("should degrade resume and continue when provider does not support resume", async () => {
    const registry = new ProviderRegistry([new ResumeUnsupportedAdapter()]);
    const orchestrator = new RunOrchestrator(registry);

    const started = await orchestrator.startRun({
      runId: "run-resume-1",
      provider: "claude-code",
      model: "sonnet",
      messages: [{ role: "user", content: "continue" }],
      resumeSessionId: "sess-legacy",
    });

    expect(started.accepted).toBe(true);
    expect(started.warnings).toHaveLength(1);

    const events = [];
    for await (const event of orchestrator.streamRun(started.runId)) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "run.warning")).toBe(true);
    expect(orchestrator.getRunSnapshot(started.runId)?.status).toBe("succeeded");
  });

  test("should isolate provider failures from other providers", async () => {
    const registry = new ProviderRegistry([
      new FailingProviderAdapter(),
      new HealthyProviderAdapter(),
    ]);
    const orchestrator = new RunOrchestrator(registry);

    await expect(
      orchestrator.startRun({
        provider: "opencode",
        model: "broken-model",
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toThrow("provider crashed");

    const healthy = await orchestrator.startRun({
      runId: "run-healthy-1",
      provider: "codex-cli",
      model: "gpt-5",
      messages: [{ role: "user", content: "test healthy" }],
    });

    expect(healthy.accepted).toBe(true);

    const events = [];
    for await (const event of orchestrator.streamRun("run-healthy-1")) {
      events.push(event);
    }

    const finished = events.find(
      (event) => event.type === "run.status" && event.status === "finished",
    );
    expect(finished).toBeDefined();
    expect(orchestrator.getRunSnapshot("run-healthy-1")?.status).toBe("succeeded");
  });
});
