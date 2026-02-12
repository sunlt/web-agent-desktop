import {
  createClaudeCode,
  type ClaudeCodeProviderSettings,
  type ClaudeCodeSettings,
} from "ai-sdk-provider-claude-code";
import {
  asBoolean,
  asBooleanRecord,
  asInteger,
  asRecord,
  asString,
  asStringArray,
  asStringRecord,
  createStreamingRunHandle,
  withoutUndefined,
} from "./runtime-utils.js";
import type { AgentProviderAdapter, ProviderRunHandle, ProviderRunInput } from "./types.js";

type ClaudeSettingSource = "user" | "project" | "local";

const CLAUDE_SETTING_SOURCES = new Set<ClaudeSettingSource>([
  "user",
  "project",
  "local",
]);

export class ClaudeCodeProviderAdapter implements AgentProviderAdapter {
  readonly kind = "claude-code" as const;

  readonly capabilities = {
    resume: true,
    humanLoop: false,
    todoStream: true,
    buildPlanMode: false,
  };

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    const options = asRecord(input.providerOptions);
    const toolSwitches = asBooleanRecord(input.tools);

    const allowedTools =
      asStringArray(options.allowedTools) ??
      (toolSwitches
        ? Object.entries(toolSwitches)
            .filter(([, enabled]) => enabled)
            .map(([name]) => name)
        : undefined);

    const disallowedTools =
      asStringArray(options.disallowedTools) ??
      (toolSwitches
        ? Object.entries(toolSwitches)
            .filter(([, enabled]) => !enabled)
            .map(([name]) => name)
        : undefined);

    const settingSources = asStringArray(options.settingSources)?.filter(
      (item): item is ClaudeSettingSource => CLAUDE_SETTING_SOURCES.has(item as ClaudeSettingSource),
    );

    const modelSettings = withoutUndefined({
      resume: input.resumeSessionId ?? asString(options.resume),
      sessionId: asString(options.sessionId),
      continue: asBoolean(options.continue),
      cwd: asString(options.cwd),
      permissionMode: asString(options.permissionMode) as ClaudeCodeSettings["permissionMode"] | undefined,
      allowedTools,
      disallowedTools,
      settingSources,
      systemPrompt: asString(options.systemPrompt),
      customSystemPrompt: asString(options.customSystemPrompt),
      appendSystemPrompt: asString(options.appendSystemPrompt),
      maxTurns: asInteger(options.maxTurns),
      maxThinkingTokens: asInteger(options.maxThinkingTokens),
      verbose: asBoolean(options.verbose),
      debug: asBoolean(options.debug),
      debugFile: asString(options.debugFile),
      env: asStringRecord(options.env),
      additionalDirectories: asStringArray(options.additionalDirectories),
      persistSession: asBoolean(options.persistSession),
      forkSession: asBoolean(options.forkSession),
      includePartialMessages: asBoolean(options.includePartialMessages),
    }) as ClaudeCodeSettings;

    const providerSettings = {
      defaultSettings:
        Object.keys(modelSettings).length > 0 ? modelSettings : undefined,
    } as ClaudeCodeProviderSettings;

    const provider = createClaudeCode(providerSettings);
    const model = provider(input.model, modelSettings);

    return createStreamingRunHandle({
      model,
      messages: input.messages,
    });
  }
}
