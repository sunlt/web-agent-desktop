import {
  createOpencode,
  type OpencodeProviderSettings,
  type OpencodeSettings,
} from "ai-sdk-provider-opencode-sdk";
import {
  asBoolean,
  asBooleanRecord,
  asNumber,
  asRecord,
  asString,
  createStreamingRunHandle,
  withoutUndefined,
} from "./runtime-utils.js";
import type {
  AgentProviderAdapter,
  ProviderRunHandle,
  ProviderRunInput,
  ProviderStreamChunk,
} from "./types.js";

export class OpencodeProviderAdapter implements AgentProviderAdapter {
  readonly kind = "opencode" as const;

  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: true,
    buildPlanMode: true,
  };

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    const options = asRecord(input.providerOptions);
    const toolSwitches = asBooleanRecord(options.tools) ?? asBooleanRecord(input.tools);
    const verbose = asBoolean(options.verbose);
    let observedSessionError = false;
    let lastProviderError: string | undefined;

    const recordProviderLog = (level: "warn" | "error" | "debug", message: string) => {
      const normalized = message.trim();
      if (normalized.length === 0) {
        return;
      }

      if (/session\.error/i.test(normalized)) {
        observedSessionError = true;
        if (!lastProviderError) {
          lastProviderError = normalized;
        }
      } else if (level !== "debug") {
        lastProviderError = normalized;
      }

      if (level !== "debug" || verbose) {
        const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.debug;
        writer(`[opencode-provider] ${normalized}`);
      }
    };

    const providerSettings = withoutUndefined({
      baseUrl: asString(options.baseUrl),
      hostname: asString(options.hostname),
      port: asNumber(options.port),
      autoStartServer: asBoolean(options.autoStartServer),
      serverTimeout: asNumber(options.serverTimeout),
    }) as OpencodeProviderSettings;

    const modelSettings = withoutUndefined({
      sessionId: input.resumeSessionId ?? asString(options.sessionId),
      createNewSession: asBoolean(options.createNewSession),
      sessionTitle: asString(options.sessionTitle),
      agent: asString(options.agent) ?? input.executionProfile,
      systemPrompt: asString(options.systemPrompt),
      tools: toolSwitches,
      cwd: asString(options.cwd),
      verbose,
      logger: {
        warn: (message: string) => {
          recordProviderLog("warn", message);
        },
        error: (message: string) => {
          recordProviderLog("error", message);
        },
        debug: (message: string) => {
          recordProviderLog("debug", message);
        },
      },
    }) as OpencodeSettings;

    const provider = createOpencode(providerSettings);
    const model = provider(
      input.model,
      Object.keys(modelSettings).length > 0 ? modelSettings : undefined,
    );

    const baseRunHandle = createStreamingRunHandle({
      model,
      messages: input.messages,
    });

    return {
      stream: async function* (): AsyncIterable<ProviderStreamChunk> {
        for await (const chunk of baseRunHandle.stream()) {
          if (
            chunk.type === "run.finished" &&
            chunk.status === "canceled" &&
            chunk.reason === "finish_reason:other" &&
            observedSessionError
          ) {
            const sessionErrorReason = lastProviderError
              ? `session.error:${lastProviderError}`
              : "session.error";
            yield {
              ...chunk,
              status: "failed",
              reason: sessionErrorReason,
            };
            continue;
          }

          yield chunk;
        }
      },
      stop: async () => {
        await baseRunHandle.stop();
      },
    };
  }
}
