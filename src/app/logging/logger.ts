import type { LogLevel } from '../configuration/index.js';
import { redact } from './redact.js';

/**
 * Minimal structured JSON logger.
 *
 * Framework-free by design: the domain and application layers must remain free
 * of driver dependencies, so ETBZ-9 ships a tiny logger instead of a transport
 * library. Sink and clock are injected, which makes every log assertion in the
 * test suite deterministic.
 */

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every subsequent record. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Receives one complete JSON line per record. Defaults to stdout. */
  readonly sink?: (line: string) => void;
  /** Returns the record timestamp. Defaults to wall clock in ISO-8601. */
  readonly clock?: () => string;
  readonly base?: LogFields;
}

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Keys owned by the log envelope; payload fields may not overwrite them. */
export const RESERVED_LOG_FIELDS: readonly string[] = ['ts', 'level', 'msg'];

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultClock(): string {
  return new Date().toISOString();
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? defaultSink;
  const clock = options.clock ?? defaultClock;
  const threshold = LEVEL_SEVERITY[options.level];
  const base = options.base ?? {};

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_SEVERITY[level] < threshold) {
      return;
    }
    const merged = redact({ ...base, ...(fields ?? {}) }) as Record<string, unknown>;
    for (const reserved of RESERVED_LOG_FIELDS) {
      delete merged[reserved];
    }
    const record = {
      ts: clock(),
      level,
      msg: redact(message),
      ...merged,
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: clock(), level, msg: message, logError: 'serialization_failed' });
    }
    sink(line);
  }

  const logger: Logger = {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) =>
      createLogger({
        level: options.level,
        sink,
        clock,
        base: { ...base, ...fields },
      }),
  };
  return logger;
}
