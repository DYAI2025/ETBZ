import { describe, expect, it } from 'vitest';
import { composeDeterministicNarrative } from '../../src/application/interpretation/deterministic-narrative-provider.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import type { NarrativeBrief } from '../../src/application/interpretation/narrative-brief.js';
import { buildReportModel } from '../../src/application/interpretation/report-model.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25A-R2 — the narrative-provider boundary carries no ranking signal.
 *
 * WHAT THIS GUARDS. `NarrativeProvider.generate()` receives a NarrativeBrief and
 * nothing else. Until this repair the brief's theme structures carried
 * `supportCount`, which was `factIds.length` and only ever that. The
 * deterministic provider never ranked by it — but a future provider may be a
 * language model, and a number sitting beside a theme is precisely what such a
 * consumer reads as "this theme matters more". A larger structural fact count is
 * not greater thematic importance: it records how many rows FuFirE happened to
 * state, and `theme.pillar.day` holding nineteen fact references while
 * `theme.wuXing.Erde` holds one says nothing about the chart.
 *
 * So the field is gone, and these tests hold the line as a property of the SHAPE
 * rather than of a provider's good behaviour. Two independent scans, because
 * each catches what the other misses:
 *
 *   name scan     no field whose name contains supportCount, rank, score,
 *                 prominence, confidence or importance — catches a
 *                 STRING-valued `rank: 'high'` that the numeric scan cannot see.
 *   numeric scan  no number-typed value ANYWHERE in theme metadata — catches a
 *                 count that was merely RENAMED, e.g. `factTally: 19`, which the
 *                 name scan cannot see.
 *
 * WHAT THIS DELIBERATELY DOES NOT GUARD, so the rule is not over-applied:
 *
 *   brief.facts                    FuFirE's own chart facts, Wu Xing Qi weights
 *                                  included. Those are the source's stated
 *                                  measurements; withholding them would be the
 *                                  real data loss, and the last group below
 *                                  asserts they still travel intact.
 *   brief.constraints.specificity  the ETBZ-25 product contract for report SIZE
 *                                  (3 section floor, 5 section raw ceiling).
 *                                  Those numbers describe the artefact a
 *                                  provider must produce, not the importance of
 *                                  any theme.
 *
 * Nothing here needs a model, a credential or a network. The brief is built by
 * the ordinary deterministic chain, which is the whole point: the property is
 * checkable long before any creative provider exists.
 */

/**
 * Substrings a theme-metadata field name must never contain. Matched
 * case-insensitively and as substrings, so `factSupportCount`, `themeScore` and
 * `rankOrder` are caught alongside the bare spellings.
 */
const FORBIDDEN_SIGNAL_WORDS = [
  'supportcount',
  'rank',
  'score',
  'prominence',
  'confidence',
  'importance',
] as const;

interface Finding {
  readonly path: string;
  readonly detail: string;
}

/**
 * Walks every entry of a JSON-shaped value, reporting each array element and
 * each object property with the path it was reached by.
 */
function visit(
  node: unknown,
  path: string,
  onEntry: (entryPath: string, key: string | null, value: unknown) => void,
): void {
  if (Array.isArray(node)) {
    node.forEach((item: unknown, index: number) => {
      const itemPath = `${path}[${String(index)}]`;
      onEntry(itemPath, null, item);
      visit(item, itemPath, onEntry);
    });
    return;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      const keyPath = `${path}.${key}`;
      onEntry(keyPath, key, value);
      visit(value, keyPath, onEntry);
    }
  }
}

function findSignalNamedFields(node: unknown, path: string): Finding[] {
  const findings: Finding[] = [];
  visit(node, path, (entryPath, key) => {
    if (key === null) return;
    const normalized = key.toLowerCase();
    for (const word of FORBIDDEN_SIGNAL_WORDS) {
      if (normalized.includes(word)) {
        findings.push({ path: entryPath, detail: `field name contains "${word}"` });
      }
    }
  });
  return findings;
}

function findNumericValues(node: unknown, path: string): Finding[] {
  const findings: Finding[] = [];
  visit(node, path, (entryPath, _key, value) => {
    if (typeof value === 'number' || typeof value === 'bigint') {
      findings.push({ path: entryPath, detail: `${typeof value} value ${String(value)}` });
    }
  });
  return findings;
}

/**
 * Exactly the THEME METADATA a provider can read off the brief.
 *
 * `brief.facts` and `brief.constraints.specificity` are excluded on purpose —
 * see the file docblock. Everything else that describes a theme is in here.
 */
function themeMetadataOf(brief: NarrativeBrief): Record<string, unknown> {
  return {
    primaryThemes: brief.primaryThemes,
    candidateThemes: brief.candidateThemes,
    candidateEdges: brief.candidateEdges,
    narratableThemeIds: brief.constraints.narratableThemeIds,
    candidateThemeIds: brief.constraints.candidateThemeIds,
  };
}

const KNOWN_MODEL = knownTimeModel();
const KNOWN_CHAIN = buildNarrativeChain(KNOWN_MODEL);
const UNKNOWN_CHAIN = buildNarrativeChain(unknownTimeModel());

const CHARTS = [
  ['known-time chart', KNOWN_CHAIN.brief],
  ['unknown-time chart', UNKNOWN_CHAIN.brief],
] as const;

/** A mutable deep copy of the theme metadata, for the canary group. */
function mutableThemeMetadata(): Record<string, unknown> {
  return structuredClone(themeMetadataOf(KNOWN_CHAIN.brief));
}

/** The first candidate theme of that copy, as a plain bag of properties. */
function firstCandidate(metadata: Record<string, unknown>): Record<string, unknown> {
  const themes = metadata['candidateThemes'];
  if (!Array.isArray(themes)) {
    throw new Error('fixture defect: candidateThemes is not an array');
  }
  const first: unknown = themes[0];
  if (typeof first !== 'object' || first === null) {
    throw new Error('fixture defect: the clone has no candidate theme to pollute');
  }
  return first as Record<string, unknown>;
}

describe('ETBZ-25A-R2 I1: the provider-visible theme metadata names no ranking signal', () => {
  it.each(CHARTS)(
    'carries no supportCount, rank, score, prominence, confidence or importance field (%s)',
    (_label, brief) => {
      expect(findSignalNamedFields(themeMetadataOf(brief), 'brief')).toEqual([]);
    },
  );

  it.each(CHARTS)('carries no number-typed value at all (%s)', (_label, brief) => {
    // The stronger property, and the one the repair actually bought: a count
    // cannot be smuggled back under a different name, because there is no
    // number-shaped hole for it to sit in.
    expect(findNumericValues(themeMetadataOf(brief), 'brief')).toEqual([]);
  });

  it('publishes the same fields for a one-fact theme as for a nineteen-fact theme', () => {
    const themes = KNOWN_CHAIN.brief.candidateThemes;
    const bySize = [...themes].sort((left, right) => left.factIds.length - right.factIds.length);
    const smallest = bySize[0];
    const largest = bySize[bySize.length - 1];

    expect(smallest).toBeDefined();
    expect(largest).toBeDefined();
    if (smallest === undefined || largest === undefined) return;
    // Not a tautology about object literals: it is the statement that the
    // metadata SHAPE encodes nothing about size. A provider comparing these two
    // structures field by field finds one difference — which facts they name.
    expect(Object.keys(smallest).sort(), smallest.id).toEqual(Object.keys(largest).sort());
    expect(largest.factIds.length).toBeGreaterThan(smallest.factIds.length);
  });

  it('exposes no ranking signal on the primary themes either', () => {
    const [first] = KNOWN_CHAIN.brief.primaryThemes;

    expect(first).toBeDefined();
    // The exhaustive field list, restated at the boundary the provider actually
    // sees rather than only at the projection's own unit test.
    expect(Object.keys(first ?? {}).sort()).toEqual([
      'containsProvisionalFacts',
      'factIds',
      'family',
      'id',
      'methodIds',
      'provisionalFactIds',
      'sourceThemeIds',
      'sourceThemeKinds',
      'sourceThemeLabels',
      'statement',
    ]);
  });

  it('exposes no ranking signal on the candidate themes or their edges', () => {
    const [theme] = KNOWN_CHAIN.brief.candidateThemes;
    const [edge] = KNOWN_CHAIN.brief.candidateEdges;

    expect(theme).toBeDefined();
    expect(edge).toBeDefined();
    expect(Object.keys(theme ?? {}).sort()).toEqual([
      'containsProvisionalFacts',
      'factIds',
      'id',
      'kind',
      'label',
      'labelFactId',
      'labelFrom',
      'provisionalFactIds',
    ]);
    expect(Object.keys(edge ?? {}).sort()).toEqual([
      'from',
      'kind',
      'sharedFactIds',
      'to',
    ]);
  });
});

describe('ETBZ-25A-R2 I2: the counterexample — materially different fact counts, no published count', () => {
  it('really does group wildly different numbers of facts', () => {
    // Measured on this fixture: candidate themes span 1 fact
    // (theme.tenGod.DirectWealth, theme.wuXing.Erde) to 19 (theme.pillar.day);
    // primary themes span 4 (seasonal_anchor) to 69 (positional_context). If
    // cardinality were a salience signal, THIS is the spread a provider would
    // be reading as a nineteen-fold difference in importance.
    const candidateCounts = KNOWN_CHAIN.brief.candidateThemes.map((theme) => theme.factIds.length);
    const primaryCounts = KNOWN_CHAIN.brief.primaryThemes.map((theme) => theme.factIds.length);

    expect(Math.min(...candidateCounts)).toBe(1);
    expect(Math.max(...candidateCounts)).toBe(19);
    expect(Math.min(...primaryCounts)).toBe(4);
    expect(Math.max(...primaryCounts)).toBe(69);
    // Stated as a property too, so the point survives a fixture change: the
    // spread is material, not a rounding difference.
    expect(Math.max(...candidateCounts)).toBeGreaterThanOrEqual(
      Math.min(...candidateCounts) * 5,
    );
    expect(Math.max(...primaryCounts)).toBeGreaterThanOrEqual(Math.min(...primaryCounts) * 5);
  });

  it('publishes the fact REFERENCES for every one of them, losing no evidence', () => {
    const known = new Set(KNOWN_CHAIN.brief.facts.map((fact) => fact.id));

    for (const theme of KNOWN_CHAIN.brief.candidateThemes) {
      expect(theme.factIds.length, theme.id).toBeGreaterThan(0);
      for (const factId of theme.factIds) {
        expect(known, `${theme.id} -> ${factId}`).toContain(factId);
      }
    }
    // Nothing is dropped between the two levels either: the primary themes'
    // fact union is exactly the candidates'. The count went away; the evidence
    // did not.
    const candidateUnion = [
      ...new Set(KNOWN_CHAIN.brief.candidateThemes.flatMap((theme) => theme.factIds)),
    ].sort();
    const primaryUnion = [
      ...new Set(KNOWN_CHAIN.brief.primaryThemes.flatMap((theme) => theme.factIds)),
    ].sort();
    expect(primaryUnion).toEqual(candidateUnion);
  });

  it('keeps every traceability relation the report and its lineage rest on', () => {
    for (const primary of KNOWN_CHAIN.brief.primaryThemes) {
      expect(primary.sourceThemeIds.length, primary.id).toBeGreaterThan(0);
      expect(primary.sourceThemeLabels.length, primary.id).toBe(primary.sourceThemeIds.length);
      expect(primary.sourceThemeKinds.length, primary.id).toBeGreaterThan(0);
      expect(primary.methodIds.length, primary.id).toBeGreaterThan(0);
      expect(primary.containsProvisionalFacts, primary.id).toBe(
        primary.provisionalFactIds.length > 0,
      );
      for (const factId of primary.provisionalFactIds) {
        expect(primary.factIds, `${primary.id} -> ${factId}`).toContain(factId);
      }
    }
    // And the provisional lineage is not merely present but non-vacuous: the
    // unknown-time chart really does carry provisional facts into the themes.
    expect(
      UNKNOWN_CHAIN.brief.primaryThemes.some((theme) => theme.containsProvisionalFacts),
    ).toBe(true);
    expect(UNKNOWN_CHAIN.brief.uncertainty.provisionalFactIds.length).toBeGreaterThan(0);
  });
});

describe('ETBZ-25A-R2 I3: the scans themselves can fail', () => {
  // A guard that has never been seen red is not a passing guard, it is an
  // unrun one. Each case plants exactly one signal in a COPY of the metadata
  // and requires the scan to report it, which is why the green results above
  // are evidence rather than an accident of the traversal never firing.

  it('flags a planted supportCount, the exact field this repair removed', () => {
    const polluted = mutableThemeMetadata();
    firstCandidate(polluted)['supportCount'] = 19;

    expect(findSignalNamedFields(polluted, 'brief')).toEqual([
      {
        path: 'brief.candidateThemes[0].supportCount',
        detail: 'field name contains "supportcount"',
      },
    ]);
    expect(findNumericValues(polluted, 'brief')).toEqual([
      { path: 'brief.candidateThemes[0].supportCount', detail: 'number value 19' },
    ]);
  });

  it.each(['rank', 'score', 'prominence', 'confidence', 'importance'] as const)(
    'flags a planted %s field even when its value is a string',
    (word) => {
      const polluted = mutableThemeMetadata();
      firstCandidate(polluted)[word] = 'high';

      expect(findSignalNamedFields(polluted, 'brief')).toEqual([
        { path: `brief.candidateThemes[0].${word}`, detail: `field name contains "${word}"` },
      ]);
      // The numeric scan cannot see this one, which is why both scans exist.
      expect(findNumericValues(polluted, 'brief')).toEqual([]);
    },
  );

  it('flags a RENAMED count that no name blocklist would catch', () => {
    const polluted = mutableThemeMetadata();
    firstCandidate(polluted)['factTally'] = 19;

    // The name scan is blind here — `factTally` contains none of the forbidden
    // words — and a provider would read it exactly as it read supportCount.
    expect(findSignalNamedFields(polluted, 'brief')).toEqual([]);
    expect(findNumericValues(polluted, 'brief')).toEqual([
      { path: 'brief.candidateThemes[0].factTally', detail: 'number value 19' },
    ]);
  });

  it('reaches nested structures, not just the top level of a theme', () => {
    const polluted = mutableThemeMetadata();
    firstCandidate(polluted)['nested'] = { deeper: [{ weightScore: 0.5 }] };

    expect(findSignalNamedFields(polluted, 'brief')).toEqual([
      {
        path: 'brief.candidateThemes[0].nested.deeper[0].weightScore',
        detail: 'field name contains "score"',
      },
    ]);
    expect(findNumericValues(polluted, 'brief')).toEqual([
      {
        path: 'brief.candidateThemes[0].nested.deeper[0].weightScore',
        detail: 'number value 0.5',
      },
    ]);
  });

  it('leaves the unpolluted copy clean, so the pollution is what turns them red', () => {
    expect(findSignalNamedFields(mutableThemeMetadata(), 'brief')).toEqual([]);
    expect(findNumericValues(mutableThemeMetadata(), 'brief')).toEqual([]);
  });
});

describe('ETBZ-25A-R2 I4: the rule is about ETBZ theme metadata, not about source facts', () => {
  it("keeps FuFirE's own Wu Xing Qi weights in the brief, verbatim", () => {
    const byId = new Map(KNOWN_CHAIN.brief.facts.map((fact) => [fact.id, fact]));

    // The fixture's vector, as the source states it. These are measurements
    // FuFirE made; they are not ETBZ ranking metadata and this repair must not
    // have touched them.
    for (const [element, value] of [
      ['Holz', '1.8'],
      ['Feuer', '2.5'],
      ['Erde', '2'],
      ['Metall', '2'],
      ['Wasser', '2'],
    ] as const) {
      const fact = byId.get(`chart.wuxing.weight.${element}`);
      expect(fact, element).toBeDefined();
      expect(fact?.value, element).toBe(value);
      expect(fact?.kind, element).toBe('wu_xing_weight');
    }
    // The element themes built from those facts are still in the brief too:
    // what was removed is a count ABOUT a theme, never a fact of the chart.
    expect(
      KNOWN_CHAIN.brief.candidateThemes.filter((theme) => theme.kind === 'wu_xing_element'),
    ).toHaveLength(5);
  });

  it('leaves the report size contract intact, numbers and all', () => {
    // `specificity` is excluded from the scans on purpose: these numbers bound
    // the ARTEFACT, and saying so here keeps the exclusion honest rather than
    // silent.
    expect(KNOWN_CHAIN.brief.constraints.specificity.minSections).toBe(3);
    expect(KNOWN_CHAIN.brief.constraints.specificity.maxSections).toBe(5);
    expect(findNumericValues(KNOWN_CHAIN.brief.constraints.specificity, 'policy').length)
      .toBeGreaterThan(0);
  });

  it('still produces a report end to end, so none of the above is green for free', () => {
    const output = composeDeterministicNarrative(KNOWN_CHAIN.brief);
    const report = buildReportModel({
      model: KNOWN_MODEL,
      brief: KNOWN_CHAIN.brief,
      providerOutput: output,
    });

    expect(report.interpretation.length).toBeGreaterThanOrEqual(3);
    expect(report.interpretation.length).toBeLessThanOrEqual(5);
    expect(findSignalNamedFields(report.interpretation, 'report')).toEqual([]);
    expect(findNumericValues(report.interpretation, 'report')).toEqual([]);
  });
});
