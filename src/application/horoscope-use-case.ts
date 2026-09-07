/**
 * ETBZ-2 / ETBZ-24 — the smallest application use case of the product path:
 * raw/untrusted input in, validated data to FuFirE, HoroscopeModel out.
 *
 * Ordering contract: validation runs FIRST and a failure is returned as a
 * typed result BEFORE the gateway is ever touched. This ordering is the
 * behavioural guarantee that locally invalid input causes zero FuFirE calls
 * (proven by test with a counted transport, not asserted tautologically).
 */

import { validateBirthInput } from '../domain/birth-input.js';
import type { BirthInputIssue, NormalizedBirthInput } from '../domain/birth-input.js';
import type { FufireBaziGateway, FufireBaziSnapshot, WuxingSnapshot } from './ports/fufire-gateway.js';
import { buildHoroscopeModel } from './horoscope-model.js';
import type { HoroscopeModel } from './horoscope-model.js';

export type HoroscopeUseCaseErrorCode = 'BIRTH_INPUT_INVALID' | 'FUFIRE_ERROR' | 'HOROSCOPE_ERROR';

export type HoroscopeUseCaseResult =
  | { readonly ok: true; readonly model: HoroscopeModel }
  | {
      readonly ok: false;
      readonly error:
        | { readonly code: 'BIRTH_INPUT_INVALID'; readonly issues: readonly BirthInputIssue[] }
        | { readonly code: 'FUFIRE_ERROR'; readonly message: string; readonly errorCode: string }
        | { readonly code: 'HOROSCOPE_ERROR'; readonly message: string; readonly errorCode: string };
    };

export interface HoroscopeUseCaseDependencies {
  readonly gateway: Pick<FufireBaziGateway, 'calculateBazi' | 'calculateBaziWuxing'>;
  readonly runtime: Readonly<{ runtimeImage: string; openapiSha256: string }>;
}

export class HoroscopeUseCaseError extends Error {
  readonly code: HoroscopeUseCaseErrorCode;
  constructor(code: HoroscopeUseCaseErrorCode, message: string) {
    super(message);
    this.name = 'HoroscopeUseCaseError';
    this.code = code;
  }
}

/**
 * Executes the ETBZ-24 path. Never throws for validation failures — they come
 * back as the typed `BIRTH_INPUT_INVALID` result with zero gateway activity.
 */
export function createCalculateHoroscopeUseCase(dependencies: HoroscopeUseCaseDependencies) {
  const { gateway, runtime } = dependencies;
  return {
    async execute(rawCandidate: unknown): Promise<HoroscopeUseCaseResult> {
      const validation = validateBirthInput(rawCandidate);
      if (!validation.ok) {
        // Stop here. The gateway is not touched: no call, no credential use,
        // no network side effect for locally invalid input.
        return { ok: false, error: { code: 'BIRTH_INPUT_INVALID', issues: validation.issues } };
      }
      const input: NormalizedBirthInput = validation.value;
      try {
        const bazi: FufireBaziSnapshot = await gateway.calculateBazi(input);
        const wuxing: WuxingSnapshot = await gateway.calculateBaziWuxing(input);
        const model = buildHoroscopeModel(input, bazi, wuxing, runtime);
        return { ok: true, model };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown FuFirE failure';
        const errorCode = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'UNKNOWN';
        const isGatewayError = error instanceof Error && error.name === 'FufireError';
        return {
          ok: false,
          error: isGatewayError
            ? { code: 'FUFIRE_ERROR', message, errorCode }
            : { code: 'HOROSCOPE_ERROR', message, errorCode },
        };
      }
    },
  };
};
