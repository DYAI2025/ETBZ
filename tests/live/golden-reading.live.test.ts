/**
 * ETBZ-25B — the LIVE run: one real external LLM call, one Golden Reading.
 *
 * This is the only code in the repository that talks to a real provider, and it
 * is excluded from the CI gate by `vitest.live.config.ts` on purpose (see that
 * file for why). Run it with `npm run golden-reading`.
 *
 * WHAT IT PROVES WHEN IT PASSES, which is exactly acceptance criteria 1 and 8:
 * a freshly verified no-charge route consumed the real `NarrativeBrief`,
 * returned the required structured output, that output survived BOTH the
 * ETBZ-25A structural gate and the ETBZ-25B semantic QA unchanged, and a
 * complete Golden Reading exists for a human to judge `SELLABLE |
 * NOT_SELLABLE`.
 *
 * WHAT IT DOES WHEN IT FAILS, which matters just as much: it writes the
 * evidence record and the findings anyway, then fails. A blocked candidate is a
 * real result of this slice — the contract says a semantic failure is BLOCKED
 * and is never repaired, never downgraded and never retried on another
 * provider. The correct response to a blocked run is to improve the versioned
 * prompt and produce a NEW candidate, not to soften a gate.
 *
 * The credential is read from the process environment, which the operator
 * supplies. It is never written to any artefact: `assertEvidenceSanitized` is
 * called on the record before it is persisted, with the actual key values, so
 * persisting a leak is not possible by omission.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLlmRoutePlan } from '../../src/app/configuration/llm-routes.js';
import { NarrativeProviderError } from '../../src/application/interpretation/errors.js';
import { generateNarrativeFromPlan } from '../../src/adapters/llm/llm-narrative-provider.js';
import { buildGoldenReading, renderGoldenReadingText } from '../../src/application/interpretation/golden-reading.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildRunEvidence, assertEvidenceSanitized } from '../../src/application/interpretation/narrative-evidence.js';
import type { NarrativeRunEvidence } from '../../src/application/interpretation/narrative-evidence.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import { NARRATIVE_QA_VERSION, runSemanticNarrativeQa } from '../../src/application/interpretation/semantic-qa.js';
import type { NarrativeQaFinding } from '../../src/application/interpretation/semantic-qa.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

const OUT_DIR = resolve(process.cwd(), 'docs/evidence/run');

/** The credential variables this run may read. Values never leave the process. */
const SECRET_VARIABLES = [
  'TOKENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'OPENCODE_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

function secretValues(): readonly string[] {
  return SECRET_VARIABLES.map((name) => process.env[name] ?? '').filter(
    (value) => value.length > 0,
  );
}

/** The real network. Injected, so every other test can stay offline. */
const liveTransport = {
  fetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  },
};

interface LiveOutcome {
  readonly evidence: NarrativeRunEvidence;
  readonly readingText: string | null;
  readonly findings: readonly NarrativeQaFinding[];
}

async function runOnce(
  label: string,
  model: ReturnType<typeof knownTimeModel>,
): Promise<LiveOutcome> {
  const candidateSha = process.env['ETBZ_CANDIDATE_SHA'] ?? 'UNKNOWN_CANDIDATE_SHA';
  // An explicit route deadline, chosen from measurement rather than from the
  // library default: the approved free route produced a complete reading in
  // roughly eight minutes at one time of day and, measured again hours later on
  // the same prompt, was about four times slower on a trivial call. Forty-five
  // minutes is that measured degradation with headroom. It must stay comfortably
  // BELOW the runner timeout in `vitest.live.config.ts`, so a slow provider
  // surfaces as an `LLM_TIMEOUT` attempt record — evidence — and not as a runner
  const plan = buildLlmRoutePlan(process.env, 2_700_000);

  const routeVerdicts = plan.eligibility.map((entry) => ({
    routeId: entry.routeId,
    order: entry.order,
    eligible: entry.eligible,
    ineligibleReason: entry.ineligibleReason,
    baseUrl: entry.baseUrl,
    model: entry.model,
    noChargeBasis: entry.noChargeBasis,
    statement: entry.statement,
  }));

  const chain = buildNarrativeChain(model);

  let result;
  try {
    result = await generateNarrativeFromPlan(chain.brief, plan, liveTransport);
  } catch (error) {
    // A refused run is a real outcome of this slice and must leave evidence.
    // The attempt ledger travels on the error precisely so that the failing
    // case is not the one case with nothing to review.
    if (error instanceof NarrativeProviderError) {
      console.log(`\n===== ETBZ-25B LIVE RUN (${label}) — PROVIDER REFUSED =====`);
      console.log(`code     : ${error.code}`);
      console.log(`message  : ${error.message}`);
      console.log(`attempts : ${JSON.stringify(error.attempts, null, 1)}`);
      console.log(
        `verdicts : ${routeVerdicts
          .map((v) => `${v.routeId}=${v.eligible ? 'eligible' : (v.ineligibleReason ?? 'ineligible')}`)
          .join(', ')}`,
      );
    }
    throw error;
  }

  // The structural gate. It re-derives the chain from the HoroscopeModel, so a
  // pass here is a statement about the chart, not about the brief we handed out.
  const report = buildReportModel({
    model,
    brief: chain.brief,
    providerOutput: result.providerOutput,
  });

  const qa = runSemanticNarrativeQa(report);
  const reading = qa.status === 'PASS' ? buildGoldenReading(report, qa) : null;
  const readingText = reading === null ? null : renderGoldenReadingText(reading);

  const evidence = buildRunEvidence({
    candidateSha,
    briefStructuralHash: chain.brief.structuralHash,
    promptStructuralHash: result.prompt.promptStructuralHash,
    promptVersion: result.prompt.promptVersion,
    policyVersion: result.prompt.policyVersion,
    qaVersion: NARRATIVE_QA_VERSION,
    routeVerdicts,
    attempts: result.attempts,
    acceptedRouteId: result.acceptedRouteId,
    acceptedModel: result.acceptedModel,
    reportStructuralHash: report.structuralHash,
    structuralGate: 'PASS',
    semanticQaStatus: qa.status,
    semanticQaFindings: qa.findings,
    goldenReadingStatus:
      reading === null ? 'BLOCKED' : 'CANDIDATE_READY_FOR_HUMAN_REVIEW',
    goldenReadingHash: reading?.structuralHash ?? null,
    billableCostBasis:
      'Zero by route eligibility, not by invoice: the accepted route is a provider-published zero-price model (explicit free marker in the model id) and none of the approved routes returns a per-call cost field. No billing-API readback exists for this route.',
  });

  // Refuse to persist anything that carries a credential or a personal datum.
  // Called with the ACTUAL key values, so this is a measurement, not a promise.
  assertEvidenceSanitized(evidence, secretValues(), [
    model.displayName,
    model.birth.date,
  ]);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, `etbz-25b-${label}-evidence.json`), evidence.canonicalJson, 'utf8');
  if (readingText !== null) {
    writeFileSync(resolve(OUT_DIR, `etbz-25b-${label}-golden-reading.txt`), readingText, 'utf8');
  }

  console.log(`\n===== ETBZ-25B LIVE RUN (${label}) =====`);
  console.log(`candidate SHA : ${candidateSha}`);
  console.log(`brief hash    : ${chain.brief.structuralHash}`);
  console.log(`prompt        : ${result.prompt.promptVersion} / ${result.prompt.promptStructuralHash}`);
  console.log(`route         : ${result.acceptedRouteId} (${result.acceptedModel})`);
  console.log(`attempts      : ${JSON.stringify(result.attempts, null, 1)}`);
  console.log(`report hash   : ${report.structuralHash}`);
  console.log(`semantic QA   : ${qa.status}`);
  for (const finding of qa.findings) {
    console.log(`  BLOCKED ${finding.code} | ${finding.themeId ?? '-'} | ${finding.surface ?? '-'} | ${finding.term ?? '-'}`);
    console.log(`          ${finding.message}`);
  }
  console.log(`evidence hash : ${evidence.structuralHash}`);
  if (readingText !== null) {
    console.log(`\n${readingText}`);
  }

  return { evidence, readingText, findings: qa.findings };
}

describe('ETBZ-25B live provider run', () => {
  it('produces a Golden Reading from a real no-charge route (known-time chart)', async () => {
    const outcome = await runOnce('known-time', knownTimeModel());

    expect(outcome.evidence.structuralGate).toBe('PASS');
    expect(
      outcome.findings,
      `semantic QA blocked the candidate:\n${outcome.findings.map((f) => `  ${f.code}: ${f.message}`).join('\n')}`,
    ).toEqual([]);
    expect(outcome.evidence.goldenReadingStatus).toBe('CANDIDATE_READY_FOR_HUMAN_REVIEW');
    expect(outcome.readingText).not.toBeNull();
    // Every attempt of a run under this contract is free. Asserted rather than
    // assumed, so a future route that reported a cost would fail here.
    for (const attempt of outcome.evidence.attempts) {
      expect(attempt.billableCostEur).toBe(0);
    }
  });

  it('preserves unknown-time qualification through a real run', async () => {
    const outcome = await runOnce('unknown-time', unknownTimeModel());

    expect(
      outcome.findings,
      `semantic QA blocked the candidate:\n${outcome.findings.map((f) => `  ${f.code}: ${f.message}`).join('\n')}`,
    ).toEqual([]);
    expect(outcome.readingText).not.toBeNull();
    expect(outcome.readingText).toContain('Geburtszeit: nicht bekannt');
    expect(outcome.readingText).toContain('vorläufig');
  });
});
