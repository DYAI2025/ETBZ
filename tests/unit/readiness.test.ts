import { describe, expect, it } from 'vitest';
import { loadEtbzConfig } from '../../src/app/configuration/index.js';
import {
  ETBZ9_READINESS_CAPABILITIES,
  evaluateReadiness,
  readinessHttpStatus,
} from '../../src/app/readiness/index.js';

describe('AC3: ETBZ-9 activates exactly one readiness capability', () => {
  it('declares exactly the `configuration` capability', () => {
    expect([...ETBZ9_READINESS_CAPABILITIES]).toEqual(['configuration']);
  });

  it('reports ready for a valid foundation configuration', () => {
    const report = evaluateReadiness(
      loadEtbzConfig({ ETBZ_ENV: 'test', LOG_LEVEL: 'info' }),
    );

    expect(report.status).toBe('ready');
    expect(readinessHttpStatus(report)).toBe(200);
    expect(report.capabilities).toEqual([{ name: 'configuration', status: 'ok' }]);
  });

  it('fails closed when mandatory configuration is missing', () => {
    const report = evaluateReadiness(loadEtbzConfig({ LOG_LEVEL: 'info' }));

    expect(report.status).toBe('not_ready');
    expect(readinessHttpStatus(report)).toBe(503);
    expect(report.capabilities[0]?.status).toBe('fail');
    expect(report.capabilities[0]?.issues).toEqual([
      {
        variable: 'ETBZ_ENV',
        code: 'missing',
        expectation: 'one of: local | development | test | staging | production',
      },
    ]);
  });
});
