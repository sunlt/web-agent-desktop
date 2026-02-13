import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ProviderKind,
  ProviderRunHandle,
  ProviderRunInput,
} from "../providers/types.js";
import { ProviderRegistry } from "../providers/provider-registry.js";

export interface StartRunInput {
  readonly runId?: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly resumeSessionId?: string;
  readonly executionProfile?: string;
  readonly tools?: Record<string, unknown>;
  readonly providerOptions?: Record<string, unknown>;
  readonly requireHumanLoop?: boolean;
}

export interface RunSnapshot {
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly status:
    | "blocked"
    | "running"
    | "succeeded"
    | "failed"
    | "canceled";
  readonly warnings: readonly string[];
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly reason?: string;
}

export type RunOrchestratorEvent =
  | {
      readonly type: "run.status";
      readonly runId: string;
      readonly provider: ProviderKind;
      readonly status: "started" | "finished" | "failed" | "blocked";
      readonly ts: string;
      readonly detail?: string;
    }
  | {
      readonly type: "message.delta";
      readonly runId: string;
      readonly provider: ProviderKind;
      readonly text: string;
      readonly ts: string;
    }
  | {
      readonly type: "todo.update";
      readonly runId: string;
      readonly provider: ProviderKind;
      readonly todo: {
        readonly todoId: string;
        readonly content: string;
        readonly status: "todo" | "doing" | "done" | "canceled";
        readonly order: number;
      };
      readonly ts: string;
    }
  | {
      readonly type: "run.warning";
      readonly runId: string;
      readonly provider: ProviderKind;
      readonly warning: string;
      readonly ts: string;
    };

interface ActiveRunContext {
  runId: string;
  provider: ProviderKind;
  handle: ProviderRunHandle | null;
  status: RunSnapshot["status"];
  warnings: string[];
  startedAt: Date;
  endedAt: Date | null;
  reason?: string;
  streamed: boolean;
}

export interface StartRunResult {
  readonly runId: string;
  readonly accepted: boolean;
  readonly warnings: readonly string[];
  readonly reason?: string;
}

export interface ReplyHumanLoopInput {
  readonly runId: string;
  readonly questionId: string;
  readonly answer: string;
}

export interface ReplyHumanLoopResult {
  readonly accepted: boolean;
  readonly reason?: string;
  readonly provider?: ProviderKind;
}

export class RunOrchestrator {
  private readonly runs = new Map<string, ActiveRunContext>();

  constructor(private readonly registry: ProviderRegistry) {}

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    const runId = input.runId ?? randomUUID();
    const adapter = this.registry.get(input.provider);
    const warnings: string[] = [];

    if (input.requireHumanLoop && !adapter.capabilities.humanLoop) {
      const reason =
        "当前 provider 不支持运行中 human-loop 注入，请引导用户补充输入后重试。";
      this.runs.set(runId, {
        runId,
        provider: input.provider,
        handle: null,
        status: "blocked",
        warnings,
        startedAt: new Date(),
        endedAt: new Date(),
        reason,
        streamed: false,
      });

      return {
        runId,
        accepted: false,
        warnings,
        reason,
      };
    }

    let resumeSessionId = input.resumeSessionId;
    if (resumeSessionId && !adapter.capabilities.resume) {
      warnings.push(
        `provider ${input.provider} 不支持 resume，已降级为新会话运行。`,
      );
      resumeSessionId = undefined;
    }

    const runInput: ProviderRunInput = {
      runId,
      provider: input.provider,
      model: input.model,
      messages: input.messages,
      resumeSessionId,
      executionProfile: input.executionProfile,
      tools: input.tools,
      providerOptions: input.providerOptions,
    };

    const handle = await adapter.run(runInput);

    this.runs.set(runId, {
      runId,
      provider: input.provider,
      handle,
      status: "running",
      warnings,
      startedAt: new Date(),
      endedAt: null,
      streamed: false,
    });

    return {
      runId,
      accepted: true,
      warnings,
    };
  }

  async *streamRun(runId: string): AsyncIterable<RunOrchestratorEvent> {
    const context = this.runs.get(runId);
    if (!context) {
      throw new Error(`run not found: ${runId}`);
    }

    if (context.status === "blocked") {
      yield {
        type: "run.status",
        runId,
        provider: context.provider,
        status: "blocked",
        ts: new Date().toISOString(),
        detail: context.reason,
      };
      return;
    }

    if (!context.handle) {
      throw new Error(`run handle missing: ${runId}`);
    }

    if (context.streamed) {
      throw new Error(`run stream already consumed: ${runId}`);
    }

    context.streamed = true;

    yield {
      type: "run.status",
      runId,
      provider: context.provider,
      status: "started",
      ts: new Date().toISOString(),
    };

    for (const warning of context.warnings) {
      yield {
        type: "run.warning",
        runId,
        provider: context.provider,
        warning,
        ts: new Date().toISOString(),
      };
    }

    try {
      for await (const chunk of context.handle.stream()) {
        if (chunk.type === "message.delta") {
          yield {
            type: "message.delta",
            runId,
            provider: context.provider,
            text: chunk.text,
            ts: new Date().toISOString(),
          };
          continue;
        }

        if (chunk.type === "todo.update") {
          yield {
            type: "todo.update",
            runId,
            provider: context.provider,
            todo: chunk.todo,
            ts: new Date().toISOString(),
          };
          continue;
        }

        context.status = chunk.status;
        context.endedAt = new Date();
        const terminalDetail = chunk.reason
          ? `${chunk.status}: ${chunk.reason}`
          : chunk.status;
        if (chunk.reason) {
          context.reason = chunk.reason;
        }
        yield {
          type: "run.status",
          runId,
          provider: context.provider,
          status: "finished",
          ts: context.endedAt.toISOString(),
          detail: terminalDetail,
        };
      }
    } catch (error) {
      context.status = "failed";
      context.endedAt = new Date();
      context.reason = error instanceof Error ? error.message : String(error);
      yield {
        type: "run.status",
        runId,
        provider: context.provider,
        status: "failed",
        ts: context.endedAt.toISOString(),
        detail: context.reason,
      };
    }
  }

  async stopRun(runId: string): Promise<boolean> {
    const context = this.runs.get(runId);
    if (!context || !context.handle || context.status !== "running") {
      return false;
    }

    await context.handle.stop();
    context.status = "canceled";
    context.endedAt = new Date();
    return true;
  }

  getRunSnapshot(runId: string): RunSnapshot | null {
    const context = this.runs.get(runId);
    if (!context) {
      return null;
    }

    return {
      runId: context.runId,
      provider: context.provider,
      status: context.status,
      warnings: context.warnings,
      startedAt: context.startedAt,
      endedAt: context.endedAt,
      reason: context.reason,
    };
  }

  async replyHumanLoop(input: ReplyHumanLoopInput): Promise<ReplyHumanLoopResult> {
    const context = this.runs.get(input.runId);
    if (!context) {
      return {
        accepted: false,
        reason: "run not found",
      };
    }

    if (
      context.status === "succeeded" ||
      context.status === "failed" ||
      context.status === "canceled" ||
      context.status === "blocked"
    ) {
      return {
        accepted: false,
        reason: `run status does not accept human-loop reply: ${context.status}`,
        provider: context.provider,
      };
    }

    const adapter = this.registry.get(context.provider);
    if (!adapter.capabilities.humanLoop || !adapter.reply) {
      return {
        accepted: false,
        reason: `provider ${context.provider} does not support human-loop reply`,
        provider: context.provider,
      };
    }

    await adapter.reply({
      runId: input.runId,
      questionId: input.questionId,
      answer: input.answer,
    });

    return {
      accepted: true,
      provider: context.provider,
    };
  }
}
