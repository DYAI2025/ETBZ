/**
 * ETBZ-25 — the ONLY narrative provider that exists in this slice.
 *
 * It is deterministic and structural on purpose. It performs no generation, has
 * no model behind it, makes no network call, holds no credential and incurs no
 * cost — there is nothing in this file that could become one. Its output is a
 * pure function of the brief.
 *
 * It also writes no interpretation. Every sentence it produces is an assembly
 * of values the brief already contains, in the source's own words, so that the
 * SHAPE of a bound narrative can be exercised end to end long before any
 * creative provider exists. When a real provider arrives, it replaces this one
 * behind the same port and faces the same, unchanged validation in
 * `report-model.ts`: cite what you use, change nothing, claim no method that is
 * not evaluated, and never let a provisional fact lose its provisionality.
 *
 * It deliberately does NOT restate FuFirE's warning codes. Those are
 * source-owned evidence and travel in the report's uncertainty block; a
 * provider echoing them would turn evidence into prose.
 */

import type {
  NarrativeCitation,
  NarrativeProvider,
  NarrativeProviderOutput,
  NarrativeSectionDraft,
} from '../ports/narrative-provider.js';
import type { ChartFact } from './feature-set.js';
import type { NarrativeBrief } from './narrative-brief.js';
import type { Theme } from './theme-graph.js';

export const DETERMINISTIC_NARRATIVE_PROVIDER_ID = 'etbz-25.deterministic-structural-provider';

function citationsFor(theme: Theme, factsById: ReadonlyMap<string, ChartFact>): NarrativeCitation[] {
  const citations: NarrativeCitation[] = [];
  for (const factId of theme.factIds) {
    const fact = factsById.get(factId);
    if (fact === undefined) {
      // The brief is self-contained by construction; a theme pointing outside
      // its own fact list would be a defect, never something to work around.
      throw new RangeError(`deterministic provider: brief has no fact "${factId}"`);
    }
    citations.push({ factId: fact.id, value: fact.value });
  }
  return citations;
}

/**
 * Sentence assembly.
 *
 * Every chart symbol it can emit — the theme label and the cited values — is by
 * construction one the section also cites, which is what lets the same prose
 * pass the uncited-symbol guard that a real provider will have to pass.
 */
function proseFor(theme: Theme, citations: readonly NarrativeCitation[]): string {
  const values = [...new Set(citations.map((citation) => citation.value))].sort();
  // No count: a number in prose must be a cited fact value
  // (`constraints.numeralsMustBeCited`), and a section's cardinality is not one.
  return `Thema ${theme.label}: belegt durch die folgenden Faktbezüge dieser Karte (${values.join(', ')}).`;
}

function notesFor(theme: Theme, provisionalFields: readonly string[]): readonly string[] {
  if (!theme.containsProvisionalFacts) {
    return [];
  }
  // The FIELD names FuFirE marked provisional, not the fact ids: an id carries
  // an index, and a bare number in a note is a claim about the chart it cannot
  // support (`constraints.numeralsMustBeCited`). The full provisional fact ids
  // are carried structurally in the report's uncertainty block, so nothing is
  // lost by keeping them out of the sentence.
  return [
    `Vorläufig: dieser Abschnitt stützt sich auf Fakten, die FuFirE als provisional markiert (${provisionalFields.join(', ')}). Die Unsicherheit bleibt bestehen und wird nicht aufgelöst.`,
  ];
}

/**
 * Builds the provider's answer to one brief. Pure, synchronous, total.
 */
export function composeDeterministicNarrative(brief: NarrativeBrief): NarrativeProviderOutput {
  const factsById = new Map<string, ChartFact>(brief.facts.map((fact) => [fact.id, fact]));
  const provisionalFields = [
    ...new Set([
      ...brief.uncertainty.provisionalFields.bazi,
      ...brief.uncertainty.provisionalFields.natal,
    ]),
  ].sort();
  const sections: NarrativeSectionDraft[] = brief.themes.map((theme): NarrativeSectionDraft => {
    const citedFacts = citationsFor(theme, factsById);
    return {
      themeId: theme.id,
      citedFacts,
      prose: proseFor(theme, citedFacts),
      uncertaintyNotes: notesFor(theme, provisionalFields),
    };
  });

  return {
    providerId: DETERMINISTIC_NARRATIVE_PROVIDER_ID,
    briefStructuralHash: brief.structuralHash,
    sections,
  };
}

export function createDeterministicNarrativeProvider(): NarrativeProvider {
  return {
    id: DETERMINISTIC_NARRATIVE_PROVIDER_ID,
    generate(brief: NarrativeBrief): Promise<NarrativeProviderOutput> {
      // No await: there is no I/O here, and pretending otherwise would suggest
      // a boundary this slice does not have.
      return Promise.resolve(composeDeterministicNarrative(brief));
    },
  };
}
