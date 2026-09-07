/**
 * ETBZ-2 / ETBZ-24 — the REAL FuFirE boundary client (HTTP).
 *
 * Rules enforced here:
 *  - the URL is SERVER-OWNED: built from an injected base URL + the pinned
 *    operation path. Callers can never redirect the request;
 *  - the API key is SERVER-OWNED: injected once at composition time, sent as
 *    the `X-API-Key` header, never accepted from user input, never logged;
 *  - NO substitution, NO fallback calculator: every failure is an explicit
 *    error and propagates fail-closed;
 *  - every response is validated against the pinned live contract before it
 *    leaves this module (schema drift -> FufireContractError).
 */

import type {
  FufireBaziGateway,
  FufireBaziSnapshot,
  FufirePillarFact,
  WuxingSnapshot,
} from '../../application/ports/fufire-gateway.js';
import { WUXING_ELEMENTS } from '../../application/ports/fufire-gateway.js';
import type { NormalizedBirthInput } from '../../domain/birth-input.js';

export const FUFIRE_BAZI_PATH = '/v1/calculate/bazi';
export const FUFIRE_WUXING_PATH = '/v1/calculate/bazi/wuxing';

export interface FufireClientConfig {
  /** e.g. `http://127.0.0.1:8110` — no trailing slash. Server-owned. */
  readonly baseUrl: string;
  /** Server-owned credential. Never logged, never echoed, never user input. */
  readonly apiKey: string;
  /** Request timeout in ms. */
  readonly timeoutMs: number;
  /** Immutable runtime identifier recorded into every snapshot. */
  readonly runtimeImage: string;
  /** SHA-256 of the live OpenAPI document recorded into every snapshot. */
  readonly openapiSha256: string;
}

export type FufireErrorCode =
  | 'FUFIRE_AUTH_FAILED'
  | 'FUFIRE_TIMEOUT'
  | 'FUFIRE_SERVER_ERROR'
  | 'FUFIRE_CONTRACT_ERROR'
  | 'FUFIRE_REJECTED'
  | 'FUFIRE_NETWORK_ERROR';

export class FufireError extends Error {
  readonly code: FufireErrorCode;
  /** HTTP status when the failure came from a completed response. */
  readonly status: number | undefined;
  /** FuFirE machine error code (e.g. `dst_time_error`), when present. */
  readonly detailCode: string | undefined;

  constructor(code: FufireErrorCode, message: string, status?: number, detailCode?: string) {
    super(message);
    this.name = 'FufireError';
    this.code = code;
    this.status = status;
    this.detailCode = detailCode;
  }
}

interface Transport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

interface FufireErrorBody {
  readonly error?: unknown;
  readonly message?: unknown;
  readonly status?: unknown;
}

async function parseErrorBody(response: Response): Promise<FufireErrorBody> {
  try {
    const raw: unknown = await response.json();
    if (typeof raw === 'object' && raw !== null) {
      return raw;
    }
  } catch {
    // body is not JSON — fall through with empty detail
  }
  return {};
}

function detailCodeOf(body: FufireErrorBody): string | undefined {
  return typeof body.error === 'string' ? body.error : undefined;
}

function buildRequest(input: NormalizedBirthInput): Record<string, unknown> {
  // BaziRequest: `date` is local ISO8601; when the birth time is unknown the
  // time is OMITTED and `birth_time_known: false` is sent. ETBZ never sends a
  // substituted time.
  const payload: Record<string, unknown> = {
    date: input.birthTimeKnown ? `${input.birthDate}T${input.birthTime}` : input.birthDate,
    tz: input.timezone,
    lat: input.location.lat,
    lon: input.location.lon,
    standard: 'CIVIL',
    birth_time_known: input.birthTimeKnown,
  };
  return payload;
}

async function postJson(
  config: FufireClientConfig,
  transport: Transport,
  path: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const url = `${config.baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await transport.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config.apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new FufireError('FUFIRE_TIMEOUT', `FuFirE request timed out after ${config.timeoutMs}ms`);
    }
    const reason = error instanceof Error ? error.message : 'unknown network failure';
    throw new FufireError('FUFIRE_NETWORK_ERROR', `FuFirE request failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new FufireError('FUFIRE_AUTH_FAILED', 'FuFirE rejected the credentials', response.status);
  }
  if (response.status >= 500) {
    throw new FufireError('FUFIRE_SERVER_ERROR', `FuFirE server error (HTTP ${response.status})`, response.status);
  }
  if (response.status === 422) {
    const body = await parseErrorBody(response);
    throw new FufireError(
      'FUFIRE_REJECTED',
      'FuFirE rejected the calculation request',
      response.status,
      detailCodeOf(body),
    );
  }
  if (response.status !== 200) {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', `unexpected FuFirE HTTP status ${response.status}`, response.status);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', 'FuFirE response is not valid JSON', response.status);
  }
  return raw;
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', `FuFirE response field ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', `FuFirE response field ${what} is not a non-empty string`);
  }
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', `FuFirE response field ${what} is not a finite number`);
  }
  return value;
}

const PILLAR_NAMES = ['year', 'month', 'day', 'hour'] as const;

function mapPillars(raw: unknown): FufireBaziSnapshot['pillars'] {
  const pillars = asObject(raw, 'pillars');
  const mapped = {} as Record<(typeof PILLAR_NAMES)[number], FufirePillarFact>;
  for (const name of PILLAR_NAMES) {
    const pillar = asObject(pillars[name], `pillars.${name}`);
    mapped[name] = {
      stem: asString(pillar['stamm'], `pillars.${name}.stamm`),
      branch: asString(pillar['zweig'], `pillars.${name}.zweig`),
      tierDe: asString(pillar['tier'], `pillars.${name}.tier`),
      elementDe: asString(pillar['element'], `pillars.${name}.element`),
    };
  }
  return mapped;
}

function mapBaziSnapshot(raw: unknown): FufireBaziSnapshot {
  const body = asObject(raw, 'response');
  const pillars = mapPillars(body['pillars']);
  const chinese = asObject(body['chinese'], 'chinese');
  const dates = asObject(body['dates'], 'dates');
  const precision = asObject(body['precision'], 'precision');
  const provenance = asObject(body['provenance'], 'provenance');
  const provisional = precision['provisional_fields'];
  if (!Array.isArray(provisional) || !provisional.every((entry) => typeof entry === 'string')) {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', 'precision.provisional_fields is not a string array');
  }
  const birthTimeKnown = precision['birth_time_known'];
  if (typeof birthTimeKnown !== 'boolean') {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', 'precision.birth_time_known is not a boolean');
  }
  const dayMaster = asString(chinese['day_master'], 'chinese.day_master');
  if (dayMaster !== pillars.day.stem) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `chinese.day_master (${dayMaster}) contradicts pillars.day.stem (${pillars.day.stem})`,
    );
  }
  // The runtime pin (runtimeImage/openapiSha256) is injected by the caller
  // (product pipeline) — the wire mapping stays transport-only.
  return {
    pillars,
    dayMaster,
    dates: {
      birthLocal: asString(dates['birth_local'], 'dates.birth_local'),
      birthUtc: asString(dates['birth_utc'], 'dates.birth_utc'),
      lichunLocal: asString(dates['lichun_local'], 'dates.lichun_local'),
    },
    precision: {
      birthTimeKnown,
      provisionalFields: provisional,
    },
    provenance: {
      engineVersion: asString(provenance['engine_version'], 'provenance.engine_version'),
      rulesetId: asString(provenance['ruleset_id'], 'provenance.ruleset_id'),
      ephemerisId: asString(provenance['ephemeris_id'], 'provenance.ephemeris_id'),
      tzdbVersionId: asString(provenance['tzdb_version_id'], 'provenance.tzdb_version_id'),
      computationTimestamp: asString(provenance['computation_timestamp'], 'provenance.computation_timestamp'),
    },
  };
}

function mapWuxingSnapshot(raw: unknown): WuxingSnapshot {
  const body = asObject(raw, 'response');
  const vectorRaw = asObject(body['wu_xing_vector'], 'wu_xing_vector');
  const vector = {} as Record<(typeof WUXING_ELEMENTS)[number], number>;
  for (const element of WUXING_ELEMENTS) {
    vector[element] = asNumber(vectorRaw[element], `wu_xing_vector.${element}`);
  }
  const dominant = asString(body['dominant_element'], 'dominant_element');
  if (!(dominant in vector)) {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', `dominant_element ${dominant} is not a wu-xing element`);
  }
  return {
    vector,
    dominant,
    basis: asString(body['basis'], 'basis'),
  };
}

export interface FufireClientDependencies {
  readonly config: FufireClientConfig;
  /** Injectable for tests; production uses the global fetch. */
  readonly transport?: Transport;
}

export function createFufireClient(dependencies: FufireClientDependencies): FufireBaziGateway {
  const config = dependencies.config;
  const transport: Transport = dependencies.transport ?? { fetch: (url, init) => fetch(url, init) };

  return {
    async calculateBazi(input: NormalizedBirthInput): Promise<FufireBaziSnapshot> {
      const raw = await postJson(config, transport, FUFIRE_BAZI_PATH, buildRequest(input));
      return mapBaziSnapshot(raw);
    },
    async calculateBaziWuxing(input: NormalizedBirthInput): Promise<WuxingSnapshot> {
      const raw = await postJson(config, transport, FUFIRE_WUXING_PATH, buildRequest(input));
      return mapWuxingSnapshot(raw);
    },
  };
}
