/**
 * ETBZ-25B — parsing a real model's answer into the shape the port expects.
 *
 * A language model returns TEXT. This module is the only place that text
 * becomes structure, and it is deliberately unforgiving about the conversion
 * while being tolerant about one thing only: a fenced code block around the
 * JSON. Models wrap JSON in ```json fences even when told not to, that habit
 * carries no meaning, and refusing it would spend the slice's one shot per run
 * on a formatting tic rather than on anything about the chart.
 *
 * WHAT IS DELIBERATELY *NOT* ACCEPTED FROM THE MODEL: `providerId` and
 * `briefStructuralHash`. Those are stamped locally by `toProviderOutput` from
 * the route and the brief ETBZ actually used. The model is never asked for them
 * and could not supply them if it tried, which means the binding between an
 * answer and its brief is a property of ETBZ's own bookkeeping rather than of
 * the model's honesty. `REPORT_BRIEF_HASH_MISMATCH` therefore cannot be
 * provoked by this provider — it remains a live guard for any future provider
 * that does declare its own hash, and `tests/negative/` still exercises it.
 *
 * Everything else the answer claims stays untrusted: `report-model.ts`
 * re-derives the chain from the HoroscopeModel and checks every citation
 * against it. This module proves SHAPE, never truth.
 */

import { z } from 'zod';
import { NarrativeProviderError } from './errors.js';
import type {
  NarrativeProviderOutput,
  NarrativeSectionDraft,
} from '../ports/narrative-provider.js';

/**
 * The structure a provider is asked for.
 *
 * `uncertaintyNotes` is optional with an empty default: a chart with nothing
 * provisional gives a model no reason to write one, and demanding an empty
 * array back would be a refusal about punctuation.
 *
 * `strictObject` everywhere else: an extra key is a model inventing a channel,
 * and there is no field in this contract whose absence ETBZ would fill in.
 */
export const narrativeDraftSchema = z.strictObject({
  sections: z.array(
    z.strictObject({
      themeId: z.string().min(1),
      citedFacts: z.array(
        z.strictObject({
          factId: z.string().min(1),
          value: z.string(),
        }),
      ),
      prose: z.string(),
      uncertaintyNotes: z.array(z.string()).default([]),
    }),
  ),
});

export type NarrativeDraft = z.infer<typeof narrativeDraftSchema>;

/**
 * Removes a surrounding markdown fence, if there is one.
 *
 * Only a fence is removed. Prose before or after the JSON is NOT stripped: a
 * model that wrote commentary around its answer did not follow the output
 * contract, and silently digging the object out of a paragraph would hide that
 * from the evidence record.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|JSON)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

/**
 * Parses the provider's text into a validated draft.
 *
 * Two distinct refusals, because they need different fixes: text that is not
 * JSON at all is a formatting failure of the answer, while JSON of the wrong
 * shape is a contract failure. Neither is transient and neither may trigger a
 * call to another provider.
 */
export function parseNarrativeDraft(text: string): NarrativeDraft {
  const candidate = stripCodeFence(text);
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch {
    throw new NarrativeProviderError(
      'PROVIDER_OUTPUT_NOT_JSON',
      'the provider answered with text that is not a JSON object; the prompt requires a bare JSON object and nothing else',
    );
  }
  const parsed = narrativeDraftSchema.safeParse(raw);
  if (!parsed.success) {
    // Path + code only. The value is untrusted model output and does not belong
    // in an error string that may be logged — the same reasoning
    // `report-model.ts` gives for its own schema refusal.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.code}`)
      .join('; ');
    throw new NarrativeProviderError(
      'PROVIDER_OUTPUT_SCHEMA_INVALID',
      `the provider's JSON does not satisfy the narrative draft schema (${issues})`,
    );
  }
  return parsed.data;
}

/**
 * Stamps the draft with ETBZ's own bookkeeping and returns the port's shape.
 *
 * `providerId` records WHICH route answered, so a report's provenance names the
 * concrete provider rather than "an LLM". `briefStructuralHash` is the hash of
 * the brief ETBZ handed over, taken from ETBZ's copy.
 */
export function toProviderOutput(
  draft: NarrativeDraft,
  providerId: string,
  briefStructuralHash: string,
): NarrativeProviderOutput {
  const sections: NarrativeSectionDraft[] = draft.sections.map((section) => ({
    themeId: section.themeId,
    citedFacts: section.citedFacts.map((citation) => ({
      factId: citation.factId,
      value: citation.value,
    })),
    prose: section.prose,
    uncertaintyNotes: section.uncertaintyNotes,
  }));
  return { providerId, briefStructuralHash, sections };
}
