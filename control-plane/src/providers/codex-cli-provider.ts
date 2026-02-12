import {
  createCodexAppServer,
  type CodexAppServerProviderSettings,
  type CodexAppServerSettings,
  type Session,
} from "ai-sdk-provider-codex-app-server";
import {
  asBoolean,
  asRecord,
  asString,
  asStringRecord,
  createStreamingRunHandle,
  withoutUndefined,
} from "./runtime-utils.js";
import type { AgentProviderAdapter, ProviderRunHandle, ProviderRunInput } from "./types.js";

type CodexConfigValue = string | number | boolean | object;

export class CodexCliProviderAdapter implements AgentProviderAdapter {
  readonly kind = "codex-cli" as const;
  private readonly sessionsByRunId = new Map<string, Session>();

  readonly capabilities = {
    resume: true,
    humanLoop: true,
    todoStream: true,
    buildPlanMode: false,
  };

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    const options = resolveCodexOptions(input.providerOptions);
    const modelSettings = withoutUndefined({
      resume: input.resumeSessionId ?? asString(options.resume),
      cwd: asString(options.cwd),
      approvalMode: asApprovalMode(options.approvalMode),
      sandboxMode: asSandboxMode(options.sandboxMode),
      reasoningEffort: asReasoningEffort(options.reasoningEffort),
      threadMode: asThreadMode(options.threadMode),
      mcpServers: asRecord(options.mcpServers) as CodexAppServerSettings["mcpServers"] | undefined,
      rmcpClient: asBoolean(options.rmcpClient),
      verbose: asBoolean(options.verbose),
      env: asStringRecord(options.env),
      baseInstructions:
        asString(options.baseInstructions) ?? asString(options.systemPrompt),
      configOverrides: asCodexConfigOverrides(options.configOverrides),
      onSessionCreated: (session: Session) => {
        this.sessionsByRunId.set(input.runId, session);
      },
    }) as CodexAppServerSettings;

    const providerSettings = {
      defaultSettings:
        Object.keys(modelSettings).length > 0 ? modelSettings : undefined,
    } as CodexAppServerProviderSettings;

    const provider = createCodexAppServer(providerSettings);
    const model = provider(input.model, modelSettings);
    const runHandle = createStreamingRunHandle({
      model,
      messages: input.messages,
    });
    const runId = input.runId;
    const sessionsByRunId = this.sessionsByRunId;

    return {
      stream: async function* () {
        try {
          for await (const chunk of runHandle.stream()) {
            yield chunk;
          }
        } finally {
          sessionsByRunId.delete(runId);
        }
      },
      stop: async () => {
        await runHandle.stop();
      },
    };
  }

  async reply(input: {
    runId: string;
    questionId: string;
    answer: string;
  }): Promise<void> {
    const session = this.sessionsByRunId.get(input.runId);
    if (!session) {
      throw new Error(`human-loop session not found for run ${input.runId}`);
    }

    await session.injectMessage([
      {
        type: "text",
        text: input.answer,
      },
    ]);
  }
}

function asCodexConfigOverrides(
  value: unknown,
): Record<string, CodexConfigValue> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const parsed: Record<string, CodexConfigValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean" ||
      (typeof item === "object" && item !== null)
    ) {
      parsed[key] = item;
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function resolveCodexOptions(value: unknown): Record<string, unknown> {
  const base = asRecord(value);
  return {
    ...base,
    ...asRecord(base["codex-cli"]),
    ...asRecord(base["codex-app-server"]),
  };
}

function asApprovalMode(
  value: unknown,
): CodexAppServerSettings["approvalMode"] | undefined {
  const parsed = asString(value);
  if (
    parsed === "never" ||
    parsed === "on-request" ||
    parsed === "on-failure" ||
    parsed === "untrusted"
  ) {
    return parsed;
  }
  return undefined;
}

function asSandboxMode(
  value: unknown,
): CodexAppServerSettings["sandboxMode"] | undefined {
  const parsed = asString(value);
  if (
    parsed === "read-only" ||
    parsed === "workspace-write" ||
    parsed === "danger-full-access" ||
    parsed === "full-access"
  ) {
    return parsed;
  }
  return undefined;
}

function asReasoningEffort(
  value: unknown,
): CodexAppServerSettings["reasoningEffort"] | undefined {
  const parsed = asString(value);
  if (
    parsed === "none" ||
    parsed === "low" ||
    parsed === "medium" ||
    parsed === "high" ||
    parsed === "xhigh"
  ) {
    return parsed;
  }
  return undefined;
}

function asThreadMode(
  value: unknown,
): CodexAppServerSettings["threadMode"] | undefined {
  const parsed = asString(value);
  if (parsed === "persistent" || parsed === "stateless") {
    return parsed;
  }
  return undefined;
}
