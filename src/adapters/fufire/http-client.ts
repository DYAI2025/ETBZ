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
  FufireHiddenStemFact,
  FufireMonthCommandFact,
  FufireNatalDayMasterFact,
  FufireNatalPillarFact,
  FufireNatalProvenance,
  FufireNatalSnapshot,
  FufirePillarFact,
  FufireTenGodFact,
  WuxingSnapshot,
} from '../../application/ports/fufire-gateway.js';
import {
  NATAL_BRANCHES,
  NATAL_ELEMENTS,
  NATAL_POLARITIES,
  NATAL_QI_ROLES,
  NATAL_STEMS,
  TEN_GOD_ELEMENT_RELATIONS,
  TEN_GOD_NAMES,
  TEN_GOD_PINYIN,
  WUXING_ELEMENTS,
} from '../../application/ports/fufire-gateway.js';
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

// =============================================================================
// ETBZ-29 — the NATAL operation of the same boundary.
//
// This is a minimal extension of the client above, NOT a second client: the
// server-owned base URL, the server-owned `X-API-Key`, the timeout semantics,
// the typed failure taxonomy and the fail-closed rule are the existing ones.
// Only the pinned operation path and the response mapping are new.
//
// The request payload is `buildRequest(...)` unchanged: `NatalRequest`
// (`schemas/calculate/bazi/natal.request.schema.json`, `additionalProperties:
// false`) accepts exactly the keys ETBZ already sends — date, tz, lat, lon,
// standard, birth_time_known — so unknown time still means an OMITTED time and
// `birth_time_known: false`, never a substituted `T00:00`.
// =============================================================================

export const FUFIRE_NATAL_PATH = '/v1/calculate/bazi/natal';

function asEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
): T {
  const text = asString(value, what);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `FuFirE response field ${what} is not one of the pinned contract values`,
    );
  }
  return text as T;
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', `FuFirE response field ${what} is not a boolean`);
  }
  return value;
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', `FuFirE response field ${what} is not an array`);
  }
  return value;
}

function asStringArray(value: unknown, what: string): readonly string[] {
  return asArray(value, what).map((entry, index) => asString(entry, `${what}[${index}]`));
}

function mapTenGod(raw: unknown, what: string): FufireTenGodFact {
  const body = asObject(raw, what);
  return {
    name: asEnumValue(body['name'], TEN_GOD_NAMES, `${what}.name`),
    pinyin: asEnumValue(body['pinyin'], TEN_GOD_PINYIN, `${what}.pinyin`),
    elementRelation: asEnumValue(
      body['element_relation'],
      TEN_GOD_ELEMENT_RELATIONS,
      `${what}.element_relation`,
    ),
    labelDe: asString(body['label_de'], `${what}.label_de`),
  };
}

function mapHiddenStems(raw: unknown, what: string): readonly FufireHiddenStemFact[] {
  const entries = asArray(raw, what);
  if (entries.length < 1 || entries.length > 3) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `${what} must hold 1..3 hidden stems (contract minItems/maxItems)`,
    );
  }
  const mapped = entries.map((entry, index): FufireHiddenStemFact => {
    const where = `${what}[${index}]`;
    const body = asObject(entry, where);
    const weight = asNumber(body['weight'], `${where}.weight`);
    if (!(weight > 0) || weight > 1) {
      throw new FufireError(
        'FUFIRE_CONTRACT_ERROR',
        `${where}.weight is outside the contract range (0 < weight <= 1)`,
      );
    }
    return {
      stem: asEnumValue(body['stem'], NATAL_STEMS, `${where}.stem`),
      stemCn: asString(body['stem_cn'], `${where}.stem_cn`),
      element: asEnumValue(body['element'], NATAL_ELEMENTS, `${where}.element`),
      qi: asEnumValue(body['qi'], NATAL_QI_ROLES, `${where}.qi`),
      weight,
      // Contract: a Ten God is present for EVERY hidden stem, including the
      // day branch's. A missing one is drift, never an accepted gap.
      tenGod: mapTenGod(body['ten_god'], `${where}.ten_god`),
    };
  });
  // Contract: "the branch's hidden stems in Qi order (principal, then central,
  // then residual, as far as the branch has them)". Order carries meaning, so
  // it is verified rather than re-sorted.
  const expectedOrder = NATAL_QI_ROLES.slice(0, mapped.length);
  const actualOrder = mapped.map((entry) => entry.qi);
  if (actualOrder.join(',') !== expectedOrder.join(',')) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `${what} is not in the contract Qi order (principal, central, residual)`,
    );
  }
  return mapped;
}

type NatalPillarName = 'year' | 'month' | 'day' | 'hour';

function mapNatalPillar(raw: unknown, name: NatalPillarName): FufireNatalPillarFact {
  const what = `pillars.${name}`;
  const body = asObject(raw, what);
  const hiddenStems = mapHiddenStems(body['hidden_stems'], `${what}.hidden_stems`);
  const branchElement = asEnumValue(
    body['branch_element'],
    NATAL_ELEMENTS,
    `${what}.branch_element`,
  );
  const principal = hiddenStems[0];
  if (principal === undefined || principal.qi !== 'principal') {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `${what}.hidden_stems has no principal Qi stem`,
    );
  }
  // Contract: branch_element IS the element of the branch's principal hidden
  // stem ("the identical derivation MonthCommand.element uses").
  if (branchElement !== principal.element) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `${what}.branch_element (${branchElement}) contradicts the principal hidden stem element (${principal.element})`,
    );
  }
  // Contract: `ten_god` is null for the day pillar ONLY — the day stem IS the
  // day master, so no relation to itself exists.
  const rawTenGod = body['ten_god'];
  let tenGod: FufireTenGodFact | null;
  if (name === 'day') {
    if (rawTenGod !== null) {
      throw new FufireError(
        'FUFIRE_CONTRACT_ERROR',
        'pillars.day.ten_god must be null (the day stem is the day master)',
      );
    }
    tenGod = null;
  } else {
    if (rawTenGod === null) {
      throw new FufireError(
        'FUFIRE_CONTRACT_ERROR',
        `${what}.ten_god is null; only the day pillar may omit its Ten God`,
      );
    }
    tenGod = mapTenGod(rawTenGod, `${what}.ten_god`);
  }
  return {
    stem: asEnumValue(body['stem'], NATAL_STEMS, `${what}.stem`),
    branch: asEnumValue(body['branch'], NATAL_BRANCHES, `${what}.branch`),
    stemCn: asString(body['stem_cn'], `${what}.stem_cn`),
    branchCn: asString(body['branch_cn'], `${what}.branch_cn`),
    stemElement: asEnumValue(body['stem_element'], NATAL_ELEMENTS, `${what}.stem_element`),
    branchElement,
    polarity: asEnumValue(body['polarity'], NATAL_POLARITIES, `${what}.polarity`),
    tenGod,
    hiddenStems,
  };
}

function mapNatalSnapshot(raw: unknown): FufireNatalSnapshot {
  const body = asObject(raw, 'response');
  const pillarsRaw = asObject(body['pillars'], 'pillars');
  const pillars = {
    year: mapNatalPillar(pillarsRaw['year'], 'year'),
    month: mapNatalPillar(pillarsRaw['month'], 'month'),
    day: mapNatalPillar(pillarsRaw['day'], 'day'),
    hour: mapNatalPillar(pillarsRaw['hour'], 'hour'),
  };

  const dayMasterRaw = asObject(body['day_master'], 'day_master');
  const dayMaster: FufireNatalDayMasterFact = {
    stem: asEnumValue(dayMasterRaw['stem'], NATAL_STEMS, 'day_master.stem'),
    stemCn: asString(dayMasterRaw['stem_cn'], 'day_master.stem_cn'),
    element: asEnumValue(dayMasterRaw['element'], NATAL_ELEMENTS, 'day_master.element'),
    polarity: asEnumValue(dayMasterRaw['polarity'], NATAL_POLARITIES, 'day_master.polarity'),
  };
  if (dayMaster.stem !== pillars.day.stem) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `day_master.stem (${dayMaster.stem}) contradicts pillars.day.stem (${pillars.day.stem})`,
    );
  }

  const monthCommandRaw = asObject(body['month_command'], 'month_command');
  const branchIndex = asNumber(monthCommandRaw['branch_index'], 'month_command.branch_index');
  if (!Number.isInteger(branchIndex) || branchIndex < 0 || branchIndex > 11) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      'month_command.branch_index is not an integer in 0..11',
    );
  }
  const sourceStatus = asString(monthCommandRaw['source_status'], 'month_command.source_status');
  if (sourceStatus !== 'CALCULATED') {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `month_command.source_status is "${sourceStatus}", not the contract constant CALCULATED`,
    );
  }
  const monthCommand: FufireMonthCommandFact = {
    branch: asEnumValue(monthCommandRaw['branch'], NATAL_BRANCHES, 'month_command.branch'),
    branchCn: asString(monthCommandRaw['branch_cn'], 'month_command.branch_cn'),
    branchIndex,
    principalQiStem: asEnumValue(
      monthCommandRaw['principal_qi_stem'],
      NATAL_STEMS,
      'month_command.principal_qi_stem',
    ),
    principalQiStemCn: asString(
      monthCommandRaw['principal_qi_stem_cn'],
      'month_command.principal_qi_stem_cn',
    ),
    element: asEnumValue(monthCommandRaw['element'], NATAL_ELEMENTS, 'month_command.element'),
    sourceStatus: 'CALCULATED',
  };
  // The month command IS the month branch's ruleset lookup — a month command
  // that names a different branch, stem or element than the month pillar it
  // was derived from is drift, not a fact.
  if (monthCommand.branch !== pillars.month.branch) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `month_command.branch (${monthCommand.branch}) contradicts pillars.month.branch (${pillars.month.branch})`,
    );
  }
  const monthPrincipal = pillars.month.hiddenStems[0];
  if (monthPrincipal === undefined) {
    throw new FufireError('FUFIRE_CONTRACT_ERROR', 'pillars.month.hidden_stems is empty');
  }
  if (monthCommand.principalQiStem !== monthPrincipal.stem) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `month_command.principal_qi_stem (${monthCommand.principalQiStem}) contradicts the month pillar's principal hidden stem (${monthPrincipal.stem})`,
    );
  }
  if (monthCommand.element !== monthPrincipal.element) {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `month_command.element (${monthCommand.element}) contradicts the principal Qi stem element (${monthPrincipal.element})`,
    );
  }

  const provenanceRaw = asObject(body['provenance'], 'provenance');
  const source = asString(provenanceRaw['source'], 'provenance.source');
  if (source !== 'FuFirE') {
    throw new FufireError(
      'FUFIRE_CONTRACT_ERROR',
      `provenance.source is "${source}", not the contract constant FuFirE`,
    );
  }
  const provenance: FufireNatalProvenance = {
    source: 'FuFirE',
    rulesetId: asString(provenanceRaw['ruleset_id'], 'provenance.ruleset_id'),
    rulesetVersion: asString(provenanceRaw['ruleset_version'], 'provenance.ruleset_version'),
    computedAt: asString(provenanceRaw['computed_at'], 'provenance.computed_at'),
  };

  const precisionRaw = asObject(body['precision'], 'precision');
  const precision = {
    birthTimeKnown: asBoolean(precisionRaw['birth_time_known'], 'precision.birth_time_known'),
    provisionalFields: asStringArray(
      precisionRaw['provisional_fields'],
      'precision.provisional_fields',
    ),
  };

  // Source warnings: STRUCTURE is validated, MEANING is not. There is no
  // allowlist here on purpose — an unknown but structurally valid stable code
  // must pass this boundary unchanged. Order is kept, duplicates are kept,
  // nothing is renamed, nothing is dropped, nothing is added.
  const warnings = asStringArray(body['warnings'], 'warnings');

  return { pillars, dayMaster, monthCommand, provenance, precision, warnings };
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
    async calculateNatal(input: NormalizedBirthInput): Promise<FufireNatalSnapshot> {
      const raw = await postJson(config, transport, FUFIRE_NATAL_PATH, buildRequest(input));
      return mapNatalSnapshot(raw);
    },
  };
}
