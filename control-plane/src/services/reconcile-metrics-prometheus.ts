import type { ReconcileMetricsSnapshot } from "./reconciler.js";

const ALERT_TYPES = ["stale_runs", "stale_sync", "human_loop_timeout"] as const;
const ALERT_LEVELS = ["warn", "error"] as const;

type AlertType = (typeof ALERT_TYPES)[number];
type AlertLevel = (typeof ALERT_LEVELS)[number];

function toTimestampSeconds(value: string | null): number {
  if (!value) {
    return 0;
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    return 0;
  }
  return millis / 1_000;
}

function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(3);
}

function renderLabels(labels: Record<string, string>): string {
  const rendered = Object.entries(labels)
    .map(([key, value]) => {
      const safeValue = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `${key}="${safeValue}"`;
    })
    .join(",");
  return `{${rendered}}`;
}

function metric(
  name: string,
  help: string,
  type: "counter" | "gauge",
  value: number,
  labels?: Record<string, string>,
): string[] {
  const labelText = labels ? renderLabels(labels) : "";
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    `${name}${labelText} ${formatMetricValue(value)}`,
  ];
}

export function renderReconcileMetricsPrometheus(
  snapshot: ReconcileMetricsSnapshot,
): string {
  const lines: string[] = [];
  const alertCounts: Record<`${AlertType}:${AlertLevel}`, number> = {
    "stale_runs:warn": 0,
    "stale_runs:error": 0,
    "stale_sync:warn": 0,
    "stale_sync:error": 0,
    "human_loop_timeout:warn": 0,
    "human_loop_timeout:error": 0,
  };

  for (const alert of snapshot.alerts) {
    const key = `${alert.type}:${alert.level}` as `${AlertType}:${AlertLevel}`;
    if (Object.prototype.hasOwnProperty.call(alertCounts, key)) {
      alertCounts[key] += 1;
    }
  }

  lines.push(
    ...metric(
      "control_plane_reconcile_stale_runs_runs_total",
      "Total reconcile stale-runs executions.",
      "counter",
      snapshot.staleRuns.runs,
    ),
    ...metric(
      "control_plane_reconcile_stale_runs_processed_total",
      "Total stale runs inspected by reconcile.",
      "counter",
      snapshot.staleRuns.total,
    ),
    ...metric(
      "control_plane_reconcile_stale_runs_retried_total",
      "Total stale runs moved back to queue by reconcile.",
      "counter",
      snapshot.staleRuns.retried,
    ),
    ...metric(
      "control_plane_reconcile_stale_runs_failed_total",
      "Total stale runs marked failed by reconcile.",
      "counter",
      snapshot.staleRuns.failed,
    ),
    ...metric(
      "control_plane_reconcile_stale_runs_last_run_timestamp_seconds",
      "Unix timestamp for last stale-runs reconcile execution.",
      "gauge",
      toTimestampSeconds(snapshot.staleRuns.lastRunAt),
    ),
    ...metric(
      "control_plane_reconcile_stale_sync_runs_total",
      "Total reconcile stale-sync executions.",
      "counter",
      snapshot.staleSync.runs,
    ),
    ...metric(
      "control_plane_reconcile_stale_sync_processed_total",
      "Total stale sync workers inspected by reconcile.",
      "counter",
      snapshot.staleSync.total,
    ),
    ...metric(
      "control_plane_reconcile_stale_sync_succeeded_total",
      "Total stale sync workers successfully reconciled.",
      "counter",
      snapshot.staleSync.succeeded,
    ),
    ...metric(
      "control_plane_reconcile_stale_sync_skipped_total",
      "Total stale sync workers skipped during reconcile.",
      "counter",
      snapshot.staleSync.skipped,
    ),
    ...metric(
      "control_plane_reconcile_stale_sync_failed_total",
      "Total stale sync workers failed during reconcile.",
      "counter",
      snapshot.staleSync.failed,
    ),
    ...metric(
      "control_plane_reconcile_stale_sync_last_run_timestamp_seconds",
      "Unix timestamp for last stale-sync reconcile execution.",
      "gauge",
      toTimestampSeconds(snapshot.staleSync.lastRunAt),
    ),
    ...metric(
      "control_plane_reconcile_human_loop_timeout_runs_total",
      "Total human-loop-timeout reconcile executions.",
      "counter",
      snapshot.humanLoopTimeout.runs,
    ),
    ...metric(
      "control_plane_reconcile_human_loop_pending_total",
      "Total pending human-loop requests scanned by reconcile timeout checks.",
      "counter",
      snapshot.humanLoopTimeout.pending,
    ),
    ...metric(
      "control_plane_reconcile_human_loop_expired_total",
      "Total human-loop requests expired by timeout reconcile.",
      "counter",
      snapshot.humanLoopTimeout.expired,
    ),
    ...metric(
      "control_plane_reconcile_human_loop_failed_runs_total",
      "Total runs marked failed due to human-loop timeout expiration.",
      "counter",
      snapshot.humanLoopTimeout.failedRuns,
    ),
    ...metric(
      "control_plane_reconcile_human_loop_last_run_timestamp_seconds",
      "Unix timestamp for last human-loop-timeout reconcile execution.",
      "gauge",
      toTimestampSeconds(snapshot.humanLoopTimeout.lastRunAt),
    ),
  );

  for (const type of ALERT_TYPES) {
    for (const level of ALERT_LEVELS) {
      const key = `${type}:${level}` as `${AlertType}:${AlertLevel}`;
      lines.push(
        ...metric(
          "control_plane_reconcile_alerts_total",
          "Recent reconcile alerts grouped by alert type and level.",
          "gauge",
          alertCounts[key],
          { type, level },
        ),
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
