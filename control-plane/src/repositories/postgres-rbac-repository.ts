import type { Pool } from "pg";
import type {
  FileAuditLogInput,
  RbacRepository,
  StoreAppView,
} from "./rbac-repository.js";

export class PostgresRbacRepository implements RbacRepository {
  constructor(private readonly pool: Pool) {}

  async listStoreAppsForUser(userId: string): Promise<readonly StoreAppView[]> {
    const [userResult, rolesResult, appResult, ruleResult, memberResult] =
      await Promise.all([
        this.pool.query<{
          user_id: string;
          department_id: string | null;
        }>(
          `
            SELECT user_id, department_id
            FROM users
            WHERE user_id = $1
          `,
          [userId],
        ),
        this.pool.query<{ role_key: string }>(
          `
            SELECT role_key
            FROM user_role_bindings
            WHERE user_id = $1
          `,
          [userId],
        ),
        this.pool.query<{
          app_id: string;
          name: string;
          enabled: boolean;
        }>(
          `
            SELECT app_id, name, enabled
            FROM apps
            ORDER BY name ASC
          `,
        ),
        this.pool.query<{
          app_id: string;
          scope_type: "all" | "department" | "user";
          scope_value: string | null;
        }>(
          `
            SELECT app_id, scope_type, scope_value
            FROM app_visibility_rules
          `,
        ),
        this.pool.query<{
          app_id: string;
          can_use: boolean;
        }>(
          `
            SELECT app_id, can_use
            FROM app_members
            WHERE user_id = $1
          `,
          [userId],
        ),
      ]);

    const user = userResult.rows[0] ?? null;
    const roles = new Set(rolesResult.rows.map((item) => item.role_key));
    const isPlatformAdmin = roles.has("platform_admin");

    const ruleByApp = new Map<
      string,
      Array<{ scopeType: "all" | "department" | "user"; scopeValue: string | null }>
    >();
    for (const rule of ruleResult.rows) {
      const list = ruleByApp.get(rule.app_id) ?? [];
      list.push({
        scopeType: rule.scope_type,
        scopeValue: rule.scope_value,
      });
      ruleByApp.set(rule.app_id, list);
    }

    const memberByApp = new Map<string, boolean>();
    for (const member of memberResult.rows) {
      memberByApp.set(member.app_id, member.can_use);
    }

    return appResult.rows.map((app) => {
      const rules = ruleByApp.get(app.app_id) ?? [];
      const canView =
        isPlatformAdmin ||
        rules.some((rule) => {
          if (rule.scopeType === "all") {
            return true;
          }
          if (rule.scopeType === "user") {
            return user ? rule.scopeValue === user.user_id : false;
          }
          return user ? rule.scopeValue === user.department_id : false;
        });
      const canUse =
        app.enabled &&
        canView &&
        (isPlatformAdmin || memberByApp.get(app.app_id) === true);

      return {
        appId: app.app_id,
        name: app.name,
        enabled: app.enabled,
        canView,
        canUse,
      };
    });
  }

  async canReadPath(userId: string, path: string): Promise<boolean> {
    const [rolesResult, policiesResult] = await Promise.all([
      this.pool.query<{ role_key: string }>(
        `
          SELECT role_key
          FROM user_role_bindings
          WHERE user_id = $1
        `,
        [userId],
      ),
      this.pool.query<{
        path_prefix: string;
        principal_type: "all" | "user" | "role";
        principal_id: string | null;
        can_read: boolean;
      }>(
        `
          SELECT path_prefix, principal_type, principal_id, can_read
          FROM file_acl_policies
          WHERE $2 LIKE (path_prefix || '%')
        `,
        [userId, normalizePath(path)],
      ),
    ]);

    const roles = new Set(rolesResult.rows.map((item) => item.role_key));
    if (roles.has("platform_admin")) {
      return true;
    }

    return policiesResult.rows.some((policy) => {
      if (!policy.can_read) {
        return false;
      }
      if (policy.principal_type === "all") {
        return true;
      }
      if (policy.principal_type === "user") {
        return policy.principal_id === userId;
      }
      return policy.principal_id ? roles.has(policy.principal_id) : false;
    });
  }

  async recordFileAudit(input: FileAuditLogInput): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO file_audit_logs (
          user_id,
          action,
          path,
          allowed,
          reason,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        input.userId,
        input.action,
        normalizePath(input.path),
        input.allowed,
        input.reason ?? null,
        input.ts,
      ],
    );
  }
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}
