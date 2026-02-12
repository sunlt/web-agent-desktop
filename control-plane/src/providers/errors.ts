import type { ProviderKind } from "./types.js";

export class ProviderNotFoundError extends Error {
  constructor(provider: string) {
    super(`provider not found: ${provider}`);
    this.name = "ProviderNotFoundError";
  }
}

export class UnsupportedCapabilityError extends Error {
  readonly provider: ProviderKind;
  readonly capability: "resume" | "humanLoop";

  constructor(provider: ProviderKind, capability: "resume" | "humanLoop") {
    super(`provider ${provider} does not support capability: ${capability}`);
    this.name = "UnsupportedCapabilityError";
    this.provider = provider;
    this.capability = capability;
  }
}
