export type ProviderKind =
  | "claude-code"
  | "opencode"
  | "codex-cli"
  | "codex-app-server";

export type TimeoutMatchMode = "includes" | "exact" | "regex";

export interface ModelTimeoutRule {
  readonly pattern: string;
  readonly timeoutMs: number;
  readonly mode?: TimeoutMatchMode;
  readonly flags?: string;
}

export interface ProviderTimeoutProfile {
  readonly defaultTimeoutMs: number;
  readonly modelRules?: readonly ModelTimeoutRule[];
}

export type ProviderTimeoutTemplate = Partial<
  Record<ProviderKind, ProviderTimeoutProfile>
>;

export interface ResolveRunTimeoutInput {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly providerOptions?: Record<string, unknown>;
  readonly fallbackTimeoutMs: number;
  readonly template: ProviderTimeoutTemplate;
}

const PROVIDER_KINDS: readonly ProviderKind[] = [
  "claude-code",
  "opencode",
  "codex-cli",
  "codex-app-server",
];

const DEFAULT_TEMPLATE: ProviderTimeoutTemplate = {
  "codex-app-server": {
    defaultTimeoutMs: 240_000,
    modelRules: [
      { pattern: "gpt-5.1-codex-max", timeoutMs: 420_000, mode: "includes" },
      { pattern: "gpt-5.1-codex-mini", timeoutMs: 180_000, mode: "includes" },
      { pattern: "gpt-5.1-codex", timeoutMs: 300_000, mode: "includes" },
    ],
  },
  "codex-cli": {
    defaultTimeoutMs: 240_000,
    modelRules: [
      { pattern: "gpt-5.1-codex-max", timeoutMs: 420_000, mode: "includes" },
      { pattern: "gpt-5.1-codex-mini", timeoutMs: 180_000, mode: "includes" },
      { pattern: "gpt-5.1-codex", timeoutMs: 300_000, mode: "includes" },
    ],
  },
  "claude-code": {
    defaultTimeoutMs: 300_000,
    modelRules: [
      { pattern: "opus", timeoutMs: 420_000, mode: "includes" },
      { pattern: "sonnet", timeoutMs: 300_000, mode: "includes" },
      { pattern: "haiku", timeoutMs: 180_000, mode: "includes" },
    ],
  },
  opencode: {
    defaultTimeoutMs: 300_000,
    modelRules: [
      { pattern: "openai/gpt-5.1-codex-max", timeoutMs: 420_000, mode: "exact" },
      { pattern: "openai/gpt-5.1-codex", timeoutMs: 300_000, mode: "includes" },
      { pattern: "anthropic/claude-opus", timeoutMs: 420_000, mode: "includes" },
      { pattern: "anthropic/claude-sonnet", timeoutMs: 300_000, mode: "includes" },
    ],
  },
};

export function buildProviderTimeoutTemplate(
  rawTemplateJson: string | undefined,
): ProviderTimeoutTemplate {
  const parsed = parseTemplate(rawTemplateJson);
  const merged: ProviderTimeoutTemplate = {};
  for (const provider of PROVIDER_KINDS) {
    const defaults = DEFAULT_TEMPLATE[provider];
    const override = parsed[provider];
    if (!defaults && !override) {
      continue;
    }
    if (!defaults && override) {
      merged[provider] = override;
      continue;
    }
    if (!override && defaults) {
      merged[provider] = defaults;
      continue;
    }
    if (defaults && override) {
      merged[provider] = {
        defaultTimeoutMs: override.defaultTimeoutMs ?? defaults.defaultTimeoutMs,
        modelRules: override.modelRules ?? defaults.modelRules,
      };
    }
  }
  return merged;
}

export function resolveRunTimeoutMs(input: ResolveRunTimeoutInput): number {
  const explicitTimeoutMs = extractTimeoutOverride(input.providerOptions);
  if (explicitTimeoutMs) {
    return explicitTimeoutMs;
  }

  const profile = input.template[input.provider];
  if (profile) {
    for (const rule of profile.modelRules ?? []) {
      if (matchesModelRule(input.model, rule)) {
        const timeoutMs = normalizePositiveInteger(rule.timeoutMs);
        if (timeoutMs) {
          return timeoutMs;
        }
      }
    }
    const defaultTimeoutMs = normalizePositiveInteger(profile.defaultTimeoutMs);
    if (defaultTimeoutMs) {
      return defaultTimeoutMs;
    }
  }

  return normalizePositiveInteger(input.fallbackTimeoutMs) ?? 1_800_000;
}

function parseTemplate(rawTemplateJson: string | undefined): ProviderTimeoutTemplate {
  if (!rawTemplateJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawTemplateJson);
    if (!isRecord(parsed)) {
      return {};
    }

    const template: ProviderTimeoutTemplate = {};
    for (const provider of PROVIDER_KINDS) {
      const profile = parsed[provider];
      if (!isRecord(profile)) {
        continue;
      }
      const defaultTimeoutMs = normalizePositiveInteger(profile.defaultTimeoutMs);
      if (!defaultTimeoutMs) {
        continue;
      }
      const modelRules = parseModelRules(profile.modelRules);
      template[provider] = {
        defaultTimeoutMs,
        ...(modelRules.length > 0 ? { modelRules } : {}),
      };
    }

    return template;
  } catch {
    return {};
  }
}

function parseModelRules(value: unknown): ModelTimeoutRule[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rules: ModelTimeoutRule[] = [];
  for (const rule of value) {
    if (!isRecord(rule)) {
      continue;
    }

    const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
    const timeoutMs = normalizePositiveInteger(rule.timeoutMs);
    if (!pattern || !timeoutMs) {
      continue;
    }

    const mode = parseMode(rule.mode);
    const flags = typeof rule.flags === "string" ? rule.flags : undefined;

    rules.push({
      pattern,
      timeoutMs,
      ...(mode ? { mode } : {}),
      ...(flags ? { flags } : {}),
    });
  }
  return rules;
}

function parseMode(value: unknown): TimeoutMatchMode | undefined {
  if (value === "includes" || value === "exact" || value === "regex") {
    return value;
  }
  return undefined;
}

function matchesModelRule(model: string, rule: ModelTimeoutRule): boolean {
  const mode = rule.mode ?? "includes";
  if (mode === "exact") {
    return model.toLowerCase() === rule.pattern.toLowerCase();
  }
  if (mode === "regex") {
    try {
      const flags = sanitizeRegexFlags(rule.flags);
      return new RegExp(rule.pattern, flags).test(model);
    } catch {
      return false;
    }
  }
  return model.toLowerCase().includes(rule.pattern.toLowerCase());
}

function sanitizeRegexFlags(flags: string | undefined): string {
  if (!flags) {
    return "i";
  }
  return flags
    .split("")
    .filter((flag, index, source) =>
      (flag === "g" || flag === "i" || flag === "m" || flag === "s" || flag === "u" || flag === "y") &&
      source.indexOf(flag) === index,
    )
    .join("");
}

function extractTimeoutOverride(
  providerOptions: Record<string, unknown> | undefined,
): number | null {
  if (!providerOptions) {
    return null;
  }
  const timeoutMs = normalizePositiveInteger(providerOptions.timeoutMs);
  if (timeoutMs) {
    return timeoutMs;
  }
  return normalizePositiveInteger(providerOptions.runTimeoutMs) ?? null;
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
