export type ProviderKind = "claude-code" | "opencode" | "codex-cli";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ProviderRunInput {
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
      readonly usage?: Record<string, unknown>;
    };

export interface ProviderRunHandle {
  stream(): AsyncIterable<ProviderStreamChunk>;
  stop(): Promise<void>;
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
}
