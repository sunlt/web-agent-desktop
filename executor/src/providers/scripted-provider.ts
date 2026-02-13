import type {
  AgentProviderAdapter,
  ProviderKind,
  ProviderReplyInput,
  ProviderRunHandle,
  ProviderRunInput,
  ProviderStreamChunk,
} from "./types.js";

const STREAM_STEP_DELAY_MS = 80;

interface ScriptedProviderOptions {
  readonly kind: ProviderKind;
  readonly humanLoop: boolean;
  readonly buildPlanMode: boolean;
}

export class ScriptedProviderAdapter implements AgentProviderAdapter {
  readonly kind: ProviderKind;
  readonly capabilities: AgentProviderAdapter["capabilities"];

  constructor(options: ScriptedProviderOptions) {
    this.kind = options.kind;
    this.capabilities = {
      resume: true,
      humanLoop: options.humanLoop,
      todoStream: true,
      buildPlanMode: options.buildPlanMode,
    };
  }

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    let stopped = false;
    const prompt = normalizePrompt(input.messages);
    const answer = buildAnswer(this.kind, prompt);
    const todoId = `todo-${input.runId}`;

    return {
      stream: async function* (): AsyncIterable<ProviderStreamChunk> {
        yield {
          type: "todo.update",
          todo: {
            todoId,
            content: "解析用户输入",
            status: "doing",
            order: 1,
          },
        };

        await delay(STREAM_STEP_DELAY_MS);
        if (stopped) {
          yield {
            type: "run.finished",
            status: "canceled",
          };
          return;
        }

        yield {
          type: "message.delta",
          text: answer,
        };

        await delay(STREAM_STEP_DELAY_MS);
        if (stopped) {
          yield {
            type: "run.finished",
            status: "canceled",
          };
          return;
        }

        yield {
          type: "todo.update",
          todo: {
            todoId,
            content: "输出最终答案",
            status: "done",
            order: 1,
          },
        };

        yield {
          type: "run.finished",
          status: "succeeded",
          usage: {
            inputTokens: Math.max(1, prompt.length),
            outputTokens: Math.max(1, answer.length),
          },
        };
      },
      stop: async () => {
        stopped = true;
      },
    };
  }

  async reply(_input: ProviderReplyInput): Promise<void> {
    return;
  }
}

export function createScriptedProviderAdapters(): AgentProviderAdapter[] {
  return [
    new ScriptedProviderAdapter({
      kind: "opencode",
      humanLoop: false,
      buildPlanMode: true,
    }),
    new ScriptedProviderAdapter({
      kind: "claude-code",
      humanLoop: false,
      buildPlanMode: false,
    }),
    new ScriptedProviderAdapter({
      kind: "codex-cli",
      humanLoop: true,
      buildPlanMode: false,
    }),
  ];
}

function normalizePrompt(messages: ProviderRunInput["messages"]): string {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  return latestUser?.content.trim() || "empty prompt";
}

function buildAnswer(kind: ProviderKind, prompt: string): string {
  const displayKind = kind === "codex-cli" ? "codex-app-server" : kind;
  return `[scripted:${displayKind}] ${prompt}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
