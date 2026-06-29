import type { Logger, LogLevel } from "../../ports/services.js";

/** Structured console logger (JSON lines). The default when none is provided. */
export class ConsoleLogger implements Logger {
  constructor(private readonly minLevel: LogLevel = "info") {}

  private static readonly RANK: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };

  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (ConsoleLogger.RANK[level] < ConsoleLogger.RANK[this.minLevel]) return;
    const line = JSON.stringify({ level, message, ...fields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}

/** Drops everything. Useful in tests. */
export class NoopLogger implements Logger {
  log(): void {}
}
