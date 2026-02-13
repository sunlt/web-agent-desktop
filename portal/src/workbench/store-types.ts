import type { ProviderKind } from "./transport";

export interface StoreRuntimeDefaults {
  provider: ProviderKind;
  model: string;
  timeoutMs: number | null;
  credentialEnvKeys: string[];
}

export interface StoreAppItem {
  appId: string;
  name: string;
  enabled: boolean;
  canView: boolean;
  canUse: boolean;
  runtimeDefaults: StoreRuntimeDefaults | null;
}
