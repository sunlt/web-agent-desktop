export interface LogContext {
  readonly component?: string;
  readonly traceId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly executorId?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  child(context: LogContext): Logger;
  info(message: string, fields?: LogContext): void;
  warn(message: string, fields?: LogContext): void;
  error(message: string, fields?: LogContext): void;
}

export function createLogger(context: LogContext = {}): Logger {
  return {
    child(childContext: LogContext): Logger {
      return createLogger({
        ...context,
        ...compact(childContext),
      });
    },
    info(message: string, fields?: LogContext): void {
      writeLog("info", message, context, fields);
    },
    warn(message: string, fields?: LogContext): void {
      writeLog("warn", message, context, fields);
    },
    error(message: string, fields?: LogContext): void {
      writeLog("error", message, context, fields);
    },
  };
}

function writeLog(
  level: "info" | "warn" | "error",
  message: string,
  context: LogContext,
  fields?: LogContext,
): void {
  const record = {
    ts: new Date().toISOString(),
    level,
    message,
    ...compact(context),
    ...compact(fields),
  };

  const serialized = JSON.stringify(record);
  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}

function compact(input: LogContext | undefined): LogContext {
  if (!input) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
