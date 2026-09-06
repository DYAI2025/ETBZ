import { describe, expect, it, vi } from 'vitest';
import { FUFIRE_BAZI_PATH, createFufireClient } from '../../src/adapters/fufire/http-client.js';
import type { FufireClientConfig } from '../../src/adapters/fufire/http-client.js';
import { createCalculateHoroscopeUseCase } from '../../src/application/horoscope-use-case.js';
import { validateBirthInput } from '../../src/domain/birth-input.js';

const VALID_FULL_RAW = {
  displayName: 'Musterkundin A',
  birthDate: '1990-06-15',
  birthTime: '14:30',
  birthTimeKnown: true,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405, label: 'Berlin' },
};

const CONFIG: FufireClientConfig = {
  baseUrl: 'http://127.0.0.1:8110',
  apiKey: 'server-owned-test-key',
  timeoutMs: 1500,
  runtimeImage: 'fufire-lunar@sha256:c9162edd',
  openapiSha256: '6c1db672',
};

const INPUT = validateBirthInput({
  displayName: 'Musterkundin A',
  birthDate: '1990-06-15',
  birthTime: '14:30',
  birthTimeKnown: true,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405, label: 'Berlin' },
});
if (!INPUT.ok) throw new Error('fixture input must validate');

function okBaziBody(): Record<string, unknown> {
  return {
    pillars: {
      year: { stamm: 'Geng', zweig: 'Wu', tier: 'Pferd', element: 'Metall' },
      month: { stamm: 'Ren', zweig: 'Wu', tier: 'Pferd', element: 'Wasser' },
      day: { stamm: 'Xin', zweig: 'Hai', tier: 'Schwein', element: 'Metall' },
      hour: { stamm: 'Yi', zweig: 'Wei', tier: 'Ziege', element: 'Holz' },
    },
    chinese: { day_master: 'Xin' },
    dates: {
      birth_local: '1990-06-15T14:30:00+02:00',
      birth_utc: '1990-06-15T12:30:00+00:00',
      lichun_local: '1990-02-04T10:14:00+01:00',
    },
    precision: { birth_time_known: true, provisional_fields: [] },
    provenance: {
      engine_version: '1.0.0-rc1-20260220',
      ruleset_id: 'traditional_bazi_2026',
      ephemeris_id: 'swieph_sepl18',
      tzdb_version_id: '2026.2',
      computation_timestamp: '2026-09-05T22:58:07.958002+00:00',
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function clientWith(fetchMock: (url: string, init?: RequestInit) => Promise<Response>) {
  return createFufireClient({ config: CONFIG, transport: { fetch: fetchMock } });
}

describe('FuFirE HTTP client: request contract', () => {
  it('posts to the server-owned path with server-owned headers', async () => {
    const seen = { url: '' as string | undefined, init: undefined as RequestInit | undefined };
    const client = clientWith(async (url, init) => {
      seen.url = url;
      seen.init = init;
      return jsonResponse(200, okBaziBody());
    });
    await client.calculateBazi(INPUT.value);
    expect(seen.url).toBe(`http://127.0.0.1:8110${FUFIRE_BAZI_PATH}`);
    const headers = new Headers(seen.init?.headers);
    expect(headers.get('X-API-Key')).toBe('server-owned-test-key');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('sends BaziRequest with local ISO datetime and birth_time_known=true for a full record', async () => {
    const seen = { body: '' as string | undefined };
    const client = clientWith(async (_url, init) => {
      seen.body = String(init?.body);
      return jsonResponse(200, okBaziBody());
    });
    await client.calculateBazi(INPUT.value);
    const payload = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
    expect(payload['date']).toBe('1990-06-15T14:30:00');
    expect(payload['tz']).toBe('Europe/Berlin');
    expect(payload['lat']).toBe(52.52);
    expect(payload['lon']).toBe(13.405);
    expect(payload['standard']).toBe('CIVIL');
    expect(payload['birth_time_known']).toBe(true);
  });

  it('sends the date-only value with birth_time_known=false for unknown time (no substituted time)', async () => {
    const unknown = validateBirthInput({
      displayName: 'Musterkundin B',
      birthDate: '1985-11-03',
      birthTimeKnown: false,
      timezone: 'Europe/Berlin',
      location: { lat: 52.52, lon: 13.405 },
    });
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    const seen = { body: '' as string | undefined };
    const client = clientWith(async (_url, init) => {
      seen.body = String(init?.body);
      return jsonResponse(200, okBaziBody());
    });
    await client.calculateBazi(unknown.value);
    const payload = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
    expect(payload['date']).toBe('1985-11-03');
    expect(payload['birth_time_known']).toBe(false);
    expect(String(payload['date'])).not.toContain('T00:00:00');
  });
});

describe('FuFirE HTTP client: response mapping', () => {
  it('maps the full snapshot strictly against the pinned contract', async () => {
    const client = clientWith(async () => jsonResponse(200, okBaziBody()));
    const snapshot = await client.calculateBazi(INPUT.value);
    expect(snapshot.pillars.year.stem).toBe('Geng');
    expect(snapshot.dayMaster).toBe('Xin');
    expect(snapshot.dates.birthUtc).toBe('1990-06-15T12:30:00+00:00');
    expect(snapshot.provenance.engineVersion).toBe('1.0.0-rc1-20260220');
  });

  it('maps the wu-xing endpoint against the pinned contract', async () => {
    const client = clientWith(async () => jsonResponse(200, {
      wu_xing_vector: { Holz: 1.8, Feuer: 2.5, Erde: 2.0, Metall: 2.0, Wasser: 2.0 },
      dominant_element: 'Feuer',
      basis: 'bazi_four_pillars',
    }));
    const snapshot = await client.calculateBaziWuxing(INPUT.value);
    expect(snapshot.dominant).toBe('Feuer');
    expect(snapshot.vector.Feuer).toBe(2.5);
  });
});

describe('FuFirE HTTP client: fail-closed negative paths', () => {
  it('fails closed on invalid auth (401)', async () => {
    const client = clientWith(async () => jsonResponse(401, { error: 'unauthorized' }));
    await expect(client.calculateBazi(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_AUTH_FAILED' });
  });

  it('fails closed on timeout', async () => {
    const client = clientWith(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    await expect(client.calculateBazi(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_TIMEOUT' });
  });

  it('fails closed on 5xx', async () => {
    const client = clientWith(async () => jsonResponse(503, { error: 'engine_unavailable' }));
    await expect(client.calculateBazi(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_SERVER_ERROR' });
  });

  it('propagates a domain 422 rejection with its machine error code', async () => {
    const client = clientWith(async () => jsonResponse(422, {
      error: 'dst_time_error',
      message: 'Nonexistent local time due to DST transition (spring-forward gap).',
    }));
    await expect(client.calculateBazi(INPUT.value)).rejects.toMatchObject({
      code: 'FUFIRE_REJECTED',
      detailCode: 'dst_time_error',
    });
  });

  it('fails closed on malformed JSON', async () => {
    const client = clientWith(async () => new Response('<html>not json</html>', { status: 200 }));
    await expect(client.calculateBazi(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_CONTRACT_ERROR' });
  });

  it('fails closed on a missing required field', async () => {
    const drifted = okBaziBody();
    delete (drifted)['provenance'];
    const client = clientWith(async () => jsonResponse(200, drifted));
    await expect(client.calculateBazi(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_CONTRACT_ERROR' });
  });

  it('fails closed on schema drift (pillar shape changed)', async () => {
    const drifted = okBaziBody();
    (drifted)['pillars'] = {
      ...((drifted)['pillars'] as Record<string, unknown>),
      year: { stemRoman: 'Geng' },
    };
    const client = clientWith(async () => jsonResponse(200, drifted));
    await expect(client.calculateBazi(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_CONTRACT_ERROR' });
  });

  it('fails closed on a day-master contradiction in the response', async () => {
    const drifted = okBaziBody();
    ((drifted)['chinese'] as Record<string, unknown>)['day_master'] = 'Ren';
    const client = clientWith(async () => jsonResponse(200, drifted));
    await expect(client.calculateBazi(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_CONTRACT_ERROR' });
  });

  it('calls the network exactly zero times when the input fails validation (behavioural, via the application use case)', async () => {
    // The ETBZ-24 application use case: validate first, call FuFirE only on a
    // valid input. A validation failure must stop BEFORE the gateway boundary.
    const fetchMock = vi.fn(async () => jsonResponse(200, okBaziBody()));
    const client = createFufireClient({ config: CONFIG, transport: { fetch: fetchMock } });
    const useCase = createCalculateHoroscopeUseCase({ gateway: client, runtime: CONFIG });

    const invalidCandidates: unknown[] = [
      null,
      'nope',
      { ...VALID_FULL_RAW, birthDate: '2023-02-29' },
      { ...VALID_FULL_RAW, birthTimeKnown: true, birthTime: undefined },
      { ...VALID_FULL_RAW, birthTimeKnown: false, birthTime: '03:00' },
      { ...VALID_FULL_RAW, timezone: 'Mars/Olympus' },
      { ...VALID_FULL_RAW, apiKey: 'injected-credential', endpoint: 'http://evil.example' },
    ];
    for (const candidate of invalidCandidates) {
      const outcome = await useCase.execute(candidate);
      expect(outcome.ok).toBe(false);
      if (outcome.ok || outcome.error.code !== 'BIRTH_INPUT_INVALID') {
        throw new Error(`expected BIRTH_INPUT_INVALID for candidate ${JSON.stringify(candidate)}`);
      }
      expect(outcome.error.issues.length).toBeGreaterThan(0);
    }
    // The single behavioural proof: not one fetch happened for any invalid input.
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe('FuFirE HTTP client: payload suppression of unknown-time', () => {
  it('omits the time entirely for unknown-time input (no T00:00:00 substitution)', async () => {
    const unknown = validateBirthInput({
      displayName: 'Musterkundin B',
      birthDate: '1985-11-03',
      birthTimeKnown: false,
      timezone: 'Europe/Berlin',
      location: { lat: 52.52, lon: 13.405 },
    });
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    const seen = { body: '' as string | undefined };
    const client = clientWith(async (_url, init) => {
      seen.body = String(init?.body);
      return jsonResponse(200, okBaziBody());
    });
    await client.calculateBazi(unknown.value);
    const payload = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
    expect(payload['date']).toBe('1985-11-03');
    expect(payload['birth_time_known']).toBe(false);
    expect(String(payload['date'])).not.toContain('T00:00:00');
  });
});
