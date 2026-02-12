export interface StoreAppView {
  readonly appId: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly canView: boolean;
  readonly canUse: boolean;
}

export interface FileAuditLogInput {
  readonly userId: string;
  readonly action: "tree" | "download";
  readonly path: string;
  readonly allowed: boolean;
  readonly reason?: string;
  readonly ts: Date;
}

export interface RbacRepository {
  listStoreAppsForUser(userId: string): Promise<readonly StoreAppView[]>;
  canReadPath(userId: string, path: string): Promise<boolean>;
  recordFileAudit(input: FileAuditLogInput): Promise<void>;
}
