import { describe, expect, it } from 'vitest';
import { normalizeForMatch } from '../../src/application/interpretation/chart-symbol-lexicon.js';
import { NarrativeQaError } from '../../src/application/interpretation/errors.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import type { ReportModel } from '../../src/application/interpretation/report-model.js';
import {
  NARRATIVE_QA_GATES,
  NARRATIVE_QA_POLICY,
  NARRATIVE_QA_VERSION,
  assertSemanticNarrativeQa,
  runSemanticNarrativeQa,
} from '../../src/application/interpretation/semantic-qa.js';
import type {
  NarrativeQaFinding,
  NarrativeQaGate,
  NarrativeQaPolicy,
} from '../../src/application/interpretation/semantic-qa.js';
import type { HoroscopeModel } from '../../src/application/horoscope-model.js';
import {
  validKnownTimeAnswer,
  validUnknownTimeAnswer,
} from '../support/llmNarrativeFixture.js';
import type { FixtureAnswer, FixtureSection } from '../support/llmNarrativeFixture.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25B Q — the semantic Narrative QA, from the positive and structural side.
 *
 * The gate-by-gate refusals live in the negative suite. What is asserted HERE is
 * everything a refusal test cannot prove on its own, and without which a green
 * negative suite would be worthless:
 *
 *  - the verified baseline answers actually PASS, so the gates are not simply
 *    always red and every negative case really does isolate one mutation;
 *  - the verdict is PURE — the same report in, the same findings and the same
 *    structural hash out, and the report itself untouched;
 *  - the verdict is BOUND to one exact report and one exact brief, so a PASS
 *    can never be waved at a different reading;
 *  - `gatesRun` names all five gates, which is the only mechanism by which a
 *    gate that silently stopped running is detectable at all;
 *  - `assertSemanticNarrativeQa` is genuinely fail-closed, and the error carries
 *    EVERY finding rather than the first;
 *  - the policy thresholds are LOAD-BEARING: tightening one of them, and
 *    nothing else, turns the very same report BLOCKED. A threshold no test can
 *    move is decoration, and decoration is what this slice exists to refuse.
 *
 * Every blocked case below starts from a fixture answer that is asserted to pass
 * in this same file and changes exactly one thing — one sentence, or one policy
 * field — so each assertion attributes the refusal to that one change.
 */

/** The five gate ids, written out here so a src-side removal fails loudly. */
const EXPECTED_GATES: readonly NarrativeQaGate[] = [
  'fact_role',
  'provisionality',
  'specificity',
  'synthesis_depth',
  'product_safety',
];

function reportFor(model: HoroscopeModel, answer: FixtureAnswer): ReportModel {
  const chain = buildNarrativeChain(model);
  // The structural gate runs first and re-derives the chain from the model, so a
  // report existing at all already proves the answer survived ETBZ-25A.
  return buildReportModel({
    model,
    brief: chain.brief,
    providerOutput: {
      providerId: 'test',
      briefStructuralHash: chain.brief.structuralHash,
      sections: answer.sections,
    },
  });
}

function sectionOf(answer: FixtureAnswer, themeId: string): FixtureSection {
  const section = answer.sections.find((candidate) => candidate.themeId === themeId);
  if (section === undefined) {
    throw new Error(`fixture defect: the valid answer carries no section "${themeId}"`);
  }
  return section;
}

/**
 * Accepts the narrowest shape both sources satisfy.
 *
 * `NarrativeQaResult.findings` are full `NarrativeQaFinding`s, while the ones
 * reachable through `NarrativeQaError.findings` are typed as the `code`-only
 * `NarrativeQaFindingLike` — the error module declares that shape itself so it
 * can depend on nothing. Comparing codes across both therefore has to ask for
 * the code alone rather than assert one type into the other.
 */
function codesOf(findings: readonly Readonly<{ code: string }>[]): readonly string[] {
  return findings.map((finding) => finding.code);
}

/** `NARRATIVE_QA_POLICY` with exactly the named fields moved. */
function policyWith(overrides: Partial<NarrativeQaPolicy>): NarrativeQaPolicy {
  return { ...NARRATIVE_QA_POLICY, ...overrides };
}

/**
 * ONE change to the valid known-time answer: the day master is called a branch.
 *
 * `Xin` is the day stem of this chart and nothing cited makes it an Erdzweig, so
 * the role gate must refuse it. Everything else — the citations, the digits, the
 * method vocabulary — is left exactly as the verified baseline has it, which is
 * what lets the resulting finding be attributed to this sentence.
 */
function roleMismatchAnswer(): FixtureAnswer {
  const answer = validKnownTimeAnswer();
  const section = sectionOf(answer, 'primary.self_role');
  const mutated = section.prose.replace('Der Tagesmeister Xin', 'Der Erdzweig Xin');
  if (mutated === section.prose) {
    // A mutation that silently did nothing would leave this "negative" test
    // asserting the baseline, which is the classic way such a test goes green
    // for the wrong reason.
    throw new Error('fixture defect: the role mutation matched nothing in the baseline prose');
  }
  section.prose = mutated;
  return answer;
}

/**
 * ONE change to the valid known-time answer: a single paragraph is replaced by a
 * generic one.
 *
 * The replacement cites the same facts and names none of them, and it opens with
 * a canonical Barnum phrase. It therefore trips two specificity findings from
 * one mutation — which is precisely the material needed to prove that the error
 * carries every finding and not merely the first.
 */
function genericProseAnswer(): FixtureAnswer {
  const answer = validKnownTimeAnswer();
  const section = sectionOf(answer, 'primary.self_role');
  section.prose =
    'Tief in dir liegt vieles noch offen, und du wägst lange ab, bevor du dich festlegst.';
  return answer;
}

const KNOWN_REPORT = reportFor(knownTimeModel(), validKnownTimeAnswer());
const UNKNOWN_REPORT = reportFor(unknownTimeModel(), validUnknownTimeAnswer());
const ROLE_MISMATCH_REPORT = reportFor(knownTimeModel(), roleMismatchAnswer());
const GENERIC_PROSE_REPORT = reportFor(knownTimeModel(), genericProseAnswer());

describe('ETBZ-25B Q1: the verified baseline answers pass every gate', () => {
  it('passes the known-time answer with no finding at all', () => {
    const result = runSemanticNarrativeQa(KNOWN_REPORT);

    // Asserted as the empty ARRAY, not as a count: a wrong-but-nonzero findings
    // list would then name itself in the failure output.
    expect(result.findings).toEqual([]);
    expect(result.status).toBe('PASS');
    expect(result.qaVersion).toBe(NARRATIVE_QA_VERSION);
    expect(result.qaVersion).toBe('etbz-25b.narrative-qa.v1');
  });

  it('passes the unknown-time answer, whose provisional section takes the note path', () => {
    // This chart's hour pillar is provisional, so the provisionality gate is
    // actually exercised here rather than skipped as it is on the known chart.
    const provisionalSections = UNKNOWN_REPORT.interpretation.filter(
      (section) => section.citesProvisionalFacts,
    );
    expect(provisionalSections.length).toBeGreaterThanOrEqual(1);
    expect(UNKNOWN_REPORT.uncertainty.providerNotes.length).toBeGreaterThanOrEqual(1);

    const result = runSemanticNarrativeQa(UNKNOWN_REPORT);

    expect(result.findings).toEqual([]);
    expect(result.status).toBe('PASS');
  });

  it('reports the policy it actually applied, so a PASS states its own floor', () => {
    const result = runSemanticNarrativeQa(KNOWN_REPORT);

    expect(result.policy).toEqual(NARRATIVE_QA_POLICY);
  });
});

describe('ETBZ-25B Q2: the verdict is pure', () => {
  it('returns an identical result, hash included, when called twice on one report', () => {
    const first = runSemanticNarrativeQa(KNOWN_REPORT);
    const second = runSemanticNarrativeQa(KNOWN_REPORT);

    expect(second).toEqual(first);
    expect(second.structuralHash).toBe(first.structuralHash);
    // Serialized comparison catches a key-ORDER difference, which `toEqual`
    // would accept and a structural hash would not.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('returns identical findings in identical order when called twice on a blocked report', () => {
    const first = runSemanticNarrativeQa(GENERIC_PROSE_REPORT);
    const second = runSemanticNarrativeQa(GENERIC_PROSE_REPORT);

    expect(first.status).toBe('BLOCKED');
    expect(second.findings).toEqual(first.findings);
    expect(second.structuralHash).toBe(first.structuralHash);
  });

  it('derives the same hash from two independently built reports of the same chart', () => {
    // Separate HoroscopeModel, separate chain, separate ReportModel: nothing of
    // the first run may survive into the second.
    const again = reportFor(knownTimeModel(), validKnownTimeAnswer());

    expect(runSemanticNarrativeQa(again).structuralHash).toBe(
      runSemanticNarrativeQa(KNOWN_REPORT).structuralHash,
    );
  });

  it('leaves the report untouched, so a verdict can never be a mutation', () => {
    const before = JSON.stringify(KNOWN_REPORT);

    runSemanticNarrativeQa(KNOWN_REPORT);

    expect(JSON.stringify(KNOWN_REPORT)).toBe(before);
  });

  it('gives two different readings two different hashes (the hash is not a constant)', () => {
    // Positive control for the three equalities above: they would also hold if
    // the hash were the same string for every input.
    const known = runSemanticNarrativeQa(KNOWN_REPORT);
    const unknown = runSemanticNarrativeQa(UNKNOWN_REPORT);

    expect(unknown.structuralHash).not.toBe(known.structuralHash);
  });
});

describe('ETBZ-25B Q3: the verdict is bound to one exact report and brief', () => {
  it('carries the structural hash of the report it judged', () => {
    const result = runSemanticNarrativeQa(KNOWN_REPORT);

    expect(result.reportStructuralHash).toBe(KNOWN_REPORT.structuralHash);
  });

  it('carries the brief hash the report was built against', () => {
    const result = runSemanticNarrativeQa(KNOWN_REPORT);

    expect(result.briefStructuralHash).toBe(KNOWN_REPORT.provenance.briefStructuralHash);
  });

  it('binds the unknown-time verdict to the unknown-time report, not to the other one', () => {
    // Without this pair the two equalities above would also hold if every
    // verdict quoted the same two hashes.
    const result = runSemanticNarrativeQa(UNKNOWN_REPORT);

    expect(result.reportStructuralHash).toBe(UNKNOWN_REPORT.structuralHash);
    expect(result.briefStructuralHash).toBe(UNKNOWN_REPORT.provenance.briefStructuralHash);
    expect(UNKNOWN_REPORT.structuralHash).not.toBe(KNOWN_REPORT.structuralHash);
    expect(UNKNOWN_REPORT.provenance.briefStructuralHash).not.toBe(
      KNOWN_REPORT.provenance.briefStructuralHash,
    );
  });

  it('keeps the binding on a BLOCKED verdict, where it matters most', () => {
    const result = runSemanticNarrativeQa(GENERIC_PROSE_REPORT);

    expect(result.status).toBe('BLOCKED');
    expect(result.reportStructuralHash).toBe(GENERIC_PROSE_REPORT.structuralHash);
    expect(result.briefStructuralHash).toBe(GENERIC_PROSE_REPORT.provenance.briefStructuralHash);
  });
});

describe('ETBZ-25B Q4: every gate is declared to have run', () => {
  it('declares exactly the five gates of this slice, in their documented order', () => {
    expect(NARRATIVE_QA_GATES).toEqual(EXPECTED_GATES);
    expect(NARRATIVE_QA_GATES).toHaveLength(5);
  });

  it('lists every declared gate in gatesRun on a PASS', () => {
    const result = runSemanticNarrativeQa(KNOWN_REPORT);

    // The whole point of the field: a gate that quietly stopped running would
    // be missing here, and a PASS that silently skipped a gate is not a PASS.
    expect(result.gatesRun).toEqual(EXPECTED_GATES);
    expect([...result.gatesRun].sort()).toEqual([...EXPECTED_GATES].sort());
  });

  it('lists every declared gate in gatesRun on a BLOCKED verdict too (no early exit)', () => {
    const result = runSemanticNarrativeQa(GENERIC_PROSE_REPORT);

    expect(result.status).toBe('BLOCKED');
    expect(result.gatesRun).toEqual(EXPECTED_GATES);
  });

  it('attributes every finding it raises to one of the declared gates', () => {
    const findings: readonly NarrativeQaFinding[] = [
      ...runSemanticNarrativeQa(GENERIC_PROSE_REPORT).findings,
      ...runSemanticNarrativeQa(ROLE_MISMATCH_REPORT).findings,
    ];

    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(EXPECTED_GATES).toContain(finding.gate);
      expect(finding.severity).toBe('blocking');
    }
  });
});

describe('ETBZ-25B Q5: assertSemanticNarrativeQa is fail-closed', () => {
  it('returns the very result runSemanticNarrativeQa produced when the reading passes', () => {
    const asserted = assertSemanticNarrativeQa(KNOWN_REPORT);

    expect(asserted).toEqual(runSemanticNarrativeQa(KNOWN_REPORT));
    expect(asserted.status).toBe('PASS');
  });

  it('does not throw on the unknown-time baseline either (the guard is not always red)', () => {
    expect(() => assertSemanticNarrativeQa(UNKNOWN_REPORT)).not.toThrow();
  });

  it('throws NarrativeQaError carrying EVERY finding when one paragraph goes generic', () => {
    const reported = runSemanticNarrativeQa(GENERIC_PROSE_REPORT);
    // One mutation, two findings: an error carrying only the first would still
    // look fail-closed while hiding half of what a prompt author has to fix.
    expect(codesOf(reported.findings)).toEqual(['QA_UNANCHORED_PROSE', 'QA_BARNUM_PHRASE']);

    try {
      assertSemanticNarrativeQa(GENERIC_PROSE_REPORT);
    } catch (error) {
      if (!(error instanceof NarrativeQaError)) {
        throw error;
      }
      expect(error.name).toBe('NarrativeQaError');
      expect(error.code).toBe('NARRATIVE_QA_BLOCKED');
      expect(error.findings).toEqual(reported.findings);
      expect(codesOf(error.findings)).toEqual(['QA_UNANCHORED_PROSE', 'QA_BARNUM_PHRASE']);
      expect(error.message).toContain('2 finding(s)');
      return;
    }
    expect.unreachable('expected the blocked candidate to be refused with NarrativeQaError');
  });

  it('refuses a mislabelled chart symbol and points the finding at the exact span', () => {
    const result = runSemanticNarrativeQa(ROLE_MISMATCH_REPORT);

    expect(result.status).toBe('BLOCKED');
    expect(codesOf(result.findings)).toEqual(['QA_FACT_ROLE_MISMATCH']);
    const [finding] = result.findings;
    if (finding === undefined) {
      expect.unreachable('expected exactly one role finding');
      return;
    }
    expect(finding.gate).toBe('fact_role');
    expect(finding.themeId).toBe('primary.self_role');
    expect(finding.surface).toBe('prose');
    expect(finding.term).toBe('xin');
    expect(finding.factId).toBe('chart.dayMaster.stem');
    // A refusal nobody can locate is barely better than no refusal: the span
    // must index the NORMALIZED prose and cut out the symbol itself.
    const section = ROLE_MISMATCH_REPORT.interpretation.find(
      (candidate) => candidate.themeId === 'primary.self_role',
    );
    if (section === undefined || finding.span === null) {
      expect.unreachable('expected a located finding on the self-role section');
      return;
    }
    const normalized = normalizeForMatch(section.prose);
    expect(normalized.slice(finding.span.start, finding.span.end)).toBe('xin');
    expect(finding.message).toContain('branch');
  });
});

describe('ETBZ-25B Q6: the policy thresholds are load-bearing', () => {
  it('passes the same report under the shipped policy (the thresholds are reachable)', () => {
    // Positive control for every tightening below: each one starts from THIS.
    expect(runSemanticNarrativeQa(KNOWN_REPORT, NARRATIVE_QA_POLICY).status).toBe('PASS');
  });

  it('blocks the same report when only minDistinctChartTermsInProse is raised out of reach', () => {
    const result = runSemanticNarrativeQa(
      KNOWN_REPORT,
      policyWith({ minDistinctChartTermsInProse: 99 }),
    );

    expect(result.status).toBe('BLOCKED');
    expect(codesOf(result.findings)).toEqual(['QA_INSUFFICIENT_CHART_DEPENDENCE']);
    const [finding] = result.findings;
    if (finding === undefined) {
      expect.unreachable('expected the report-wide chart-dependence finding');
      return;
    }
    expect(finding.gate).toBe('specificity');
    // Report-wide by nature, so it names no section and no surface.
    expect(finding.themeId).toBeNull();
    expect(finding.surface).toBeNull();
    expect(finding.message).toContain('the policy floor is 99');
  });

  it('blocks the same report when only minSynthesisSections is raised out of reach', () => {
    const result = runSemanticNarrativeQa(KNOWN_REPORT, policyWith({ minSynthesisSections: 99 }));

    expect(result.status).toBe('BLOCKED');
    expect(codesOf(result.findings)).toEqual(['QA_SYNTHESIS_INSUFFICIENT']);
    const [finding] = result.findings;
    if (finding === undefined) {
      expect.unreachable('expected the synthesis-depth finding');
      return;
    }
    expect(finding.gate).toBe('synthesis_depth');
    expect(finding.themeId).toBeNull();
  });

  it('blocks the same report when only minSynthesisRolesInProse is raised out of reach', () => {
    // A different lever on the same gate: no paragraph can name 99 distinct
    // fact roles, so no section qualifies as synthesis any more.
    const result = runSemanticNarrativeQa(
      KNOWN_REPORT,
      policyWith({ minSynthesisRolesInProse: 99 }),
    );

    expect(result.status).toBe('BLOCKED');
    expect(codesOf(result.findings)).toEqual(['QA_SYNTHESIS_INSUFFICIENT']);
    expect(result.findings[0]?.message).toContain('at least 99 distinct fact roles');
  });

  it('stops seeing a mislabelled symbol when only roleWindowChars is narrowed to zero', () => {
    // The role gate reads the words STANDING NEXT TO a symbol. With no window
    // there is nothing to read, and the same mislabelled paragraph passes —
    // which is what makes the window a threshold rather than a comment.
    const blocked = runSemanticNarrativeQa(ROLE_MISMATCH_REPORT, NARRATIVE_QA_POLICY);
    const unseen = runSemanticNarrativeQa(ROLE_MISMATCH_REPORT, policyWith({ roleWindowChars: 0 }));

    expect(blocked.status).toBe('BLOCKED');
    expect(unseen.status).toBe('PASS');
    expect(unseen.findings).toEqual([]);
  });

  it('records the applied policy and hashes it, so two floors cannot share one verdict', () => {
    const tightened = policyWith({ minDistinctChartTermsInProse: 99 });

    const shipped = runSemanticNarrativeQa(KNOWN_REPORT, NARRATIVE_QA_POLICY);
    const strict = runSemanticNarrativeQa(KNOWN_REPORT, tightened);

    expect(strict.policy).toEqual(tightened);
    expect(strict.policy).not.toEqual(shipped.policy);
    // The policy is part of the hashed core: the same report judged under a
    // different floor is a different verdict and must not reuse its hash.
    expect(strict.structuralHash).not.toBe(shipped.structuralHash);
    expect(strict.reportStructuralHash).toBe(shipped.reportStructuralHash);
  });
});
