import { describe, expect, it } from 'vitest';
import { InterpretationError } from '../../src/application/interpretation/errors.js';
import { deriveInterpretationFeatureSet } from '../../src/application/interpretation/feature-set.js';
import {
  NOT_EVALUATED_METHODS,
  NOT_EVALUATED_METHOD_IDS,
} from '../../src/application/interpretation/method-scope.js';
import { factText, resolveFactPath } from '../support/factPath.js';
import { knownTimeModel, unknownTimeModel } from '../support/narrativeFixture.js';

/**
 * ETBZ-25 A — InterpretationFeatureSet.
 *
 * The subject under test is a claim, not a shape: every fact carried here is a
 * value that already exists in the HoroscopeModel, at the path the fact names.
 * That is checked by walking the model, not by re-listing the expected values.
 */

describe('ETBZ-25 A1: the feature set is a pure function of the model', () => {
  it('derives byte-identical results from an identical HoroscopeModel', () => {
    const first = deriveInterpretationFeatureSet(knownTimeModel());
    const second = deriveInterpretationFeatureSet(knownTimeModel());

    expect(second).toEqual(first);
    expect(second.structuralHash).toBe(first.structuralHash);
    expect(second.sourceStructuralHash).toBe(first.sourceStructuralHash);
  });

  it('produces a different hash for a different chart fact', () => {
    const base = deriveInterpretationFeatureSet(knownTimeModel());
    const drifted = deriveInterpretationFeatureSet(
      knownTimeModel({ wuxing: { vector: { Feuer: 3.1 } } }),
    );

    expect(drifted.structuralHash).not.toBe(base.structuralHash);
  });

  it('orders facts by id, never by the order the model is visited in', () => {
    const facts = deriveInterpretationFeatureSet(knownTimeModel()).facts;
    const ids = facts.map((fact) => fact.id);

    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('ETBZ-25 A2: every fact is the source value at the path it names', () => {
  it('resolves each fact path in the HoroscopeModel to exactly the fact value', () => {
    const model = knownTimeModel();
    const featureSet = deriveInterpretationFeatureSet(model);

    expect(featureSet.facts.length).toBeGreaterThan(50);
    for (const fact of featureSet.facts) {
      expect(factText(resolveFactPath(model, fact.path)), fact.id).toBe(fact.value);
    }
  });

  it('derives no fact from the dates block at all', () => {
    // Stated so the unknown-time fixture's `dates` values cannot quietly become
    // load-bearing: this slice reads pillars, day master, wu xing, ten gods,
    // hidden stems and the month command, and nothing else.
    const paths = deriveInterpretationFeatureSet(unknownTimeModel()).facts.map(
      (fact) => fact.path,
    );

    expect(paths.filter((path) => path.startsWith('dates'))).toEqual([]);
    expect(paths.filter((path) => path.includes('birthLocal'))).toEqual([]);
  });

  it('covers the four pillars, the day master, wu xing, ten gods and the month command', () => {
    const kinds = new Set(
      deriveInterpretationFeatureSet(knownTimeModel()).facts.map((fact) => fact.kind),
    );

    for (const required of [
      'pillar_stem',
      'pillar_branch',
      'pillar_stem_element',
      'pillar_branch_tier',
      'day_master',
      'day_master_polarity',
      'wu_xing_weight',
      'wu_xing_dominant',
      'ten_god',
      'hidden_stem',
      'hidden_stem_ten_god',
      'month_command_branch',
      'month_command_principal_qi_stem',
    ] as const) {
      expect(kinds, `fact kind ${required} must be represented`).toContain(required);
    }
  });
});

describe('ETBZ-25 A3: certainty is carried, never widened', () => {
  it('keeps a known-time chart non-provisional', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());

    expect(featureSet.birthTimeKnown).toBe(true);
    expect(featureSet.provisionalFactIds).toEqual([]);
    expect(featureSet.provisionalPillars).toEqual([]);
    expect(featureSet.facts.every((fact) => !fact.provisional)).toBe(true);
  });

  it('marks every hour-pillar fact provisional when the birth time is unknown', () => {
    const featureSet = deriveInterpretationFeatureSet(unknownTimeModel());

    expect(featureSet.birthTimeKnown).toBe(false);
    expect(featureSet.provisionalPillars).toEqual(['hour']);
    expect(featureSet.provisionalFactIds.length).toBeGreaterThan(0);

    const hourFacts = featureSet.facts.filter((fact) => fact.pillar === 'hour');
    expect(hourFacts.length).toBeGreaterThan(0);
    expect(hourFacts.every((fact) => fact.provisional)).toBe(true);

    const nonHourProvisional = featureSet.facts.filter(
      (fact) => fact.provisional && fact.pillar !== 'hour',
    );
    expect(nonHourProvisional).toEqual([]);
  });

  it('preserves BOTH provisional-field statements verbatim and separately', () => {
    const model = unknownTimeModel();
    const featureSet = deriveInterpretationFeatureSet(model);

    expect(featureSet.provisionalFields.bazi).toEqual(model.precision.provisionalFields);
    expect(featureSet.provisionalFields.natal).toEqual(
      model.natal.precision.provisionalFields,
    );
  });

  it('refuses a provisional field it cannot map to a pillar instead of dropping it', () => {
    // FuFirE marks something provisional that ETBZ-25 has no lineage rule for.
    // Silently ignoring it would convert a stated uncertainty into silence.
    const model = knownTimeModel({
      natal: { precision: { birthTimeKnown: true, provisionalFields: ['minute'] } },
    });

    expect(() => deriveInterpretationFeatureSet(model)).toThrowError(InterpretationError);
    try {
      deriveInterpretationFeatureSet(model);
      expect.unreachable('an unmapped provisional field must fail closed');
    } catch (error) {
      expect((error as InterpretationError).code).toBe(
        'FEATURE_SET_PROVISIONAL_FIELD_UNMAPPED',
      );
    }
  });
});

describe('ETBZ-25 A4: source warnings survive as evidence', () => {
  it('carries the warning array verbatim, in source order', () => {
    const model = unknownTimeModel();
    const featureSet = deriveInterpretationFeatureSet(model);

    expect(featureSet.sourceWarnings).toEqual(model.sourceWarnings);
    expect(featureSet.sourceWarnings).toEqual(['DAY_ANCHOR_UNVERIFIED', 'BIRTH_TIME_UNKNOWN']);
  });

  it('keeps duplicates and unknown codes rather than normalizing them', () => {
    const warnings = ['DAY_ANCHOR_UNVERIFIED', 'DAY_ANCHOR_UNVERIFIED', 'A_CODE_ETBZ_HAS_NEVER_SEEN'];
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel({ natal: { warnings } }));

    expect(featureSet.sourceWarnings).toEqual(warnings);
  });

  it('changes the structural hash when a warning is removed', () => {
    const withBoth = deriveInterpretationFeatureSet(
      knownTimeModel({ natal: { warnings: ['DAY_ANCHOR_UNVERIFIED', 'EXTRA_CODE'] } }),
    );
    const withOne = deriveInterpretationFeatureSet(
      knownTimeModel({ natal: { warnings: ['DAY_ANCHOR_UNVERIFIED'] } }),
    );

    expect(withOne.structuralHash).not.toBe(withBoth.structuralHash);
  });
});

describe('ETBZ-25 A5: method scope is stated, and the gaps are named', () => {
  it('reports every evaluated method with the facts that carry it', () => {
    const featureSet = deriveInterpretationFeatureSet(knownTimeModel());
    const evaluated = featureSet.methodScope.filter((note) => note.status === 'evaluated');

    expect(evaluated.length).toBeGreaterThanOrEqual(6);
    for (const note of evaluated) {
      expect(note.reason).toBe('source_facts_present');
      expect(note.sourceFactIds.length, note.methodId).toBeGreaterThan(0);
      for (const factId of note.sourceFactIds) {
        expect(featureSet.factIds).toContain(factId);
      }
    }
  });

  it('reports every unimplemented BaZi method as not_evaluated / insufficient_method_scope', () => {
    const notes = deriveInterpretationFeatureSet(knownTimeModel()).methodScope;
    const notEvaluated = notes.filter((note) => note.status === 'not_evaluated');

    expect(notEvaluated.map((note) => note.methodId).sort()).toEqual(
      [...NOT_EVALUATED_METHOD_IDS].sort(),
    );
    for (const note of notEvaluated) {
      expect(note.reason).toBe('insufficient_method_scope');
      expect(note.sourceFactIds).toEqual([]);
    }
    // The methods this slice must not silently omit.
    expect(notEvaluated.map((note) => note.methodId)).toEqual(
      expect.arrayContaining([
        'day_master_strength',
        'rooting',
        'structure',
        'useful_god',
        'climatic_adjustment',
        'symbolic_stars',
        'luck_pillars',
      ]),
    );
  });

  it('keeps every out-of-scope match term lowercase, as its matcher assumes', () => {
    // `findOutOfScopeMethod` lowercases the prose and compares literally, so an
    // uppercase character anywhere in this table would silently disable that
    // term. The invariant is asserted rather than trusted to review.
    for (const method of NOT_EVALUATED_METHODS) {
      expect(method.vocabulary.length, method.methodId).toBeGreaterThan(0);
      for (const term of method.vocabulary) {
        expect(term, `${method.methodId}: "${term}"`).toBe(term.toLowerCase());
        expect(term.trim(), `${method.methodId}: "${term}"`).toBe(term);
      }
    }
  });

  it('refuses to declare a method evaluated when no source fact carries it', () => {
    // A HoroscopeModel whose Wu Xing vector carries no element: the scope
    // statement "wu_xing_distribution is evaluated" would then be a claim
    // without evidence, so the derivation fails instead.
    const model = knownTimeModel();
    const empty = { ...model, wuxing: { ...model.wuxing, vector: {} } };

    try {
      deriveInterpretationFeatureSet(empty);
      expect.unreachable('a method without source facts must fail closed');
    } catch (error) {
      expect(error).toBeInstanceOf(InterpretationError);
      expect((error as InterpretationError).code).toBe(
        'FEATURE_SET_METHOD_WITHOUT_SOURCE_FACTS',
      );
    }
  });
});
