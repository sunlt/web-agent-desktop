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
import type { AgentProviderAdapter, ProviderRunHandle, ProviderRunInput } from "./types.js";

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
      verbose: asBoolean(options.verbose),
    }) as OpencodeSettings;

    const provider = createOpencode(providerSettings);
    const model = provider(
      input.model,
      Object.keys(modelSettings).length > 0 ? modelSettings : undefined,
    );

    return createStreamingRunHandle({
      model,
      messages: input.messages,
    });
  }
}
