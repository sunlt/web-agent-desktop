export type StoreAppProviderKind =
  | "claude-code"
  | "opencode"
  | "codex-cli"
  | "codex-app-server";

export interface StoreAppRuntimeDefaultsView {
  readonly provider: StoreAppProviderKind;
  readonly model: string;
  readonly timeoutMs: number | null;
  readonly credentialEnvKeys: readonly string[];
}

export interface StoreAppView {
  readonly appId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly canView: boolean;
  readonly canUse: boolean;
  readonly runtimeDefaults: StoreAppRuntimeDefaultsView | null;
}

export interface StoreAppRuntimeConfig {
  readonly appId: string;
  readonly provider: StoreAppProviderKind;
  readonly model: string;
  readonly timeoutMs: number | null;
  readonly credentialEnv: Record<string, string>;
  readonly providerOptions: Record<string, unknown>;
}

export interface RegisterStoreAppVisibilityRule {
  readonly scopeType: "all" | "department" | "user";
  readonly scopeValue?: string;
}

export interface RegisterStoreAppMember {
  readonly userId: string;
  readonly canUse: boolean;
}

export interface RegisterStoreAppRuntimeInput {
  readonly provider: StoreAppProviderKind;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly credentialEnv?: Record<string, string>;
  readonly providerOptions?: Record<string, unknown>;
}

export interface RegisterStoreAppInput {
  readonly appId: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly visibilityRules?: readonly RegisterStoreAppVisibilityRule[];
  readonly members?: readonly RegisterStoreAppMember[];
  readonly runtimeDefaults?: RegisterStoreAppRuntimeInput;
}

export interface FileAuditLogInput {
  readonly userId: string;
  readonly action:
    | "tree"
    | "download"
    | "read"
    | "write"
    | "upload"
    | "rename"
    | "delete"
    | "mkdir";
  readonly path: string;
  readonly allowed: boolean;
  readonly reason?: string;
  readonly ts: Date;
}

export interface RbacRepository {
  listStoreAppsForUser(userId: string): Promise<readonly StoreAppView[]>;
  upsertStoreApp(input: RegisterStoreAppInput): Promise<void>;
  getStoreAppRuntimeConfig(appId: string): Promise<StoreAppRuntimeConfig | null>;
  canReadPath(userId: string, path: string): Promise<boolean>;
  canWritePath(userId: string, path: string): Promise<boolean>;
  recordFileAudit(input: FileAuditLogInput): Promise<void>;
}
