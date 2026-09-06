/**
 * ETBZ-2 / ETBZ-24 — BirthInput, the validated entry fact of the product path.
 *
 * Pure domain: no imports, no I/O, no clock. Validation is fail-closed and
 * value-free in its issue texts (expectations are static; received values
 * never leave this module).
 *
 * Rules mandated by the ETBZ-2 contract:
 *  - NO default birth time. Unknown time is expressed ONLY by
 *    `birthTimeKnown: false` with the time field ABSENT.
 *  - The caller cannot steer transport: any attempt to smuggle endpoint /
 *    header / credential fields into the input is rejected before any network
 *    exists.
 */

/** Keys whose presence in a candidate input is a transport-override attempt. */
const FORBIDDEN_OVERRIDE_KEYS = [
  'baseurl',
  'base_url',
  'endpoint',
  'url',
  'headers',
  'apikey',
  'api_key',
  'x-api-key',
  'auth',
  'authorization',
  'token',
  'fufire',
  'fufireurl',
  'fufireapikey',
  'fufire_api_key',
] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

export type BirthInputIssueCode =
  | 'missing'
  | 'invalid'
  | 'contradiction'
  | 'forbidden_field';

export interface BirthInputIssue {
  /** Field name. Never a received value. */
  readonly field: string;
  readonly code: BirthInputIssueCode;
  /** Static, value-free expectation text. */
  readonly expectation: string;
}

export interface BirthLocation {
  readonly lat: number;
  readonly lon: number;
  readonly label?: string;
}

export interface BirthInputCandidate {
  readonly displayName: unknown;
  readonly birthDate: unknown;
  readonly birthTime?: unknown;
  readonly birthTimeKnown: unknown;
  readonly timezone: unknown;
  readonly location: unknown;
}

export interface NormalizedBirthInput {
  /** Personalization identifier, trimmed. */
  readonly displayName: string;
  /** `YYYY-MM-DD`, a real calendar date. */
  readonly birthDate: string;
  /** `HH:MM:SS`. Present ONLY when `birthTimeKnown` is true. */
  readonly birthTime?: string;
  readonly birthTimeKnown: boolean;
  /** IANA timezone identifier accepted by the local ICU tz database. */
  readonly timezone: string;
  readonly location: BirthLocation;
}

export type BirthInputValidation =
  | { readonly ok: true; readonly value: NormalizedBirthInput }
  | { readonly ok: false; readonly issues: readonly BirthInputIssue[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

function checkOverrideAttempt(candidate: object): BirthInputIssue[] {
  const issues: BirthInputIssue[] = [];
  for (const key of Object.keys(candidate)) {
    if ((FORBIDDEN_OVERRIDE_KEYS as readonly string[]).includes(key.toLowerCase())) {
      issues.push({
        field: key,
        code: 'forbidden_field',
        expectation:
          'birth input must not carry transport fields (endpoint, header or credential names); transport is server-owned',
      });
    }
  }
  return issues;
}

function validateDisplayName(value: unknown): BirthInputIssue[] {
  if (value === undefined || value === null) {
    return [{ field: 'displayName', code: 'missing', expectation: 'a non-empty personalization identifier (1-120 characters after trimming)' }];
  }
  if (typeof value !== 'string') {
    return [{ field: 'displayName', code: 'invalid', expectation: 'a non-empty personalization identifier (1-120 characters after trimming)' }];
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    return [{ field: 'displayName', code: 'invalid', expectation: 'a non-empty personalization identifier (1-120 characters after trimming)' }];
  }
  if (hasControlChars(trimmed)) {
    return [{ field: 'displayName', code: 'invalid', expectation: 'an identifier without control characters' }];
  }
  return [];
}

function validateDate(value: unknown): BirthInputIssue[] {
  if (value === undefined || value === null) {
    return [{ field: 'birthDate', code: 'missing', expectation: 'a calendar date formatted YYYY-MM-DD' }];
  }
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    return [{ field: 'birthDate', code: 'invalid', expectation: 'a calendar date formatted YYYY-MM-DD' }];
  }
  const [yearText, monthText, dayText] = value.split('-') as [string, string, string];
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const probe = new Date(Date.UTC(year, month - 1, day));
  const real =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  if (!real) {
    return [{ field: 'birthDate', code: 'invalid', expectation: 'a real calendar date (e.g. not 2023-02-29)' }];
  }
  return [];
}

function normalizeTime(value: unknown): { time?: string; issue?: BirthInputIssue } {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== 'string') {
    return { issue: { field: 'birthTime', code: 'invalid', expectation: 'a local time formatted HH:MM or HH:MM:SS' } };
  }
  const match = TIME_PATTERN.exec(value);
  if (match === null) {
    return { issue: { field: 'birthTime', code: 'invalid', expectation: 'a local time formatted HH:MM or HH:MM:SS' } };
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) {
    return { issue: { field: 'birthTime', code: 'invalid', expectation: 'a real local time (HH<=23, MM<=59, SS<=59)' } };
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return { time: `${pad(hour)}:${pad(minute)}:${pad(second)}` };
}

function validateTimezone(value: unknown): BirthInputIssue[] {
  if (value === undefined || value === null) {
    return [{ field: 'timezone', code: 'missing', expectation: 'an IANA timezone identifier (e.g. Europe/Berlin)' }];
  }
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || hasControlChars(value)) {
    return [{ field: 'timezone', code: 'invalid', expectation: 'an IANA timezone identifier (e.g. Europe/Berlin)' }];
  }
  try {
    // Local, dependency-free IANA check against the ICU tz database. A lookup
    // for an instant far from any DST edge throws RangeError for unknown zones.
    new Intl.DateTimeFormat('en-US', { timeZone: value, timeZoneName: 'short' }).format(new Date(0));
  } catch {
    return [{ field: 'timezone', code: 'invalid', expectation: 'an IANA timezone identifier known to the tz database' }];
  }
  return [];
}

function validateLocation(value: unknown): { issues: BirthInputIssue[]; location?: BirthLocation } {
  if (value === undefined || value === null) {
    return { issues: [{ field: 'location', code: 'missing', expectation: 'a location object with latitude and longitude' }] };
  }
  if (!isPlainObject(value)) {
    return { issues: [{ field: 'location', code: 'invalid', expectation: 'a location object with latitude and longitude' }] };
  }
  const issues: BirthInputIssue[] = checkOverrideAttempt(value);
  const lat = value['lat'];
  const lon = value['lon'];
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    issues.push({ field: 'location.lat', code: lat === undefined ? 'missing' : 'invalid', expectation: 'a finite latitude between -90 and 90' });
  }
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    issues.push({ field: 'location.lon', code: lon === undefined ? 'missing' : 'invalid', expectation: 'a finite longitude between -180 and 180' });
  }
  if (issues.length > 0 || typeof lat !== 'number' || typeof lon !== 'number') {
    return { issues };
  }
  const label = value['label'];
  if (label === undefined || label === null) {
    return { issues, location: { lat, lon } };
  }
  if (typeof label !== 'string' || label.trim().length < 1 || label.trim().length > 120 || hasControlChars(label)) {
    return { issues: [...issues, { field: 'location.label', code: 'invalid', expectation: 'an optional place label of 1-120 characters without control characters' }] };
  }
  return { issues, location: { lat, lon, label: label.trim() } };
}

/**
 * Validates and normalizes a birth input candidate. Never touches the network,
 * never invents a time, and reports every problem as a value-free issue.
 */
export function validateBirthInput(candidate: unknown): BirthInputValidation {
  if (!isPlainObject(candidate)) {
    return {
      ok: false,
      issues: [{ field: 'input', code: 'invalid', expectation: 'a birth input object' }],
    };
  }
  const issues: BirthInputIssue[] = checkOverrideAttempt(candidate);

  const displayNameIssues = validateDisplayName(candidate['displayName']);
  const dateIssues = validateDate(candidate['birthDate']);
  const timezoneIssues = validateTimezone(candidate['timezone']);
  const location = validateLocation(candidate['location']);
  issues.push(...displayNameIssues, ...dateIssues, ...timezoneIssues, ...location.issues);

  const known = candidate['birthTimeKnown'];
  if (typeof known !== 'boolean') {
    issues.push({ field: 'birthTimeKnown', code: 'missing', expectation: 'a boolean stating whether the birth time is known' });
  }

  const time = normalizeTime(candidate['birthTime']);
  if (time.issue !== undefined) {
    issues.push(time.issue);
  }

  if (known === true && candidate['birthTime'] === undefined && time.time === undefined) {
    issues.push({
      field: 'birthTime',
      code: 'missing',
      expectation: 'a birth time (HH:MM or HH:MM:SS) because birthTimeKnown is true; ETBZ never assumes a default time',
    });
  }
  if (known === false && candidate['birthTime'] !== undefined) {
    issues.push({
      field: 'birthTime',
      code: 'contradiction',
      expectation: 'no birth time may be supplied when birthTimeKnown is false; unknown time is never paired with a time value',
    });
  }

  if (issues.length > 0 || typeof known !== 'boolean') {
    return { ok: false, issues };
  }

  const normalized: NormalizedBirthInput = {
    displayName: (candidate['displayName'] as string).trim(),
    birthDate: candidate['birthDate'] as string,
    birthTimeKnown: known,
    timezone: candidate['timezone'] as string,
    location: location.location as BirthLocation,
  };
  if (known && time.time !== undefined) {
    return { ok: true, value: { ...normalized, birthTime: time.time } };
  }
  return { ok: true, value: normalized };
}
