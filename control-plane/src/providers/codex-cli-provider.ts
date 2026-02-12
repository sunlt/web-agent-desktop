import {
  createCodexCli,
  type CodexCliProviderSettings,
  type CodexCliSettings,
} from "ai-sdk-provider-codex-cli";
import {
  asBoolean,
  asRecord,
  asString,
  asStringArray,
  asStringRecord,
  createStreamingRunHandle,
  withoutUndefined,
} from "./runtime-utils.js";
import type { AgentProviderAdapter, ProviderRunHandle, ProviderRunInput } from "./types.js";

type CodexConfigValue = string | number | boolean | object;

export class CodexCliProviderAdapter implements AgentProviderAdapter {
  readonly kind = "codex-cli" as const;

  readonly capabilities = {
    resume: false,
    humanLoop: false,
    todoStream: true,
    buildPlanMode: false,
  };

  async run(input: ProviderRunInput): Promise<ProviderRunHandle> {
    const options = asRecord(input.providerOptions);
    const modelSettings = withoutUndefined({
      cwd: asString(options.cwd),
      addDirs: asStringArray(options.addDirs),
      approvalMode: asString(options.approvalMode) as CodexCliSettings["approvalMode"] | undefined,
      sandboxMode: asString(options.sandboxMode) as CodexCliSettings["sandboxMode"] | undefined,
      fullAuto: asBoolean(options.fullAuto),
      dangerouslyBypassApprovalsAndSandbox: asBoolean(
        options.dangerouslyBypassApprovalsAndSandbox,
      ),
      skipGitRepoCheck: asBoolean(options.skipGitRepoCheck),
      color: asString(options.color) as CodexCliSettings["color"] | undefined,
      allowNpx: asBoolean(options.allowNpx),
      outputLastMessageFile: asString(options.outputLastMessageFile),
      env: asStringRecord(options.env),
      verbose: asBoolean(options.verbose),
      reasoningEffort: asString(options.reasoningEffort) as CodexCliSettings["reasoningEffort"] | undefined,
      reasoningSummary: asString(options.reasoningSummary) as CodexCliSettings["reasoningSummary"] | undefined,
      reasoningSummaryFormat: asString(options.reasoningSummaryFormat) as CodexCliSettings["reasoningSummaryFormat"] | undefined,
      modelVerbosity: asString(options.modelVerbosity) as CodexCliSettings["modelVerbosity"] | undefined,
      mcpServers: asRecord(options.mcpServers) as CodexCliSettings["mcpServers"] | undefined,
      rmcpClient: asBoolean(options.rmcpClient),
      profile: asString(options.profile) ?? input.executionProfile,
      oss: asBoolean(options.oss),
      webSearch: asBoolean(options.webSearch),
      configOverrides: asCodexConfigOverrides(options.configOverrides),
    }) as CodexCliSettings;

    const providerSettings = {
      defaultSettings:
        Object.keys(modelSettings).length > 0 ? modelSettings : undefined,
    } as CodexCliProviderSettings;

    const provider = createCodexCli(providerSettings);
    const model = provider(input.model, modelSettings);

    return createStreamingRunHandle({
      model,
      messages: input.messages,
    });
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
