export const PROVIDER_KINDS = [
  "claude-code",
  "opencode",
  "codex-cli",
  "codex-app-server",
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export type CanonicalProviderKind = Exclude<ProviderKind, "codex-app-server">;

export function normalizeProviderKind(kind: ProviderKind): CanonicalProviderKind {
  if (kind === "codex-app-server") {
    return "codex-cli";
  }
  return kind;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ProviderRunInput {
  readonly runId: string;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly resumeSessionId?: string;
  readonly executionProfile?: string;
  readonly tools?: Record<string, unknown>;
  readonly providerOptions?: Record<string, unknown>;
}

export interface TodoChunk {
  readonly todoId: string;
  readonly content: string;
  readonly status: "todo" | "doing" | "done" | "canceled";
  readonly order: number;
}

export type ProviderStreamChunk =
  | {
      readonly type: "message.delta";
      readonly text: string;
    }
  | {
      readonly type: "todo.update";
      readonly todo: TodoChunk;
    }
  | {
      readonly type: "run.finished";
      readonly status: "succeeded" | "failed" | "canceled";
      readonly reason?: string;
      readonly usage?: Record<string, unknown>;
    };

export interface ProviderRunHandle {
  stream(): AsyncIterable<ProviderStreamChunk>;
  stop(): Promise<void>;
}

export interface ProviderReplyInput {
  readonly runId: string;
  readonly questionId: string;
  readonly answer: string;
}

export interface AgentProviderAdapter {
  readonly kind: ProviderKind;
  readonly capabilities: {
    readonly resume: boolean;
    readonly humanLoop: boolean;
    readonly todoStream: boolean;
    readonly buildPlanMode: boolean;
  };
  run(input: ProviderRunInput): Promise<ProviderRunHandle>;
  reply?(input: ProviderReplyInput): Promise<void>;
}
