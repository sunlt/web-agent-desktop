import type {
  FileAuditLogInput,
  RbacRepository,
  StoreAppView,
} from "./rbac-repository.js";

type VisibilityScope = "all" | "department" | "user";
type PrincipalType = "all" | "user" | "role";

interface UserRecord {
  userId: string;
  departmentId?: string;
}

interface AppRecord {
  appId: string;
  name: string;
  enabled: boolean;
}

interface VisibilityRule {
  appId: string;
  scope: VisibilityScope;
  value?: string;
}

interface AppMember {
  appId: string;
  userId: string;
  canUse: boolean;
}

interface FileAclPolicy {
  pathPrefix: string;
  principalType: PrincipalType;
  principalId?: string;
  canRead: boolean;
  canWrite: boolean;
}

export class InMemoryRbacRepository implements RbacRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly userRoles = new Map<string, Set<string>>();
  private readonly apps = new Map<string, AppRecord>();
  private readonly visibilityRules: VisibilityRule[] = [];
  private readonly appMembers: AppMember[] = [];
  private readonly filePolicies: FileAclPolicy[] = [];
  private readonly auditLogs: FileAuditLogInput[] = [];

  addUser(input: { userId: string; departmentId?: string }): void {
    this.users.set(input.userId, {
      userId: input.userId,
      departmentId: input.departmentId,
    });
  }

  bindUserRole(input: { userId: string; roleKey: string }): void {
    const set = this.userRoles.get(input.userId) ?? new Set<string>();
    set.add(input.roleKey);
    this.userRoles.set(input.userId, set);
  }

  addApp(input: { appId: string; name: string; enabled?: boolean }): void {
    this.apps.set(input.appId, {
      appId: input.appId,
      name: input.name,
      enabled: input.enabled ?? true,
    });
  }

  addVisibilityRule(input: {
    appId: string;
    scope: VisibilityScope;
    value?: string;
  }): void {
    this.visibilityRules.push({
      appId: input.appId,
      scope: input.scope,
      value: input.value,
    });
  }

  addAppMember(input: { appId: string; userId: string; canUse: boolean }): void {
    this.appMembers.push({
      appId: input.appId,
      userId: input.userId,
      canUse: input.canUse,
    });
  }

  addFilePolicy(input: {
    pathPrefix: string;
    principalType: PrincipalType;
    principalId?: string;
    canRead: boolean;
    canWrite?: boolean;
  }): void {
    this.filePolicies.push({
      pathPrefix: normalizePathPrefix(input.pathPrefix),
      principalType: input.principalType,
      principalId: input.principalId,
      canRead: input.canRead,
      canWrite: input.canWrite ?? false,
    });
  }

  getAuditLogs(): readonly FileAuditLogInput[] {
    return this.auditLogs.slice();
  }

  async listStoreAppsForUser(userId: string): Promise<readonly StoreAppView[]> {
    const user = this.users.get(userId);
    const roles = this.userRoles.get(userId) ?? new Set<string>();
    const isPlatformAdmin = roles.has("platform_admin");

    return [...this.apps.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((app) => {
        const rules = this.visibilityRules.filter((item) => item.appId === app.appId);
        const canView = isPlatformAdmin || this.canViewApp(user, app.appId, rules);
        const canUse =
          app.enabled &&
          canView &&
          (isPlatformAdmin ||
            this.appMembers.some(
              (item) => item.appId === app.appId && item.userId === userId && item.canUse,
            ));

        return {
          appId: app.appId,
          name: app.name,
          enabled: app.enabled,
          canView,
          canUse,
        };
      });
  }

  async canReadPath(userId: string, path: string): Promise<boolean> {
    return this.canAccessPath({
      userId,
      path,
      access: "read",
    });
  }

  async canWritePath(userId: string, path: string): Promise<boolean> {
    return this.canAccessPath({
      userId,
      path,
      access: "write",
    });
  }

  async recordFileAudit(input: FileAuditLogInput): Promise<void> {
    this.auditLogs.push({ ...input });
  }

  private canAccessPath(input: {
    userId: string;
    path: string;
    access: "read" | "write";
  }): boolean {
    const { userId, path, access } = input;
    const normalized = normalizePathPrefix(path);
    const roles = this.userRoles.get(userId) ?? new Set<string>();
    if (roles.has("platform_admin")) {
      return true;
    }

    return this.filePolicies.some((policy) => {
      const allowedByPolicy = access === "read" ? policy.canRead : policy.canWrite;
      if (!allowedByPolicy) {
        return false;
      }

      if (!normalized.startsWith(policy.pathPrefix)) {
        return false;
      }

      if (policy.principalType === "all") {
        return true;
      }

      if (policy.principalType === "user") {
        return policy.principalId === userId;
      }

      return policy.principalId ? roles.has(policy.principalId) : false;
    });
  }

  private canViewApp(
    user: UserRecord | undefined,
    appId: string,
    rules: VisibilityRule[],
  ): boolean {
    if (rules.length === 0) {
      return false;
    }

    return rules.some((rule) => {
      if (rule.scope === "all") {
        return true;
      }

      if (rule.scope === "user") {
        return user ? rule.value === user.userId : false;
      }

      return user ? rule.value === user.departmentId : false;
    });
  }
}

function normalizePathPrefix(input: string): string {
  if (!input.startsWith("/")) {
    return `/${input}`;
  }
  return input;
}
