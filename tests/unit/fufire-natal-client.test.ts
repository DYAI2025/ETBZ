import { describe, expect, it, vi } from 'vitest';
import {
  FUFIRE_NATAL_PATH,
  createFufireClient,
} from '../../src/adapters/fufire/http-client.js';
import type { FufireClientConfig } from '../../src/adapters/fufire/http-client.js';
import { createCalculateHoroscopeUseCase } from '../../src/application/horoscope-use-case.js';
import { validateBirthInput } from '../../src/domain/birth-input.js';
import {
  UNKNOWN_TIME_NATAL_WIRE_OVERRIDES,
  natalSnapshot,
  natalWireBody,
} from '../support/natalFixture.js';

/**
 * ETBZ-29 — the REAL natal boundary as seen from the consumer.
 *
 * Everything here is asserted against the pinned FuFirE contract
 * (`schemas/calculate/bazi/natal.response.schema.json`, build
 * 1.0.0-rc1-20260220). No test asserts a value ETBZ computed itself.
 */

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

const UNKNOWN_INPUT = validateBirthInput({
  displayName: 'Musterkundin B',
  birthDate: '1985-11-03',
  birthTimeKnown: false,
  timezone: 'Europe/Berlin',
  location: { lat: 52.52, lon: 13.405 },
});
if (!UNKNOWN_INPUT.ok) throw new Error('fixture unknown-time input must validate');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clientWith(fetchMock: (url: string, init?: RequestInit) => Promise<Response>) {
  return createFufireClient({ config: CONFIG, transport: { fetch: fetchMock } });
}

function clientReturning(body: unknown) {
  return clientWith(async () => jsonResponse(200, body));
}

/** Builds a natal wire body whose `pillars.year` block carries `patch`. */
function withYearPillar(patch: Record<string, unknown>): Record<string, unknown> {
  return natalWireBody({ pillars: { year: patch } });
}

describe('ETBZ-29 natal boundary: request contract', () => {
  it('posts to the pinned server-owned natal path with the server-owned key', async () => {
    const seen = { url: undefined as string | undefined, init: undefined as RequestInit | undefined };
    const client = clientWith(async (url, init) => {
      seen.url = url;
      seen.init = init;
      return jsonResponse(200, natalWireBody());
    });
    await client.calculateNatal(INPUT.value);
    expect(FUFIRE_NATAL_PATH).toBe('/v1/calculate/bazi/natal');
    expect(seen.url).toBe(`http://127.0.0.1:8110${FUFIRE_NATAL_PATH}`);
    const headers = new Headers(seen.init?.headers);
    expect(headers.get('X-API-Key')).toBe('server-owned-test-key');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('sends only keys the NatalRequest contract allows (additionalProperties: false)', async () => {
    const seen = { body: undefined as string | undefined };
    const client = clientWith(async (_url, init) => {
      seen.body = String(init?.body);
      return jsonResponse(200, natalWireBody());
    });
    await client.calculateNatal(INPUT.value);
    const payload = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
    // NatalRequest properties: date, tz, lat, lon, standard, boundary,
    // ambiguousTime, nonexistentTime, birth_time_known.
    const allowed = new Set([
      'date', 'tz', 'lat', 'lon', 'standard', 'boundary',
      'ambiguousTime', 'nonexistentTime', 'birth_time_known',
    ]);
    for (const key of Object.keys(payload)) {
      expect(allowed.has(key), `NatalRequest forbids the extra property "${key}"`).toBe(true);
    }
    expect(payload['date']).toBe('1990-06-15T14:30:00');
    expect(payload['tz']).toBe('Europe/Berlin');
    expect(payload['lat']).toBe(52.52);
    expect(payload['lon']).toBe(13.405);
    expect(payload['birth_time_known']).toBe(true);
  });

  it('omits the time entirely for unknown-time input (no substituted T00:00)', async () => {
    const seen = { body: undefined as string | undefined };
    const client = clientWith(async (_url, init) => {
      seen.body = String(init?.body);
      return jsonResponse(200, natalWireBody(UNKNOWN_TIME_NATAL_WIRE_OVERRIDES));
    });
    await client.calculateNatal(UNKNOWN_INPUT.value);
    const payload = JSON.parse(seen.body ?? '{}') as Record<string, unknown>;
    expect(payload['date']).toBe('1985-11-03');
    expect(payload['birth_time_known']).toBe(false);
    expect(String(payload['date'])).not.toContain('T');
  });
});

describe('ETBZ-29 natal boundary: response mapping', () => {
  it('maps the wire body to exactly the port snapshot (the two fixtures cannot drift)', async () => {
    const client = clientReturning(natalWireBody());
    await expect(client.calculateNatal(INPUT.value)).resolves.toEqual(natalSnapshot());
  });

  it('preserves the deterministic natal facts the slice exists for', async () => {
    const client = clientReturning(natalWireBody());
    const snapshot = await client.calculateNatal(INPUT.value);
    // Hidden stems, in Qi order, with the ruleset weights.
    expect(snapshot.pillars.hour.hiddenStems.map((h) => [h.stem, h.qi, h.weight])).toEqual([
      ['Ji', 'principal', 1],
      ['Yi', 'central', 0.5],
      ['Ding', 'residual', 0.3],
    ]);
    // A Ten God for every hidden stem, including the day branch's.
    for (const pillar of Object.values(snapshot.pillars)) {
      for (const hidden of pillar.hiddenStems) {
        expect(hidden.tenGod.name.length).toBeGreaterThan(0);
      }
    }
    // Ten Gods for the visible stems, null for the day pillar only.
    expect(snapshot.pillars.day.tenGod).toBeNull();
    expect(snapshot.pillars.hour.tenGod).toEqual({
      name: 'IndirectWealth',
      pinyin: 'Pian Cai',
      elementRelation: 'controlled_by_day_master',
      labelDe: 'Indirektes Vermögen',
    });
    // Month command (Yue Ling) and its principal Qi stem.
    expect(snapshot.monthCommand).toEqual({
      branch: 'Wu',
      branchCn: '午',
      branchIndex: 6,
      principalQiStem: 'Ding',
      principalQiStemCn: '丁',
      element: 'fire',
      sourceStatus: 'CALCULATED',
    });
    // Polarity, precision and natal provenance.
    expect(snapshot.pillars.day.polarity).toBe('yin');
    expect(snapshot.dayMaster).toEqual({ stem: 'Xin', stemCn: '辛', element: 'metal', polarity: 'yin' });
    expect(snapshot.precision).toEqual({ birthTimeKnown: true, provisionalFields: [] });
    expect(snapshot.provenance.source).toBe('FuFirE');
    expect(snapshot.provenance.rulesetId).toBe('standard_bazi_2026');
    expect(snapshot.provenance.rulesetVersion).toBe('1.0.0');
  });

  it('carries no fabricated strength/rooting/yong-shen field (MISSING-003 stays missing)', async () => {
    const client = clientReturning(natalWireBody());
    const snapshot = await client.calculateNatal(INPUT.value);
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ['seasonal', 'strength', 'wang', 'yong_shen', 'yongShen', 'tong_gen', 'rooting']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe('ETBZ-29 natal boundary: source warnings are preserved, never filtered', () => {
  it('passes an UNKNOWN but structurally valid warning code through unchanged', async () => {
    // Proof that there is no allowlist: this code is not in today's
    // match.types.WarningCode enum and must still reach the consumer verbatim.
    const client = clientReturning(natalWireBody({ warnings: ['LEAP_MONTH_AMBIGUOUS_2027'] }));
    const snapshot = await client.calculateNatal(INPUT.value);
    expect(snapshot.warnings).toEqual(['LEAP_MONTH_AMBIGUOUS_2027']);
  });

  it('keeps order and duplicates exactly as received', async () => {
    const source = ['DAY_ANCHOR_UNVERIFIED', 'BIRTH_TIME_UNKNOWN', 'DAY_ANCHOR_UNVERIFIED'];
    const client = clientReturning(natalWireBody({ warnings: source }));
    const snapshot = await client.calculateNatal(INPUT.value);
    expect(snapshot.warnings).toEqual(source);
  });

  it('accepts an empty warning array without inventing a warning', async () => {
    const client = clientReturning(natalWireBody({ warnings: [] }));
    const snapshot = await client.calculateNatal(INPUT.value);
    expect(snapshot.warnings).toEqual([]);
  });

  it.each([
    ['not an array', 'DAY_ANCHOR_UNVERIFIED'],
    ['a non-string entry', ['DAY_ANCHOR_UNVERIFIED', { code: 'BIRTH_TIME_UNKNOWN' }]],
    ['an empty-string code', ['']],
    ['a null entry', [null]],
  ])('fails closed when the warnings block is %s (malformed structure is drift)', async (_label, warnings) => {
    const client = clientReturning(natalWireBody({ warnings }));
    await expect(client.calculateNatal(INPUT.value)).rejects.toMatchObject({
      code: 'FUFIRE_CONTRACT_ERROR',
    });
  });
});

describe('ETBZ-29 natal boundary: malformed deterministic facts fail closed', () => {
  it.each([
    ['a missing block (month_command)', (): Record<string, unknown> => {
      const body = natalWireBody();
      delete body['month_command'];
      return body;
    }],
    ['an unknown stem', (): Record<string, unknown> => withYearPillar({ stem: 'Foobar' })],
    ['an unknown branch', (): Record<string, unknown> => withYearPillar({ branch: 'Foobar' })],
    ['an unknown element vocabulary', (): Record<string, unknown> => withYearPillar({ stem_element: 'aether' })],
    ['an unknown polarity', (): Record<string, unknown> => withYearPillar({ polarity: 'neutral' })],
    ['a missing hidden-stem list', (): Record<string, unknown> => withYearPillar({ hidden_stems: [] })],
    ['more hidden stems than the contract allows', (): Record<string, unknown> =>
      withYearPillar({
        hidden_stems: [
          ...(natalWireBody()['pillars'] as Record<string, Record<string, unknown>>)['year']?.['hidden_stems'] as unknown[],
          { stem: 'Wu', stem_cn: '戊', element: 'earth', qi: 'residual', weight: 0.3,
            ten_god: { name: 'IndirectRes', pinyin: 'Pian Yin', element_relation: 'produces_day_master', label_de: 'Indirekte Quelle' } },
          { stem: 'Jia', stem_cn: '甲', element: 'wood', qi: 'residual', weight: 0.3,
            ten_god: { name: 'DirectWealth', pinyin: 'Zheng Cai', element_relation: 'controlled_by_day_master', label_de: 'Direktes Vermögen' } },
        ],
      })],
    ['hidden stems out of Qi order', (): Record<string, unknown> => {
      const body = natalWireBody();
      const year = (body['pillars'] as Record<string, Record<string, unknown>>)['year'] as Record<string, unknown>;
      const hidden = year['hidden_stems'] as Record<string, unknown>[];
      year['hidden_stems'] = [...hidden].reverse();
      return body;
    }],
    ['hidden stems whose central and residual Qi are swapped', (): Record<string, unknown> => {
      // The principal Qi stem still comes first, so ONLY the Qi-order rule
      // stands between this and an accepted, silently reordered ledger.
      const body = natalWireBody();
      const hour = (body['pillars'] as Record<string, Record<string, unknown>>)['hour'] as Record<string, unknown>;
      const hidden = hour['hidden_stems'] as Record<string, unknown>[];
      hour['hidden_stems'] = [hidden[0], hidden[2], hidden[1]];
      return body;
    }],
    ['a hidden stem without its Ten God', (): Record<string, unknown> => {
      const body = natalWireBody();
      const year = (body['pillars'] as Record<string, Record<string, unknown>>)['year'] as Record<string, unknown>;
      const hidden = year['hidden_stems'] as Record<string, unknown>[];
      const first = { ...hidden[0] };
      delete first['ten_god'];
      year['hidden_stems'] = [first, ...hidden.slice(1)];
      return body;
    }],
    ['a Qi weight outside the ruleset range', (): Record<string, unknown> => {
      const body = natalWireBody();
      const year = (body['pillars'] as Record<string, Record<string, unknown>>)['year'] as Record<string, unknown>;
      const hidden = year['hidden_stems'] as Record<string, unknown>[];
      year['hidden_stems'] = [{ ...hidden[0], weight: 1.5 }, ...hidden.slice(1)];
      return body;
    }],
    ['an unknown Ten-God name', (): Record<string, unknown> =>
      withYearPillar({ ten_god: { name: 'Overlord', pinyin: 'Jie Cai', element_relation: 'same_element', label_de: 'Rivale' } })],
    ['an unknown Ten-God pinyin', (): Record<string, unknown> =>
      withYearPillar({ ten_god: { name: 'RobWealth', pinyin: 'Da Wang', element_relation: 'same_element', label_de: 'Rivale' } })],
    ['an unknown element relation', (): Record<string, unknown> =>
      withYearPillar({ ten_god: { name: 'RobWealth', pinyin: 'Jie Cai', element_relation: 'orbits_day_master', label_de: 'Rivale' } })],
    ['a null Ten God on a non-day pillar', (): Record<string, unknown> => withYearPillar({ ten_god: null })],
    ['a non-null Ten God on the day pillar', (): Record<string, unknown> =>
      natalWireBody({ pillars: { day: { ten_god: { name: 'Friend', pinyin: 'Bi Jian', element_relation: 'same_element', label_de: 'Gefährte' } } } })],
    ['a branch_element that is not the principal Qi element', (): Record<string, unknown> =>
      withYearPillar({ branch_element: 'water' })],
    ['a day_master that contradicts the day pillar stem', (): Record<string, unknown> =>
      natalWireBody({ day_master: { stem: 'Ren', stem_cn: '壬', element: 'water', polarity: 'yang' } })],
    ['a month command naming another branch', (): Record<string, unknown> =>
      natalWireBody({ month_command: { branch: 'Zi', branch_cn: '子', branch_index: 0 } })],
    ['a month command branch_index out of range', (): Record<string, unknown> =>
      natalWireBody({ month_command: { branch_index: 12 } })],
    ['a month command naming another principal Qi stem', (): Record<string, unknown> =>
      natalWireBody({ month_command: { principal_qi_stem: 'Geng', principal_qi_stem_cn: '庚' } })],
    ['a month command element that is not the principal Qi element', (): Record<string, unknown> =>
      natalWireBody({ month_command: { element: 'water' } })],
    ['a source_status other than CALCULATED', (): Record<string, unknown> =>
      natalWireBody({ month_command: { source_status: 'ESTIMATED' } })],
    ['a provenance source that is not FuFirE', (): Record<string, unknown> =>
      natalWireBody({ provenance: { source: 'SomeOtherEngine' } })],
    ['a missing ruleset version', (): Record<string, unknown> => {
      const body = natalWireBody();
      delete (body['provenance'] as Record<string, unknown>)['ruleset_version'];
      return body;
    }],
    ['a non-boolean birth_time_known', (): Record<string, unknown> =>
      natalWireBody({ precision: { birth_time_known: 'false' } })],
    ['a non-array provisional_fields', (): Record<string, unknown> =>
      natalWireBody({ precision: { provisional_fields: 'hour' } })],
  ])('fails closed on %s', async (_label, build) => {
    const client = clientReturning(build());
    await expect(client.calculateNatal(INPUT.value)).rejects.toMatchObject({
      code: 'FUFIRE_CONTRACT_ERROR',
    });
  });
});

describe('ETBZ-29 natal boundary: HTTP/transport failures', () => {
  it.each([
    [401, 'FUFIRE_AUTH_FAILED'],
    [403, 'FUFIRE_AUTH_FAILED'],
    [404, 'FUFIRE_CONTRACT_ERROR'],
    [418, 'FUFIRE_CONTRACT_ERROR'],
    [500, 'FUFIRE_SERVER_ERROR'],
    [503, 'FUFIRE_SERVER_ERROR'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const client = clientWith(async () => jsonResponse(status, { error: 'boom' }));
    await expect(client.calculateNatal(INPUT.value)).rejects.toMatchObject({ code });
  });

  it('propagates a 422 rejection with its machine error code', async () => {
    const client = clientWith(async () =>
      jsonResponse(422, { error: 'dst_time_error', message: 'nonexistent local time', request_id: 'x' }),
    );
    await expect(client.calculateNatal(INPUT.value)).rejects.toMatchObject({
      code: 'FUFIRE_REJECTED',
      detailCode: 'dst_time_error',
    });
  });

  it('fails closed on timeout', async () => {
    const client = clientWith(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );
    await expect(client.calculateNatal(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_TIMEOUT' });
  });

  it('fails closed on a network failure', async () => {
    const client = clientWith(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client.calculateNatal(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_NETWORK_ERROR' });
  });

  it('fails closed on invalid JSON', async () => {
    const client = clientWith(async () => new Response('<html>not json</html>', { status: 200 }));
    await expect(client.calculateNatal(INPUT.value)).rejects.toMatchObject({ code: 'FUFIRE_CONTRACT_ERROR' });
  });
});

describe('ETBZ-29: a natal failure never yields a partial HoroscopeModel', () => {
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

  function okWuxingBody(): Record<string, unknown> {
    return {
      wu_xing_vector: { Holz: 1.8, Feuer: 2.5, Erde: 2.0, Metall: 2.0, Wasser: 2.0 },
      dominant_element: 'Feuer',
      basis: 'bazi_four_pillars',
    };
  }

  const RAW_INPUT = {
    displayName: 'Musterkundin A',
    birthDate: '1990-06-15',
    birthTime: '14:30',
    birthTimeKnown: true,
    timezone: 'Europe/Berlin',
    location: { lat: 52.52, lon: 13.405, label: 'Berlin' },
  };

  it('returns a typed FUFIRE_ERROR (never a half-built model) when natal drifts', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/calculate/bazi/natal')) {
        return jsonResponse(200, natalWireBody({ warnings: 'DAY_ANCHOR_UNVERIFIED' }));
      }
      if (url.endsWith('/v1/calculate/bazi/wuxing')) {
        return jsonResponse(200, okWuxingBody());
      }
      return jsonResponse(200, okBaziBody());
    });
    const client = createFufireClient({ config: CONFIG, transport: { fetch: fetchMock } });
    const useCase = createCalculateHoroscopeUseCase({ gateway: client, runtime: CONFIG });

    const outcome = await useCase.execute(RAW_INPUT);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a failed outcome');
    expect(outcome.error.code).toBe('FUFIRE_ERROR');
    expect(outcome).not.toHaveProperty('model');
  });

  it('builds the full model, natal included, when every call answers the contract', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/v1/calculate/bazi/natal')) return jsonResponse(200, natalWireBody());
      if (url.endsWith('/v1/calculate/bazi/wuxing')) return jsonResponse(200, okWuxingBody());
      return jsonResponse(200, okBaziBody());
    });
    const client = createFufireClient({ config: CONFIG, transport: { fetch: fetchMock } });
    const useCase = createCalculateHoroscopeUseCase({ gateway: client, runtime: CONFIG });

    const outcome = await useCase.execute(RAW_INPUT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`expected success, got ${outcome.error.code}`);
    expect(outcome.model.natal.monthCommand.branch).toBe('Wu');
    expect(outcome.model.sourceWarnings).toEqual(['DAY_ANCHOR_UNVERIFIED']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('calls the natal endpoint zero times when the input is locally invalid', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, natalWireBody()));
    const client = createFufireClient({ config: CONFIG, transport: { fetch: fetchMock } });
    const useCase = createCalculateHoroscopeUseCase({ gateway: client, runtime: CONFIG });

    const outcome = await useCase.execute({ ...RAW_INPUT, birthTimeKnown: false, birthTime: '03:00' });

    expect(outcome.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});
