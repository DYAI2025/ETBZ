import { describe, expect, it } from 'vitest';
import { structuralHash } from '../../src/domain/structural-hash.js';
import type { ChartFact } from '../../src/application/interpretation/feature-set.js';
import { buildNarrativeChain } from '../../src/application/interpretation/narrative-brief.js';
import type { NarrativeBrief } from '../../src/application/interpretation/narrative-brief.js';
import {
  EVALUATED_METHODS,
  NOT_EVALUATED_METHODS,
} from '../../src/application/interpretation/method-scope.js';
import {
  INTERPRETATION_POLICY_VERSION,
  PROMPT_VERSION,
  ROLE_PROSE_LABEL,
  buildNarrativePrompt,
} from '../../src/application/interpretation/prompt-policy.js';
import type { NarrativePrompt } from '../../src/application/interpretation/prompt-policy.js';
import {
  BARNUM_PHRASES,
  CERTAINTY_TERMS,
  PROHIBITED_CLAIM_CLASSES,
  PROVISIONALITY_TERMS,
  ROLES_BY_FACT_KIND,
  ROLE_TERMS,
  SYNTHESIS_CONNECTIVES,
} from '../../src/application/interpretation/semantic-qa-lexicon.js';
import { ALTERNATE_TEN_GOD_ROW } from '../support/natalFixture.js';
import {
  KNOWN_BIRTH,
  UNKNOWN_BIRTH,
  knownTimeModel,
  unknownTimeModel,
} from '../support/narrativeFixture.js';

/**
 * ETBZ-25B — the VERSIONED prompt, measured instead of read.
 *
 * `buildNarrativePrompt` is the last point in this service at which a value can
 * still be chosen before it leaves the process and reaches a third-party
 * language model. Everything upstream of it is internal; everything downstream
 * of it is somebody else's log file. That makes one property of this module
 * non-negotiable, and it is the reason this file exists:
 *
 *   THE PROMPT CARRIES THE CHART AND NEVER THE PERSON. The brief the prompt is
 *   built from DOES carry `subject.displayName`, so the name's absence from the
 *   prompt is a deliberate withholding rather than an accident of what happened
 *   to be reachable. The remaining personal data — birth date, clock time,
 *   timezone, coordinates, place label — never enters the brief at all, so the
 *   assertions below are made against the FIXTURE'S OWN birth input. They
 *   therefore test the whole path from a person's data to the outbound text,
 *   not just its last hop: a PII check that only searched for values present in
 *   the prompt's own input would be structurally unable to fail for exactly the
 *   values that matter most.
 *
 * The remaining properties are what make the prompt usable as evidence and as a
 * contract rather than as a trap:
 *
 *   PURITY AND IDENTITY — one brief in, byte-identical text out, with a hash
 *   derived from exactly the fields the prompt publishes, so an evidence record
 *   can name the instructions a reading was produced under and a reviewer can
 *   re-derive them from the record alone.
 *
 *   THE OFFER IS CLOSED — every narratable theme id is offered as a section id
 *   and no candidate theme id is; every citable fact appears under its own
 *   theme with its id, its byte-exact value, its source label and its
 *   provisional marking; and each per-section term whitelist is exactly that
 *   section's own values and labels.
 *
 *   THE OBLIGATIONS ARE STATED, NOT SPRUNG — the rules whose violation the
 *   downstream gates raise as refusals (digits, the per-section term whitelist,
 *   role fidelity, provisionality, synthesis, product safety) are written into
 *   the prompt using the SAME closed word lists those gates judge against. Each
 *   such test therefore asserts both halves: the word is in the prompt, and the
 *   word is one the gate's lexicon actually accepts. A prompt that offered a
 *   synonym the gate does not know would be a trap, and would fail here.
 *
 * Where a property is an ABSENCE, its describe-block carries a positive control:
 * a containment scan that never finds anything proves nothing, so the identical
 * scan is re-run against values that must be present.
 *
 * The prompt text is parsed back apart here rather than re-rendered by the
 * test. A test that rebuilt the module's own strings would agree with any
 * formatting change, including one that moved a term across a section boundary;
 * parsing turns that into a set difference instead.
 */

/* ------------------------------------------------------------------------- *
 * Fixtures. Both chains are pure functions of a fixture chart, so they are
 * built once and shared; nothing in this suite mutates them.
 * ------------------------------------------------------------------------- */

const KNOWN_CHAIN = buildNarrativeChain(knownTimeModel());
const KNOWN_PROMPT = buildNarrativePrompt(KNOWN_CHAIN.brief);
const UNKNOWN_CHAIN = buildNarrativeChain(unknownTimeModel());
const UNKNOWN_PROMPT = buildNarrativePrompt(UNKNOWN_CHAIN.brief);

/** Both messages reach the provider, so both are prompt surface. */
function messagesOf(prompt: NarrativePrompt): readonly string[] {
  return [prompt.system, prompt.user];
}

function factOf(brief: NarrativeBrief, factId: string): ChartFact {
  const fact = brief.facts.find((candidate) => candidate.id === factId);
  if (fact === undefined) throw new Error(`brief carries no fact "${factId}"`);
  return fact;
}

const THEME_HEADING = '  THEMA "';
const UNCERTAINTY_HEADING = '\n\n=== 4. UNSICHERHEIT ===';
const ROLE_GROUP_INDENT = '      [';
const WHITELIST_HEADING = 'ERLAUBTE Chart-Begriffe im Text dieses Abschnitts';
/** `factId="value"`, optionally `/"sourceLabel"`, optionally `!VORLÄUFIG`. */
const FACT_ENTRY_SHAPE = /^([^=]+)="([^"]*)"(?:\/"([^"]*)")?(!VORLÄUFIG)?$/;

/**
 * The slice of the user message that belongs to ONE theme.
 *
 * A missing block throws rather than yielding an empty string, so a parse
 * failure can never masquerade as a passing containment assertion.
 */
function themeBlockOf(user: string, themeId: string): string {
  const start = user.indexOf(`${THEME_HEADING}${themeId}"`);
  if (start < 0) throw new Error(`prompt has no block for theme "${themeId}"`);
  const nextTheme = user.indexOf(`\n${THEME_HEADING}`, start + 1);
  const end = nextTheme < 0 ? user.indexOf(UNCERTAINTY_HEADING, start) : nextTheme;
  if (end < 0) throw new Error(`prompt block for theme "${themeId}" has no end`);
  return user.slice(start, end);
}

/** The quoted terms of a theme block's whitelist line, in the stated order. */
function allowedTermsOf(block: string): readonly string[] {
  const lines = block.split('\n');
  const headingIndex = lines.findIndex((line) => line.includes(WHITELIST_HEADING));
  if (headingIndex < 0) throw new Error('theme block states no term whitelist');
  const termLine = lines[headingIndex + 1];
  if (termLine === undefined) throw new Error('term whitelist heading carries no term line');
  return termLine.trim().split('", "').map((term) => term.replace(/^"|"$/g, ''));
}

interface ParsedEntry {
  readonly factId: string;
  readonly value: string;
  readonly sourceLabel: string | null;
  readonly provisional: boolean;
}

/** One `factId="value"` entry, read back into the fields it claims to carry. */
function parseEntry(entry: string): ParsedEntry {
  const match = FACT_ENTRY_SHAPE.exec(entry);
  if (match === null) throw new Error(`fact entry is not parseable: ${entry}`);
  const [, factId, value, sourceLabel, provisional] = match;
  if (factId === undefined || value === undefined) {
    throw new Error(`fact entry names no id or no value: ${entry}`);
  }
  return {
    factId,
    value,
    sourceLabel: sourceLabel ?? null,
    provisional: provisional !== undefined,
  };
}

interface FactOffer {
  /** The role heading of the group this fact was offered in. */
  readonly role: string;
  readonly entry: ParsedEntry;
}

/**
 * Every fact one theme block offers, with the role group it was offered under.
 *
 * Facts are grouped by role and several are written per line, so the entries
 * are split on the two-space separator the renderer uses — single spaces occur
 * inside source labels (`Druck / Struktur`) and must survive.
 */
function offersOf(user: string, themeId: string): readonly FactOffer[] {
  const offers: FactOffer[] = [];
  for (const line of themeBlockOf(user, themeId).split('\n')) {
    if (!line.startsWith(ROLE_GROUP_INDENT)) continue;
    const close = line.indexOf('] ');
    if (close < 0) throw new Error(`role group line names no role: ${line}`);
    const role = line.slice(ROLE_GROUP_INDENT.length, close);
    for (const entry of line.slice(close + 2).split('  ')) {
      offers.push({ role, entry: parseEntry(entry) });
    }
  }
  if (offers.length === 0) throw new Error(`theme "${themeId}" offers no fact at all`);
  return offers;
}

function prohibitedClassIdOf(term: string): string {
  const claimClass = PROHIBITED_CLAIM_CLASSES.find((candidate) => candidate.terms.includes(term));
  if (claimClass === undefined) throw new Error(`"${term}" is not a prohibited-claim term`);
  return claimClass.classId;
}

/** Shapes personal data takes. Non-global: `.test()` on a /g regex is stateful. */
const ISO_DATE_SHAPE = /\d{4}-\d{2}-\d{2}/;
const CLOCK_TIME_SHAPE = /\d{1,2}:\d{2}/;
const YEAR_SHAPE = /\d{4}/;

describe('ETBZ-25B P1: the prompt carries the chart and never the person', () => {
  it('withholds the displayName that the brief it was built from does carry', () => {
    // The brief is the prompt's only input AND it carries the name, so this is
    // the one PII value whose absence downstream is provably a decision.
    expect(KNOWN_CHAIN.brief.subject.displayName).toBe('Musterkundin A');
    expect(JSON.stringify(KNOWN_CHAIN.brief)).toContain('Musterkundin A');

    expect(KNOWN_PROMPT.system).not.toContain('Musterkundin A');
    expect(KNOWN_PROMPT.user).not.toContain('Musterkundin A');
    // Not even the shared part of the name, which a partial redaction leaves.
    expect(KNOWN_PROMPT.system).not.toContain('Musterkundin');
    expect(KNOWN_PROMPT.user).not.toContain('Musterkundin');
  });

  it('withholds the displayName of the second fixture subject too', () => {
    // A second subject rules out a prompt that happens to omit exactly one name.
    expect(UNKNOWN_CHAIN.brief.subject.displayName).toBe('Musterkundin B');
    expect(JSON.stringify(UNKNOWN_CHAIN.brief)).toContain('Musterkundin B');

    expect(UNKNOWN_PROMPT.system).not.toContain('Musterkundin B');
    expect(UNKNOWN_PROMPT.user).not.toContain('Musterkundin B');
    expect(UNKNOWN_PROMPT.system).not.toContain('Musterkundin');
    expect(UNKNOWN_PROMPT.user).not.toContain('Musterkundin');
  });

  it('contains neither the birth date nor the birth time of either fixture', () => {
    // Bound to the fixture's own values first: should the fixture ever change,
    // these fail loudly instead of scanning for a value nobody has.
    expect(KNOWN_BIRTH.birthDate).toBe('1990-06-15');
    expect(KNOWN_BIRTH.birthTime).toBe('14:30:00');
    expect(UNKNOWN_BIRTH.birthDate).toBe('1985-11-03');
    expect(UNKNOWN_BIRTH.birthTimeKnown).toBe(false);

    for (const message of [...messagesOf(KNOWN_PROMPT), ...messagesOf(UNKNOWN_PROMPT)]) {
      expect(message).not.toContain('1990-06-15');
      expect(message).not.toContain('1985-11-03');
      expect(message).not.toContain('14:30:00');
      // The truncated clock value too: '14:30' is still a birth time.
      expect(message).not.toContain('14:30');
      // And the year components on their own.
      expect(message).not.toContain('1990');
      expect(message).not.toContain('1985');
    }
  });

  it('contains neither the timezone nor the place label of either fixture', () => {
    expect(KNOWN_BIRTH.timezone).toBe('Europe/Berlin');
    expect(UNKNOWN_BIRTH.timezone).toBe('Europe/Berlin');
    expect(KNOWN_BIRTH.location.label).toBe('Berlin');

    for (const message of [...messagesOf(KNOWN_PROMPT), ...messagesOf(UNKNOWN_PROMPT)]) {
      expect(message).not.toContain('Europe/Berlin');
      // 'Berlin' alone is both the place label and the timezone's city half.
      expect(message).not.toContain('Berlin');
      expect(message).not.toContain('Europe/');
    }
  });

  it('contains neither the latitude nor the longitude of either fixture', () => {
    expect(String(KNOWN_BIRTH.location.lat)).toBe('52.52');
    expect(String(KNOWN_BIRTH.location.lon)).toBe('13.405');
    expect(String(UNKNOWN_BIRTH.location.lat)).toBe('52.52');
    expect(String(UNKNOWN_BIRTH.location.lon)).toBe('13.405');

    for (const message of [...messagesOf(KNOWN_PROMPT), ...messagesOf(UNKNOWN_PROMPT)]) {
      expect(message).not.toContain('52.52');
      expect(message).not.toContain('13.405');
      // The rounded forms a coordinate is commonly written in.
      expect(message).not.toContain('52.5');
      expect(message).not.toContain('13.4');
    }
  });

  it('contains no date-shaped, clock-shaped or year-shaped text at all', () => {
    // Stronger than the value scans above: this refuses ANY birth-datum shape,
    // including one a future edit might introduce from a different source.
    for (const message of [...messagesOf(KNOWN_PROMPT), ...messagesOf(UNKNOWN_PROMPT)]) {
      expect(ISO_DATE_SHAPE.test(message)).toBe(false);
      expect(CLOCK_TIME_SHAPE.test(message)).toBe(false);
      expect(YEAR_SHAPE.test(message)).toBe(false);
    }
    // The system message is static by design, so it carries no digit at all.
    expect(/\d/.test(KNOWN_PROMPT.system)).toBe(false);
  });

  it('positive control: the same scans do find what the prompt must carry', () => {
    // A detector that has never fired is not a detector. Every technique used
    // above is re-run here against text it is required to match.
    expect(KNOWN_PROMPT.user).toContain('Xin'); // the day master stem
    expect(KNOWN_PROMPT.user).toContain('辛'); // its Hanzi, byte-exact
    expect(KNOWN_PROMPT.user).toContain('2.5'); // a Wu Xing weight: digits DO reach the prompt
    expect(KNOWN_PROMPT.system).toContain('ETBZ');
    expect(ISO_DATE_SHAPE.test(`geboren am ${KNOWN_BIRTH.birthDate}`)).toBe(true);
    expect(CLOCK_TIME_SHAPE.test('um 14:30 Uhr')).toBe(true);
    expect(YEAR_SHAPE.test('Jahrgang 1990')).toBe(true);
    // And the chart really was built from that personal data, so the absences
    // above are refusals rather than a search through an empty fixture.
    expect(knownTimeModel().displayName).toBe('Musterkundin A');
  });
});

describe('ETBZ-25B P2: the prompt is pure, bound to its brief and self-identifying', () => {
  it('returns a byte-identical prompt for two separately built identical briefs', () => {
    const first = buildNarrativePrompt(buildNarrativeChain(knownTimeModel()).brief);
    const second = buildNarrativePrompt(buildNarrativeChain(knownTimeModel()).brief);

    expect(second.system).toBe(first.system);
    expect(second.user).toBe(first.user);
    expect(second.promptStructuralHash).toBe(first.promptStructuralHash);
    expect(second).toEqual(first);
  });

  it('returns the same prompt when the SAME brief object is passed twice', () => {
    // No memoisation, no accumulated state, no clock: a second call on one
    // object produces the same text as the first.
    const again = buildNarrativePrompt(KNOWN_CHAIN.brief);

    expect(again).toEqual(KNOWN_PROMPT);
    expect(again.promptStructuralHash).toBe(KNOWN_PROMPT.promptStructuralHash);
  });

  it('derives promptStructuralHash from exactly the five fields it publishes', () => {
    // Re-derived from the prompt's own published fields, so a reviewer holding
    // only the evidence record can confirm the hash names THIS text.
    expect(KNOWN_PROMPT.promptStructuralHash).toBe(
      structuralHash({
        promptVersion: KNOWN_PROMPT.promptVersion,
        policyVersion: KNOWN_PROMPT.policyVersion,
        briefStructuralHash: KNOWN_PROMPT.briefStructuralHash,
        system: KNOWN_PROMPT.system,
        user: KNOWN_PROMPT.user,
      }),
    );
    // And it hashes the PROMPT, rather than being the brief hash renamed.
    expect(KNOWN_PROMPT.promptStructuralHash).not.toBe(KNOWN_CHAIN.brief.structuralHash);
  });

  it('binds each prompt to the structural hash of its own brief', () => {
    expect(KNOWN_PROMPT.briefStructuralHash).toBe(KNOWN_CHAIN.brief.structuralHash);
    expect(UNKNOWN_PROMPT.briefStructuralHash).toBe(UNKNOWN_CHAIN.brief.structuralHash);
    expect(UNKNOWN_PROMPT.briefStructuralHash).not.toBe(KNOWN_PROMPT.briefStructuralHash);
  });

  it('moves the prompt hash when exactly ONE chart fact changes', () => {
    // Baseline: the same valid fixture every block above uses. Changed: one
    // contract-valid Ten God row on the hour pillar, and nothing else.
    const drifted = buildNarrativePrompt(
      buildNarrativeChain(
        knownTimeModel({ natal: { pillars: { hour: { tenGod: ALTERNATE_TEN_GOD_ROW } } } }),
      ).brief,
    );

    expect(drifted.briefStructuralHash).not.toBe(KNOWN_PROMPT.briefStructuralHash);
    expect(drifted.promptStructuralHash).not.toBe(KNOWN_PROMPT.promptStructuralHash);
    expect(drifted.user).not.toBe(KNOWN_PROMPT.user);
    // Only the chart-derived half moved: the policy text is not chart-dependent.
    expect(drifted.system).toBe(KNOWN_PROMPT.system);
  });

  it('gives two different charts two different prompts', () => {
    expect(UNKNOWN_PROMPT.user).not.toBe(KNOWN_PROMPT.user);
    expect(UNKNOWN_PROMPT.promptStructuralHash).not.toBe(KNOWN_PROMPT.promptStructuralHash);
    // The system message is static by design and therefore identical, which is
    // what makes it reviewable once instead of once per customer.
    expect(UNKNOWN_PROMPT.system).toBe(KNOWN_PROMPT.system);
  });

  it('names the exported prompt and policy versions, so evidence can cite them', () => {
    expect(KNOWN_PROMPT.promptVersion).toBe(PROMPT_VERSION);
    expect(KNOWN_PROMPT.policyVersion).toBe(INTERPRETATION_POLICY_VERSION);
    expect(UNKNOWN_PROMPT.promptVersion).toBe(PROMPT_VERSION);
    expect(UNKNOWN_PROMPT.policyVersion).toBe(INTERPRETATION_POLICY_VERSION);
    // Pinned literally: an evidence record names these exact strings, so a
    // silent rename has to be a deliberate edit here as well.
    expect(PROMPT_VERSION).toBe('etbz-25b.narrative-prompt.v1');
    expect(INTERPRETATION_POLICY_VERSION).toBe('etbz-25b.interpretation-policy.v1');
  });

  it('publishes exactly the six fields a NarrativePrompt declares', () => {
    // The field set asserted whole: a new field carrying chart or personal data
    // cannot be added without this failing.
    expect([...Object.keys(KNOWN_PROMPT)].sort()).toEqual([
      'briefStructuralHash',
      'policyVersion',
      'promptStructuralHash',
      'promptVersion',
      'system',
      'user',
    ]);
  });
});

describe('ETBZ-25B P3: the prompt offers the narratable themes and only those', () => {
  it('offers every narratable theme id as a section id, in the brief’s order', () => {
    const themeIds = KNOWN_CHAIN.brief.constraints.narratableThemeIds;
    expect(themeIds.length).toBeGreaterThan(0);

    const positions = themeIds.map((themeId) => KNOWN_PROMPT.user.indexOf(`  - "${themeId}"`));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    // Offered in the brief's order, so the section order the prompt demands is
    // the order the report gate will check against.
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    // And each one also gets its own fact block further down.
    for (const themeId of themeIds) {
      expect(KNOWN_PROMPT.user).toContain(`${THEME_HEADING}${themeId}"`);
    }
  });

  it('demands one section per narratable theme, inside the specificity policy', () => {
    const { narratableThemeIds, specificity } = KNOWN_CHAIN.brief.constraints;

    expect(KNOWN_PROMPT.user).toContain(
      `Erzeuge GENAU ${String(narratableThemeIds.length)} Abschnitte`,
    );
    expect(KNOWN_PROMPT.user).toContain(
      `(Minimum ${String(specificity.minSections)}, Maximum ${String(specificity.maxSections)} Abschnitte.)`,
    );
    // The demanded count lies inside the policy it cites — otherwise the prompt
    // would be asking for an answer the specificity gate refuses.
    expect(narratableThemeIds.length).toBeGreaterThanOrEqual(specificity.minSections);
    expect(narratableThemeIds.length).toBeLessThanOrEqual(specificity.maxSections);
  });

  it('offers no candidate theme id anywhere in either message, on either chart', () => {
    for (const { chain, prompt } of [
      { chain: KNOWN_CHAIN, prompt: KNOWN_PROMPT },
      { chain: UNKNOWN_CHAIN, prompt: UNKNOWN_PROMPT },
    ]) {
      const candidateIds = chain.brief.constraints.candidateThemeIds;
      // The distinction has to exist for this to mean anything: there really
      // are more candidate nodes than narratable chapters.
      expect(candidateIds.length).toBeGreaterThan(chain.brief.constraints.narratableThemeIds.length);

      for (const candidateId of candidateIds) {
        expect(prompt.user).not.toContain(candidateId);
        expect(prompt.system).not.toContain(candidateId);
      }
    }
  });

  it('positive control: the identical containment scan does find every narratable id', () => {
    // Same `includes` test, same haystack, ids that must be present — so the
    // candidate-id absence above is a measured refusal, not a broken scan.
    for (const themeId of KNOWN_CHAIN.brief.constraints.narratableThemeIds) {
      expect(KNOWN_PROMPT.user).toContain(themeId);
    }
    for (const themeId of UNKNOWN_CHAIN.brief.constraints.narratableThemeIds) {
      expect(UNKNOWN_PROMPT.user).toContain(themeId);
    }
  });

  it('states each theme’s value-free grouping rule verbatim', () => {
    for (const theme of KNOWN_CHAIN.brief.primaryThemes) {
      // Verbatim, and labelled as provenance rather than as a finding: the
      // model is told what was grouped, never what the grouping means.
      expect(themeBlockOf(KNOWN_PROMPT.user, theme.id)).toContain(`    Herkunft: ${theme.statement}`);
    }
  });
});

describe('ETBZ-25B P4: every citable fact is offered with its id and its exact value', () => {
  it('offers exactly the facts each theme groups, with value, label and marking', () => {
    for (const theme of KNOWN_CHAIN.brief.primaryThemes) {
      const offers = offersOf(KNOWN_PROMPT.user, theme.id);

      // No fact of the theme withheld, and no fact from another theme added:
      // R1 tells the model to cite from ITS OWN list, so the list has to be it.
      expect(offers.map((offer) => offer.entry.factId).sort()).toEqual([...theme.factIds].sort());
      for (const { entry } of offers) {
        const fact = factOf(KNOWN_CHAIN.brief, entry.factId);
        expect(entry.value).toBe(fact.value);
        expect(entry.sourceLabel).toBe(fact.sourceLabel);
        expect(entry.provisional).toBe(fact.provisional);
      }
    }
  });

  it('offers exactly the brief’s allowed fact ids — no more, no fewer', () => {
    const offered = new Set(
      KNOWN_CHAIN.brief.primaryThemes.flatMap((theme) =>
        offersOf(KNOWN_PROMPT.user, theme.id).map((offer) => offer.entry.factId),
      ),
    );

    // An id the model may cite that the report gate does not allow would be a
    // trap; an allowed id the model is never shown would be silently dead.
    expect([...offered].sort()).toEqual([...KNOWN_CHAIN.brief.constraints.allowedFactIds].sort());
    expect(offered.size).toBe(KNOWN_CHAIN.brief.facts.length);
  });

  it('states values byte-exactly, digits, Hanzi and source labels included', () => {
    const themeIds = KNOWN_CHAIN.brief.constraints.narratableThemeIds;
    expect(themeIds).toContain('primary.elemental_profile');
    expect(themeIds).toContain('primary.self_role');

    // Whole entries, character for character — a value the model must copy
    // exactly cannot be proven by a fuzzy match.
    const elemental = themeBlockOf(KNOWN_PROMPT.user, 'primary.elemental_profile');
    expect(elemental).toContain('chart.wuxing.weight.Feuer="2.5"/"Feuer"');
    const selfRole = themeBlockOf(KNOWN_PROMPT.user, 'primary.self_role');
    expect(selfRole).toContain(
      '      [Himmelsstamm oder Tagesmeister] chart.dayMaster.stem="Xin"  chart.dayMaster.stemHanzi="辛"  chart.dayMaster.stemPinyin="xīn"',
    );
    // And those are the brief's own values, not a coincidence of the text.
    expect(factOf(KNOWN_CHAIN.brief, 'chart.wuxing.weight.Feuer').value).toBe('2.5');
    expect(factOf(KNOWN_CHAIN.brief, 'chart.wuxing.weight.Feuer').sourceLabel).toBe('Feuer');
    expect(factOf(KNOWN_CHAIN.brief, 'chart.dayMaster.stem').value).toBe('Xin');
    expect(factOf(KNOWN_CHAIN.brief, 'chart.dayMaster.stemHanzi').value).toBe('辛');
    expect(factOf(KNOWN_CHAIN.brief, 'chart.dayMaster.stemPinyin').value).toBe('xīn');
  });

  it('labels every fact with exactly the roles its fact kind permits', () => {
    for (const theme of KNOWN_CHAIN.brief.primaryThemes) {
      for (const { role, entry } of offersOf(KNOWN_PROMPT.user, theme.id)) {
        const fact = factOf(KNOWN_CHAIN.brief, entry.factId);
        const permitted = ROLES_BY_FACT_KIND[fact.kind].map((kindRole) => ROLE_PROSE_LABEL[kindRole]);

        // Parsed back out of the group heading and compared as a set: the
        // prompt hands the model the same role words the fact-role gate will
        // judge its prose by.
        expect(role.split(' oder ').sort()).toEqual([...permitted].sort());
      }
    }
  });

  it('uses only role words the semantic QA gate actually recognises', () => {
    // The link that makes R4 a contract instead of a guessing game: every word
    // the prompt's role table offers is a word `ROLE_TERMS` accepts for that
    // same role.
    const rolesInUse = new Set(Object.values(ROLES_BY_FACT_KIND).flatMap((roles) => [...roles]));
    expect(rolesInUse.size).toBe(Object.keys(ROLE_PROSE_LABEL).length);
    for (const role of rolesInUse) {
      expect(ROLE_TERMS[role]).toContain(ROLE_PROSE_LABEL[role].toLowerCase());
    }
  });

  it('whitelists per section exactly that section’s values and source labels', () => {
    for (const theme of KNOWN_CHAIN.brief.primaryThemes) {
      const stated = allowedTermsOf(themeBlockOf(KNOWN_PROMPT.user, theme.id));
      const expected = new Set(
        theme.factIds.flatMap((factId) => {
          const fact = factOf(KNOWN_CHAIN.brief, factId);
          return fact.sourceLabel === null ? [fact.value] : [fact.value, fact.sourceLabel];
        }),
      );

      expect([...stated].sort()).toEqual([...expected].sort());
      // Stated in a deterministic order, so the prompt text is stable.
      expect(stated).toEqual([...stated].sort());
    }
  });

  it('marks every provisional fact, and marks none in a chart that has none', () => {
    const provisionalIds = UNKNOWN_CHAIN.brief.uncertainty.provisionalFactIds;
    expect(provisionalIds.length).toBeGreaterThan(0);

    const marked = new Set(
      UNKNOWN_CHAIN.brief.primaryThemes.flatMap((theme) =>
        offersOf(UNKNOWN_PROMPT.user, theme.id)
          .filter((offer) => offer.entry.provisional)
          .map((offer) => offer.entry.factId),
      ),
    );
    expect([...marked].sort()).toEqual([...provisionalIds].sort());
    expect(UNKNOWN_PROMPT.user).toContain('!VORLÄUFIG');

    // Positive control for the same marker: the known-time chart has no
    // provisional fact and carries no marker, so the marking tracks the
    // source's own statement rather than being printed unconditionally.
    expect(KNOWN_CHAIN.brief.uncertainty.provisionalFactIds).toEqual([]);
    expect(KNOWN_PROMPT.user).not.toContain('!VORLÄUFIG');
  });

  it('states per theme whether it carries provisional facts, both ways', () => {
    // The unknown-time chart carries both answers, so one chart proves the
    // heading is derived rather than constant.
    const flags = UNKNOWN_CHAIN.brief.primaryThemes.map((theme) => theme.containsProvisionalFacts);
    expect(flags).toContain(true);
    expect(flags).toContain(false);

    for (const { chain, prompt } of [
      { chain: KNOWN_CHAIN, prompt: KNOWN_PROMPT },
      { chain: UNKNOWN_CHAIN, prompt: UNKNOWN_PROMPT },
    ]) {
      for (const theme of chain.brief.primaryThemes) {
        const stated = theme.containsProvisionalFacts ? 'JA' : 'NEIN';
        expect(prompt.user).toContain(`  THEMA "${theme.id}"  (vorläufige Fakten: ${stated})`);
      }
    }
  });
});

describe('ETBZ-25B P5: the uncertainty rule is stated with the words the gate accepts', () => {
  it('names the source’s provisional fields and the note obligation', () => {
    expect(UNKNOWN_CHAIN.brief.uncertainty.provisionalFields.bazi).toEqual(['hour']);
    expect(UNKNOWN_CHAIN.brief.uncertainty.provisionalFields.natal).toEqual(['hour']);

    expect(UNKNOWN_PROMPT.user).toContain('Vorläufige Felder laut Quelle: hour');
    expect(UNKNOWN_PROMPT.user).toContain(
      'Jeder Abschnitt, der einen VORLÄUFIG markierten Fakt zitiert, MUSS in',
    );
    expect(UNKNOWN_PROMPT.user).toContain(
      '"uncertaintyNotes" mindestens eines dieser Wörter verwenden',
    );
  });

  it('offers only note words the gate accepts and names only certainty words it refuses', () => {
    for (const word of ['vorläufig', 'unsicher', 'ungewiss', 'unbekannt', 'nicht bestätigt']) {
      expect(UNKNOWN_PROMPT.user).toContain(`"${word}"`);
      // Offering a synonym the gate does not accept would make the rule a trap.
      expect(PROVISIONALITY_TERMS).toContain(word);
    }

    for (const word of [
      'sicher',
      'definitiv',
      'zweifellos',
      'eindeutig',
      'garantiert',
      'unweigerlich',
    ]) {
      expect(UNKNOWN_PROMPT.user).toContain(`"${word}"`);
      // Naming a word the gate does NOT refuse would be an empty warning.
      expect(CERTAINTY_TERMS).toContain(word);
    }
  });

  it('positive control: a chart with no provisional fact is told so plainly', () => {
    // The uncertainty block is not boilerplate — it states the other case, and
    // then states none of the provisional obligations.
    expect(KNOWN_CHAIN.brief.uncertainty.provisionalFactIds).toEqual([]);
    expect(KNOWN_PROMPT.user).toContain('  Keine vorläufigen Fakten in dieser Karte.');
    expect(KNOWN_PROMPT.user).not.toContain('Vorläufige Felder laut Quelle:');
  });
});

describe('ETBZ-25B P6: the out-of-scope method vocabulary is stated as forbidden', () => {
  it('spot-checks the terms a model is most likely to invent unprompted', () => {
    // These are the classic BaZi moves this slice has no source facts for, so
    // they are named explicitly rather than left to the general rule.
    for (const term of ['yong shen', 'da yun', 'shen sha']) {
      expect(KNOWN_PROMPT.user).toContain(`"${term}"`);
    }
    expect(KNOWN_PROMPT.user).toContain(
      'NICHT AUSGEWERTETE METHODEN — diese Begriffe dürfen NIRGENDWO im Text stehen:',
    );
  });

  it('names every not-evaluated method and every forbidden term it carries', () => {
    for (const method of NOT_EVALUATED_METHODS) {
      expect(KNOWN_PROMPT.user).toContain(`    - ${method.methodId}: VERBOTENE Begriffe: `);
      expect(method.vocabulary.length).toBeGreaterThan(0);
      for (const term of method.vocabulary) {
        // Quoted, so that a multi-word term reads as one term.
        expect(KNOWN_PROMPT.user).toContain(`"${term}"`);
      }
    }
  });

  it('states the same forbidden method set the brief’s constraints declare', () => {
    const forbidden = KNOWN_CHAIN.brief.constraints.forbiddenMethodIds;

    expect([...forbidden].sort()).toEqual(
      NOT_EVALUATED_METHODS.map((method) => method.methodId).sort(),
    );
    for (const methodId of forbidden) expect(KNOWN_PROMPT.user).toContain(methodId);
  });

  it('positive control: the evaluated methods are listed as the ones with a fact basis', () => {
    // The block states two lists rather than one blanket ban, so the forbidden
    // list above is a scope statement and not a global refusal.
    expect(KNOWN_PROMPT.user).toContain(
      '  AUSGEWERTETE METHODEN (nur diese haben eine Faktenbasis):',
    );
    const evaluated = KNOWN_CHAIN.brief.methodScope.filter((note) => note.status === 'evaluated');
    expect(evaluated.length).toBe(EVALUATED_METHODS.length);
    for (const note of evaluated) {
      expect(KNOWN_PROMPT.user).toContain(`    - ${note.methodId}: ${note.statement}`);
    }
  });
});

describe('ETBZ-25B P7: the obligations are stated as rules, never sprung as refusals', () => {
  it('states the digit rule, including that decorative counting is banned', () => {
    // R3 is the rule a well-meaning model breaks innocently, so it is stated
    // with its one exception (a cited value) and its consequences.
    expect(KNOWN_PROMPT.user).toContain(
      'R3 KEINE ZIFFERN: Schreibe KEINE Ziffer (0-9) in prose oder notes, es sei denn, sie ist',
    );
    expect(KNOWN_PROMPT.user).toContain('exakt ein von dir zitierter value.');
    expect(KNOWN_PROMPT.user).toContain('Zähle nichts.');
    expect(KNOWN_PROMPT.user).toContain('Schreibe keine Jahreszahlen');
    // The brief declares the same obligation the prompt spells out.
    expect(KNOWN_CHAIN.brief.constraints.numeralsMustBeCited).toBe(true);
  });

  it('states the per-section term whitelist rule, and restates it in every block', () => {
    expect(KNOWN_PROMPT.user).toContain('R2 BEGRIFFS-WHITELIST:');
    expect(KNOWN_PROMPT.user).toContain(
      '   darfst du an Chart-Symbolen AUSSCHLIESSLICH die Begriffe schreiben, die du in',
    );
    expect(KNOWN_PROMPT.user).toContain('   GENAU DIESEM Abschnitt zitiert hast.');
    // Including the everyday-meaning trap, which is the one a writer walks into.
    expect(KNOWN_PROMPT.user).toContain('wenn du das Wort in alltäglicher Bedeutung meinst.');
    // And the abstract rule is made concrete once per section.
    for (const theme of KNOWN_CHAIN.brief.primaryThemes) {
      expect(themeBlockOf(KNOWN_PROMPT.user, theme.id)).toContain(WHITELIST_HEADING);
    }
  });

  it('states the citation, anchoring and role obligations the report gate enforces', () => {
    expect(KNOWN_PROMPT.user).toContain('R1 ZITIEREN:');
    expect(KNOWN_PROMPT.user).toContain(
      '"value" muss ZEICHENGENAU dem unten angegebenen value entsprechen.',
    );
    expect(KNOWN_PROMPT.user).toContain('R4 ROLLENTREUE:');
    expect(KNOWN_PROMPT.user).toContain('R7 VERANKERUNG:');
    // The brief declares the same two obligations as non-optional.
    expect(KNOWN_CHAIN.brief.constraints.citationRequired).toBe(true);
    expect(KNOWN_CHAIN.brief.constraints.provisionalCitationRequiresNote).toBe(true);
  });

  it('states the synthesis rule with connectives the gate actually accepts', () => {
    expect(KNOWN_PROMPT.user).toContain('R8 SYNTHESE:');
    for (const connective of [
      'zusammen mit',
      'im Zusammenspiel',
      'während',
      'gleichzeitig',
      'verstärkt',
      'in Spannung',
      'ergänzt',
      'trifft auf',
    ]) {
      expect(KNOWN_PROMPT.user).toContain(`"${connective}"`);
      expect(SYNTHESIS_CONNECTIVES).toContain(connective.toLowerCase());
    }
    // The pair form is offered as one token; both halves are gate-recognised.
    expect(KNOWN_PROMPT.user).toContain('"einerseits/andererseits"');
    expect(SYNTHESIS_CONNECTIVES).toContain('einerseits');
    expect(SYNTHESIS_CONNECTIVES).toContain('andererseits');
  });

  it('states the product-safety prohibitions using the gate’s own terms', () => {
    for (const term of ['vorbestimmt', 'wird eintreten', 'prognose', 'vorhersage', 'unausweichlich']) {
      expect(KNOWN_PROMPT.system.toLowerCase()).toContain(term);
      expect(prohibitedClassIdOf(term)).toBe('deterministic_fate');
    }
    for (const term of ['diagnose', 'krankheit', 'therapie', 'medikamente']) {
      expect(KNOWN_PROMPT.system.toLowerCase()).toContain(term);
      expect(prohibitedClassIdOf(term)).toBe('medical');
    }
    for (const term of ['anwalt', 'klage']) {
      expect(KNOWN_PROMPT.system.toLowerCase()).toContain(term);
      expect(prohibitedClassIdOf(term)).toBe('legal');
    }
    for (const term of ['investition', 'aktien']) {
      expect(KNOWN_PROMPT.system.toLowerCase()).toContain(term);
      expect(prohibitedClassIdOf(term)).toBe('financial');
    }
    // The Barnum ban is stated too, and the gate behind it has a lexicon.
    expect(KNOWN_PROMPT.system).toContain(
      'Barnum-Sätze schreiben, die auf fast jeden Menschen zutreffen.',
    );
    expect(BARNUM_PHRASES.length).toBeGreaterThan(0);
  });

  it('positive control: the prompt also states what the model MAY do', () => {
    // A prompt that only prohibited would produce refusals, not readings, so
    // the permissions are stated as explicitly as the bans.
    expect(KNOWN_PROMPT.system).toContain('DU DARFST ausdrücklich:');
    expect(KNOWN_PROMPT.system).toContain(
      '- mehrere echte Chart-Signale zu einer neuen, plausiblen Deutung verbinden;',
    );
    expect(KNOWN_PROMPT.system).toContain(
      '- eigene Formulierungen erfinden, die in keiner Tabelle stehen;',
    );
    expect(KNOWN_PROMPT.system).toContain('DU DARFST NIEMALS:');
  });
});
