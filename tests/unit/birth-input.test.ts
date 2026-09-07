import { describe, expect, it } from 'vitest';
import { validateBirthInput } from '../../src/domain/birth-input.js';

const VALID_FULL = {
  displayName: 'Kundin A',
  birthDate: '1990-06-15',
  birthTime: '14:30',
  birthTimeKnown: true,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405, label: 'Berlin' },
};

describe('BirthInput: valid synthetic records', () => {
  it('accepts a complete record and normalizes the time to HH:MM:SS', () => {
    const result = validateBirthInput({ ...VALID_FULL, birthTime: '14:30' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.birthTime).toBe('14:30:00');
      expect(result.value.displayName).toBe('Kundin A');
      expect(result.value.birthDate).toBe('1990-06-15');
      expect(result.value.timezone).toBe('Europe/Berlin');
    }
  });

  it('accepts an unknown-time record only with birthTimeKnown=false and no time', () => {
    const result = validateBirthInput({
      displayName: 'Kundin B',
      birthDate: '1985-11-03',
      birthTimeKnown: false,
      timezone: 'Europe/Berlin',
      location: { lat: 52.52, lon: 13.405 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.birthTime).toBeUndefined();
      expect(result.value.birthTimeKnown).toBe(false);
    }
  });

  it('trims the display name and enforces the 1-120 character bound', () => {
    const trimmed = validateBirthInput({ ...VALID_FULL, displayName: '  Zoe M.  ' });
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) {
      expect(trimmed.value.displayName).toBe('Zoe M.');
    }
    const tooLong = validateBirthInput({ ...VALID_FULL, displayName: 'x'.repeat(121) });
    expect(tooLong.ok).toBe(false);
  });
});

describe('BirthInput: negative paths', () => {
  it('rejects a missing date', () => {
    const result = validateBirthInput({ ...VALID_FULL, birthDate: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toContain('birthDate');
      expect(result.issues.map((issue) => issue.code)).toContain('missing');
    }
  });

  it('rejects a fake calendar date (2023-02-29)', () => {
    const result = validateBirthInput({ ...VALID_FULL, birthDate: '2023-02-29' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toContain('birthDate');
 }
  });

  it('rejects an invalid IANA timezone', () => {
    const result = validateBirthInput({ ...VALID_FULL, timezone: 'Mars/Olympus' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toContain('timezone');
    }
  });

  it('rejects a missing birthTimeKnown flag', () => {
    const candidate: Record<string, unknown> = { ...VALID_FULL };
    delete candidate['birthTimeKnown'];
    const result = validateBirthInput(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toContain('birthTimeKnown');
    }
  });

  it('rejects a missing birthTime when birthTimeKnown=true (no default time)', () => {
    const candidate: Record<string, unknown> = { ...VALID_FULL };
    delete candidate['birthTime'];
    const result = validateBirthInput(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field)).toContain('birthTime');
    }
  });

  it('rejects a time supplied together with birthTimeKnown=false (contradiction)', () => {
    const result = validateBirthInput({ ...VALID_FULL, birthTimeKnown: false, birthTime: '03:00' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain('contradiction');
    }
  });

  it('rejects an override attempt carrying endpoint/header/credential keys', () => {
    const result = validateBirthInput({
      ...VALID_FULL,
      headers: { 'X-API-Key': 'attack' },
      endpoint: 'http://evil.example',
      apiKey: 'leak',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain('forbidden_field');
      expect(result.issues.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('rejects a non-object input', () => {
    expect(validateBirthInput('nope').ok).toBe(false);
    expect(validateBirthInput(null).ok).toBe(false);
  });
});
