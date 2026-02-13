import type {
  ProviderKind,
  ProviderRunHandle,
  ProviderRunInput,
  ProviderStreamChunk,
} from "../providers/types.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { StreamBus } from "./stream-bus.js";

export interface StartProviderRunInput extends ProviderRunInput {
  readonly requireHumanLoop?: boolean;
}

export interface StartProviderRunResult {
  readonly runId: string;
  readonly accepted: boolean;
  readonly warnings: readonly string[];
  readonly reason?: string;
}

export interface ReplyProviderRunInput {
  readonly runId: string;
  readonly questionId: string;
  readonly answer: string;
}

export interface ReplyProviderRunResult {
  readonly accepted: boolean;
  readonly provider?: ProviderKind;
  readonly reason?: string;
}

export interface ProviderRunEvent {
  readonly type: "provider.chunk";
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly chunk: ProviderStreamChunk;
  readonly ts: string;
}

interface ActiveRunContext {
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly handle: ProviderRunHandle;
  readonly warnings: string[];
  readonly startedAt: Date;
  readonly requiresHumanLoop: boolean;
  status: "running" | "succeeded" | "failed" | "canceled";
  endedAt: Date | null;
  finalChunk: ProviderStreamChunk | null;
  pumpStarted: boolean;
  closed: boolean;
}

export class ProviderRunner {
  private readonly runs = new Map<string, ActiveRunContext>();
  private readonly streamBus = new StreamBus<ProviderRunEvent>(2000);

  constructor(private readonly registry: ProviderRegistry) {}

  async startRun(input: StartProviderRunInput): Promise<StartProviderRunResult> {
    if (this.runs.has(input.runId)) {
      return {
        runId: input.runId,
        accepted: false,
        warnings: [],
        reason: `run already exists: ${input.runId}`,
      };
    }

    const adapter = this.registry.get(input.provider);
    const warnings: string[] = [];

    if (input.requireHumanLoop && !adapter.capabilities.humanLoop) {
      return {
        runId: input.runId,
        accepted: false,
        warnings,
        reason:
          "当前 provider 不支持运行中 human-loop 注入，请引导用户补充输入后重试。",
      };
    }

    let resumeSessionId = input.resumeSessionId;
    if (resumeSessionId && !adapter.capabilities.resume) {
      warnings.push(
        `provider ${input.provider} 不支持 resume，已降级为新会话运行。`,
      );
      resumeSessionId = undefined;
    }

    const handle = await adapter.run({
      ...input,
      resumeSessionId,
    });

    this.runs.set(input.runId, {
      runId: input.runId,
      provider: input.provider,
      handle,
      status: "running",
      warnings,
      startedAt: new Date(),
      endedAt: null,
      finalChunk: null,
      pumpStarted: false,
      closed: false,
      requiresHumanLoop: Boolean(input.requireHumanLoop),
    });

    logProviderRun("info", {
      message: "provider run accepted",
      runId: input.runId,
      provider: input.provider,
      requireHumanLoop: Boolean(input.requireHumanLoop),
      resumeSessionId: resumeSessionId ?? null,
    });

    return {
      runId: input.runId,
      accepted: true,
      warnings,
    };
  }

  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  getRunProvider(runId: string): ProviderKind | null {
    return this.runs.get(runId)?.provider ?? null;
  }

  subscribe(input: {
    runId: string;
    afterSeq: number;
    onEvent: (entry: { seq: number; event: ProviderRunEvent }) => void;
    onClose: () => void;
  }): () => void {
    return this.streamBus.subscribe({
      streamId: input.runId,
      afterSeq: input.afterSeq,
      onEvent: input.onEvent,
      onClose: input.onClose,
    });
  }

  ensurePump(runId: string): void {
    const context = this.runs.get(runId);
    if (!context || context.pumpStarted || context.closed) {
      return;
    }

    context.pumpStarted = true;

    void (async () => {
      try {
        for await (const chunk of context.handle.stream()) {
          this.publishChunk(context, chunk);
          if (chunk.type === "run.finished") {
            break;
          }
        }
      } catch (error) {
        if (!context.finalChunk) {
          this.publishChunk(context, {
            type: "run.finished",
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        this.closeContext(context);
      }
    })();
  }

  async stopRun(runId: string): Promise<boolean> {
    const context = this.runs.get(runId);
    if (!context || context.status !== "running") {
      return false;
    }

    await context.handle.stop();

    if (!context.finalChunk) {
      this.publishChunk(context, {
        type: "run.finished",
        status: "canceled",
      });
    }

    this.closeContext(context);
    return true;
  }

  async replyHumanLoop(
    input: ReplyProviderRunInput,
  ): Promise<ReplyProviderRunResult> {
    const context = this.runs.get(input.runId);
    if (!context) {
      return {
        accepted: false,
        reason: "run not found",
      };
    }

    if (context.status !== "running") {
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

  private publishChunk(
    context: ActiveRunContext,
    chunk: ProviderStreamChunk,
  ): void {
    if (context.closed) {
      return;
    }

    if (chunk.type === "run.finished") {
      if (context.finalChunk) {
        return;
      }
      context.finalChunk = chunk;
      context.status = chunk.status;
      context.endedAt = new Date();
      logProviderRun(chunk.status === "failed" ? "error" : "info", {
        message: "provider run finished",
        runId: context.runId,
        provider: context.provider,
        status: chunk.status,
        reason: chunk.reason ?? null,
      });
    }

    this.streamBus.publish(context.runId, {
      type: "provider.chunk",
      runId: context.runId,
      provider: context.provider,
      chunk,
      ts: new Date().toISOString(),
    });
  }

  private closeContext(context: ActiveRunContext): void {
    if (context.closed) {
      return;
    }
    if (!context.finalChunk) {
      this.publishChunk(context, {
        type: "run.finished",
        status: "failed",
        reason: "provider stream closed without terminal event",
      });
    }
    if (!context.endedAt) {
      context.endedAt = new Date();
    }
    context.closed = true;
    logProviderRun("info", {
      message: "provider run closed",
      runId: context.runId,
      provider: context.provider,
      status: context.status,
      endedAt: context.endedAt?.toISOString() ?? null,
    });
    this.streamBus.close(context.runId);
  }
}

function logProviderRun(
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>,
): void {
  const record = JSON.stringify({
    level,
    ts: new Date().toISOString(),
    component: "executor-provider-runner",
    ...payload,
  });
  if (level === "error") {
    console.error(record);
    return;
  }
  if (level === "warn") {
    console.warn(record);
    return;
  }
  console.info(record);
}
