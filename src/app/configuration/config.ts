import { z } from 'zod';

/**
 * ETBZ-9 configuration boundary.
 *
 * Design rules enforced here:
 *  - the loader is a PURE function over an explicitly supplied environment
 *    record; it never reads `process.env` itself and never touches the host
 *    filesystem (no `/root/.env`, no dotenv, no implicit config discovery);
 *  - only variables declared in `CONFIG_VARIABLES` are read, so an unknown
 *    variable can never mutate `EtbzConfig`;
 *  - validation failures are reported as {variable, code, expectation} using
 *    STATIC text only. Received values never leave this module, which is why
 *    Zod's own issue messages are deliberately discarded (they embed the
 *    received value) and re-derived from the declaration table below.
 */

export type EnvironmentRecord = Readonly<Record<string, string | undefined>>;

export const ETBZ_ENVIRONMENTS = [
  'local',
  'development',
  'test',
  'staging',
  'production',
] as const;

export type EtbzEnvironment = (typeof ETBZ_ENVIRONMENTS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Fallback port. `ETBZ_ENV` deliberately has no fallback of any kind. */
export const DEFAULT_ETBZ_PORT = 8120;

/** Log level used only for bootstrap logging while configuration is invalid. */
export const BOOTSTRAP_LOG_LEVEL: LogLevel = 'info';

export interface EtbzConfig {
  readonly env: EtbzEnvironment;
  readonly port: number;
  readonly logLevel: LogLevel;
}

export type ConfigIssueCode = 'missing' | 'invalid';

export interface ConfigIssue {
  /** Name of the environment variable. Never its value. */
  readonly variable: string;
  readonly code: ConfigIssueCode;
  /** Static, value-free description of what was expected. */
  readonly expectation: string;
}

export type ConfigLoadResult =
  | { readonly ok: true; readonly config: EtbzConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

interface ConfigVariableDeclaration {
  readonly variable: string;
  readonly required: boolean;
  /** Static expectation text. Must not contain any received value. */
  readonly expectation: string;
}

/**
 * The single source of truth for which environment variables ETBZ-9 reads.
 * Adding a name here is the only way to widen the configuration surface.
 */
export const CONFIG_VARIABLES = {
  env: {
    variable: 'ETBZ_ENV',
    required: true,
    expectation: `one of: ${ETBZ_ENVIRONMENTS.join(' | ')}`,
  },
  port: {
    variable: 'ETBZ_PORT',
    required: false,
    expectation: `integer TCP port between 1 and 65535 (default ${DEFAULT_ETBZ_PORT})`,
  },
  logLevel: {
    variable: 'LOG_LEVEL',
    required: true,
    expectation: `one of: ${LOG_LEVELS.join(' | ')}`,
  },
} as const satisfies Record<keyof EtbzConfig, ConfigVariableDeclaration>;

/** Environment variable names ETBZ-9 actually consumes. */
export const CONFIG_VARIABLE_NAMES: readonly string[] = Object.values(
  CONFIG_VARIABLES,
).map((declaration) => declaration.variable);

const configSchema = z.object({
  env: z.enum(ETBZ_ENVIRONMENTS),
  port: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform((raw) => Number.parseInt(raw, 10))
    .refine((value) => value >= 1 && value <= 65535),
  logLevel: z.enum(LOG_LEVELS),
});

/**
 * Treats blank / whitespace-only values as absent. `ETBZ_ENV=` must fail closed
 * exactly like an unset `ETBZ_ENV`.
 */
function readPresentValue(
  environment: EnvironmentRecord,
  variable: string,
): string | undefined {
  const raw = environment[variable];
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function issueFor(
  declaration: ConfigVariableDeclaration,
  code: ConfigIssueCode,
): ConfigIssue {
  return {
    variable: declaration.variable,
    code,
    expectation: declaration.expectation,
  };
}

/**
 * Loads the ETBZ-9 configuration from an explicitly supplied environment
 * record. Fail-closed: any missing mandatory or malformed variable yields
 * `{ok: false}` with value-free issues.
 */
export function loadEtbzConfig(environment: EnvironmentRecord): ConfigLoadResult {
  const envValue = readPresentValue(environment, CONFIG_VARIABLES.env.variable);
  const portValue = readPresentValue(environment, CONFIG_VARIABLES.port.variable);
  const logLevelValue = readPresentValue(
    environment,
    CONFIG_VARIABLES.logLevel.variable,
  );

  const missingIssues: ConfigIssue[] = [];
  if (envValue === undefined) {
    missingIssues.push(issueFor(CONFIG_VARIABLES.env, 'missing'));
  }
  if (logLevelValue === undefined) {
    missingIssues.push(issueFor(CONFIG_VARIABLES.logLevel, 'missing'));
  }
  if (missingIssues.length > 0) {
    return { ok: false, issues: Object.freeze(missingIssues) };
  }

  const parsed = configSchema.safeParse({
    env: envValue,
    port: portValue ?? String(DEFAULT_ETBZ_PORT),
    logLevel: logLevelValue,
  });

  if (!parsed.success) {
    // Zod issue messages embed the received value; only the path is used.
    const invalidIssues = parsed.error.issues.map((issue) => {
      const field = issue.path[0];
      const declaration =
        typeof field === 'string' && field in CONFIG_VARIABLES
          ? CONFIG_VARIABLES[field as keyof typeof CONFIG_VARIABLES]
          : undefined;
      return declaration === undefined
        ? { variable: 'ETBZ_CONFIG', code: 'invalid' as const, expectation: 'a valid ETBZ configuration' }
        : issueFor(declaration, 'invalid');
    });
    return { ok: false, issues: Object.freeze(dedupeIssues(invalidIssues)) };
  }

  return {
    ok: true,
    config: Object.freeze({
      env: parsed.data.env,
      port: parsed.data.port,
      logLevel: parsed.data.logLevel,
    }),
  };
}

function dedupeIssues(issues: readonly ConfigIssue[]): ConfigIssue[] {
  const seen = new Set<string>();
  const result: ConfigIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.variable}:${issue.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(issue);
    }
  }
  return result;
}

/**
 * Port used to bind the HTTP listener during bootstrap.
 *
 * Liveness must stay observable even while configuration is invalid, so port
 * resolution is fail-open (defaulting) while READINESS stays fail-closed. A
 * malformed `ETBZ_PORT` still fails readiness via `loadEtbzConfig`.
 */
export function resolveBootstrapPort(environment: EnvironmentRecord): number {
  const raw = readPresentValue(environment, CONFIG_VARIABLES.port.variable);
  if (raw === undefined || !/^\d{1,5}$/.test(raw)) {
    return DEFAULT_ETBZ_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  return parsed >= 1 && parsed <= 65535 ? parsed : DEFAULT_ETBZ_PORT;
}

/** Log level used for bootstrap logging; never fails the process. */
export function resolveBootstrapLogLevel(environment: EnvironmentRecord): LogLevel {
  const raw = readPresentValue(environment, CONFIG_VARIABLES.logLevel.variable);
  return raw !== undefined && (LOG_LEVELS as readonly string[]).includes(raw)
    ? (raw as LogLevel)
    : BOOTSTRAP_LOG_LEVEL;
}
