/**
 * ETBZ-29 test support — the FuFirE natal fixture, in BOTH representations.
 *
 * Provenance: this is not invented data. Every value was generated from
 * FuFirE's OWN released tables of the pinned build 1.0.0-rc1-20260220:
 *
 *   - hidden-stem identities + Qi order: `spec/rulesets/standard_bazi_2026.json`
 *     -> `hidden_stems.branch_to_hidden`;
 *   - Qi-role weights (1 / 0.5 / 0.3): `hidden_stems_weighting.role_weights`;
 *   - Ten-God `name`: `ten_gods.relation_to_god` (relation x polarity);
 *   - Ten-God `pinyin` / `element_relation` / `label_de`:
 *     `bazi_engine/dayun/relation.py` `TEN_GODS`;
 *   - Chinese characters, elements and polarities:
 *     `bazi_engine/dayun/jiazi.py` (`STEMS_CN`, `BRANCHES_CN`,
 *     `STEM_ELEMENT`, `STEM_POLARITY`);
 *   - branch index order: `ruleset.branch_order` (Zi=0 .. Hai=11).
 *
 * The chart (year Geng/Wu, month Ren/Wu, day Xin/Hai, hour Yi/Wei, day master
 * Xin) is the SYNTHETIC chart the existing ETBZ-24 BaZi fixture already uses —
 * no real person's birth data is stored in this repository.
 *
 * `natalWireBody()` is the on-the-wire JSON shape (snake_case) the adapter
 * must accept; `natalSnapshot()` is the mapped port shape (camelCase) the
 * application layer consumes. `tests/unit/fufire-natal-client.test.ts` asserts
 * that mapping the first produces exactly the second, so the two
 * representations cannot drift apart silently.
 */
import type { FufireNatalSnapshot } from '../../src/application/ports/fufire-gateway.js';

/** Deep merge used by every fixture override in this file. Arrays REPLACE. */
export function deepMergeFixture(base: unknown, overrides: Record<string, unknown>): unknown {
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return base;
  const merged: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      merged[key] = deepMergeFixture(current, value as Record<string, unknown>);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

const NATAL_WIRE_BODY = {
    "pillars": {
      "year": {
        "stem": "Geng",
        "branch": "Wu",
        "stem_cn": "庚",
        "branch_cn": "午",
        "stem_element": "metal",
        "branch_element": "fire",
        "polarity": "yang",
        "ten_god": {
          "name": "RobWealth",
          "pinyin": "Jie Cai",
          "element_relation": "same_element",
          "label_de": "Rivale"
        },
        "hidden_stems": [
          {
            "stem": "Ding",
            "stem_cn": "丁",
            "element": "fire",
            "qi": "principal",
            "weight": 1,
            "ten_god": {
              "name": "SevenKilling",
              "pinyin": "Qi Sha",
              "element_relation": "controls_day_master",
              "label_de": "Druck / Struktur"
            }
          },
          {
            "stem": "Ji",
            "stem_cn": "己",
            "element": "earth",
            "qi": "central",
            "weight": 0.5,
            "ten_god": {
              "name": "IndirectRes",
              "pinyin": "Pian Yin",
              "element_relation": "produces_day_master",
              "label_de": "Indirekte Quelle"
            }
          }
        ]
      },
      "month": {
        "stem": "Ren",
        "branch": "Wu",
        "stem_cn": "壬",
        "branch_cn": "午",
        "stem_element": "water",
        "branch_element": "fire",
        "polarity": "yang",
        "ten_god": {
          "name": "HurtingOfficer",
          "pinyin": "Shang Guan",
          "element_relation": "produced_by_day_master",
          "label_de": "Disruptive Ausgabe"
        },
        "hidden_stems": [
          {
            "stem": "Ding",
            "stem_cn": "丁",
            "element": "fire",
            "qi": "principal",
            "weight": 1,
            "ten_god": {
              "name": "SevenKilling",
              "pinyin": "Qi Sha",
              "element_relation": "controls_day_master",
              "label_de": "Druck / Struktur"
            }
          },
          {
            "stem": "Ji",
            "stem_cn": "己",
            "element": "earth",
            "qi": "central",
            "weight": 0.5,
            "ten_god": {
              "name": "IndirectRes",
              "pinyin": "Pian Yin",
              "element_relation": "produces_day_master",
              "label_de": "Indirekte Quelle"
            }
          }
        ]
      },
      "day": {
        "stem": "Xin",
        "branch": "Hai",
        "stem_cn": "辛",
        "branch_cn": "亥",
        "stem_element": "metal",
        "branch_element": "water",
        "polarity": "yin",
        "ten_god": null,
        "hidden_stems": [
          {
            "stem": "Ren",
            "stem_cn": "壬",
            "element": "water",
            "qi": "principal",
            "weight": 1,
            "ten_god": {
              "name": "HurtingOfficer",
              "pinyin": "Shang Guan",
              "element_relation": "produced_by_day_master",
              "label_de": "Disruptive Ausgabe"
            }
          },
          {
            "stem": "Jia",
            "stem_cn": "甲",
            "element": "wood",
            "qi": "central",
            "weight": 0.5,
            "ten_god": {
              "name": "DirectWealth",
              "pinyin": "Zheng Cai",
              "element_relation": "controlled_by_day_master",
              "label_de": "Direktes Vermögen"
            }
          }
        ]
      },
      "hour": {
        "stem": "Yi",
        "branch": "Wei",
        "stem_cn": "乙",
        "branch_cn": "未",
        "stem_element": "wood",
        "branch_element": "earth",
        "polarity": "yin",
        "ten_god": {
          "name": "IndirectWealth",
          "pinyin": "Pian Cai",
          "element_relation": "controlled_by_day_master",
          "label_de": "Indirektes Vermögen"
        },
        "hidden_stems": [
          {
            "stem": "Ji",
            "stem_cn": "己",
            "element": "earth",
            "qi": "principal",
            "weight": 1,
            "ten_god": {
              "name": "IndirectRes",
              "pinyin": "Pian Yin",
              "element_relation": "produces_day_master",
              "label_de": "Indirekte Quelle"
            }
          },
          {
            "stem": "Yi",
            "stem_cn": "乙",
            "element": "wood",
            "qi": "central",
            "weight": 0.5,
            "ten_god": {
              "name": "IndirectWealth",
              "pinyin": "Pian Cai",
              "element_relation": "controlled_by_day_master",
              "label_de": "Indirektes Vermögen"
            }
          },
          {
            "stem": "Ding",
            "stem_cn": "丁",
            "element": "fire",
            "qi": "residual",
            "weight": 0.3,
            "ten_god": {
              "name": "SevenKilling",
              "pinyin": "Qi Sha",
              "element_relation": "controls_day_master",
              "label_de": "Druck / Struktur"
            }
          }
        ]
      }
    },
    "day_master": {
      "stem": "Xin",
      "stem_cn": "辛",
      "element": "metal",
      "polarity": "yin"
    },
    "month_command": {
      "branch": "Wu",
      "branch_cn": "午",
      "branch_index": 6,
      "principal_qi_stem": "Ding",
      "principal_qi_stem_cn": "丁",
      "element": "fire",
      "source_status": "CALCULATED"
    },
    "provenance": {
      "source": "FuFirE",
      "ruleset_id": "standard_bazi_2026",
      "ruleset_version": "1.0.0",
      "computed_at": "2026-09-07T19:56:12Z"
    },
    "precision": {
      "birth_time_known": true,
      "provisional_fields": []
    },
    "warnings": [
      "DAY_ANCHOR_UNVERIFIED"
    ]
  } as const;

const NATAL_SNAPSHOT: FufireNatalSnapshot = {
    "pillars": {
      "year": {
        "stem": "Geng",
        "branch": "Wu",
        "stemCn": "庚",
        "branchCn": "午",
        "stemElement": "metal",
        "branchElement": "fire",
        "polarity": "yang",
        "tenGod": {
          "name": "RobWealth",
          "pinyin": "Jie Cai",
          "elementRelation": "same_element",
          "labelDe": "Rivale"
        },
        "hiddenStems": [
          {
            "stem": "Ding",
            "stemCn": "丁",
            "element": "fire",
            "qi": "principal",
            "weight": 1,
            "tenGod": {
              "name": "SevenKilling",
              "pinyin": "Qi Sha",
              "elementRelation": "controls_day_master",
              "labelDe": "Druck / Struktur"
            }
          },
          {
            "stem": "Ji",
            "stemCn": "己",
            "element": "earth",
            "qi": "central",
            "weight": 0.5,
            "tenGod": {
              "name": "IndirectRes",
              "pinyin": "Pian Yin",
              "elementRelation": "produces_day_master",
              "labelDe": "Indirekte Quelle"
            }
          }
        ]
      },
      "month": {
        "stem": "Ren",
        "branch": "Wu",
        "stemCn": "壬",
        "branchCn": "午",
        "stemElement": "water",
        "branchElement": "fire",
        "polarity": "yang",
        "tenGod": {
          "name": "HurtingOfficer",
          "pinyin": "Shang Guan",
          "elementRelation": "produced_by_day_master",
          "labelDe": "Disruptive Ausgabe"
        },
        "hiddenStems": [
          {
            "stem": "Ding",
            "stemCn": "丁",
            "element": "fire",
            "qi": "principal",
            "weight": 1,
            "tenGod": {
              "name": "SevenKilling",
              "pinyin": "Qi Sha",
              "elementRelation": "controls_day_master",
              "labelDe": "Druck / Struktur"
            }
          },
          {
            "stem": "Ji",
            "stemCn": "己",
            "element": "earth",
            "qi": "central",
            "weight": 0.5,
            "tenGod": {
              "name": "IndirectRes",
              "pinyin": "Pian Yin",
              "elementRelation": "produces_day_master",
              "labelDe": "Indirekte Quelle"
            }
          }
        ]
      },
      "day": {
        "stem": "Xin",
        "branch": "Hai",
        "stemCn": "辛",
        "branchCn": "亥",
        "stemElement": "metal",
        "branchElement": "water",
        "polarity": "yin",
        "tenGod": null,
        "hiddenStems": [
          {
            "stem": "Ren",
            "stemCn": "壬",
            "element": "water",
            "qi": "principal",
            "weight": 1,
            "tenGod": {
              "name": "HurtingOfficer",
              "pinyin": "Shang Guan",
              "elementRelation": "produced_by_day_master",
              "labelDe": "Disruptive Ausgabe"
            }
          },
          {
            "stem": "Jia",
            "stemCn": "甲",
            "element": "wood",
            "qi": "central",
            "weight": 0.5,
            "tenGod": {
              "name": "DirectWealth",
              "pinyin": "Zheng Cai",
              "elementRelation": "controlled_by_day_master",
              "labelDe": "Direktes Vermögen"
            }
          }
        ]
      },
      "hour": {
        "stem": "Yi",
        "branch": "Wei",
        "stemCn": "乙",
        "branchCn": "未",
        "stemElement": "wood",
        "branchElement": "earth",
        "polarity": "yin",
        "tenGod": {
          "name": "IndirectWealth",
          "pinyin": "Pian Cai",
          "elementRelation": "controlled_by_day_master",
          "labelDe": "Indirektes Vermögen"
        },
        "hiddenStems": [
          {
            "stem": "Ji",
            "stemCn": "己",
            "element": "earth",
            "qi": "principal",
            "weight": 1,
            "tenGod": {
              "name": "IndirectRes",
              "pinyin": "Pian Yin",
              "elementRelation": "produces_day_master",
              "labelDe": "Indirekte Quelle"
            }
          },
          {
            "stem": "Yi",
            "stemCn": "乙",
            "element": "wood",
            "qi": "central",
            "weight": 0.5,
            "tenGod": {
              "name": "IndirectWealth",
              "pinyin": "Pian Cai",
              "elementRelation": "controlled_by_day_master",
              "labelDe": "Indirektes Vermögen"
            }
          },
          {
            "stem": "Ding",
            "stemCn": "丁",
            "element": "fire",
            "qi": "residual",
            "weight": 0.3,
            "tenGod": {
              "name": "SevenKilling",
              "pinyin": "Qi Sha",
              "elementRelation": "controls_day_master",
              "labelDe": "Druck / Struktur"
            }
          }
        ]
      }
    },
    "dayMaster": {
      "stem": "Xin",
      "stemCn": "辛",
      "element": "metal",
      "polarity": "yin"
    },
    "monthCommand": {
      "branch": "Wu",
      "branchCn": "午",
      "branchIndex": 6,
      "principalQiStem": "Ding",
      "principalQiStemCn": "丁",
      "element": "fire",
      "sourceStatus": "CALCULATED"
    },
    "provenance": {
      "source": "FuFirE",
      "rulesetId": "standard_bazi_2026",
      "rulesetVersion": "1.0.0",
      "computedAt": "2026-09-07T19:56:12Z"
    },
    "precision": {
      "birthTimeKnown": true,
      "provisionalFields": []
    },
    "warnings": [
      "DAY_ANCHOR_UNVERIFIED"
    ]
  };

/** The natal response exactly as FuFirE puts it on the wire. */
export function natalWireBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return deepMergeFixture(structuredClone(NATAL_WIRE_BODY), overrides) as Record<string, unknown>;
}

/** The same response after the adapter's contract mapping. */
export function natalSnapshot(overrides: Record<string, unknown> = {}): FufireNatalSnapshot {
  return deepMergeFixture(structuredClone(NATAL_SNAPSHOT), overrides) as FufireNatalSnapshot;
}

/**
 * Unknown-time variant: FuFirE marks the hour pillar provisional and adds its
 * own BIRTH_TIME_UNKNOWN code. No time is substituted anywhere.
 */
export const UNKNOWN_TIME_NATAL_OVERRIDES = {
  precision: { birthTimeKnown: false, provisionalFields: ['hour'] },
  warnings: ['DAY_ANCHOR_UNVERIFIED', 'BIRTH_TIME_UNKNOWN'],
} as const;

export const UNKNOWN_TIME_NATAL_WIRE_OVERRIDES = {
  precision: { birth_time_known: false, provisional_fields: ['hour'] },
  warnings: ['DAY_ANCHOR_UNVERIFIED', 'BIRTH_TIME_UNKNOWN'],
} as const;

/**
 * ETBZ-29 repair — a COMPLETE alternative row of the released Ten-God table
 * (`DirectWealth`). Internally coherent, so it passes the adapter's tuple
 * validation; it is simply a different row than the one this chart's hour
 * pillar carries. Used by the canonical-anchor canary, which needs a
 * contract-VALID single-fact change rather than an impossible source value.
 */
export const ALTERNATE_TEN_GOD_ROW = {
  name: 'DirectWealth',
  pinyin: 'Zheng Cai',
  elementRelation: 'controlled_by_day_master',
  labelDe: 'Direktes Vermögen',
} as const;

export const ALTERNATE_TEN_GOD_ROW_WIRE = {
  name: 'DirectWealth',
  pinyin: 'Zheng Cai',
  element_relation: 'controlled_by_day_master',
  label_de: 'Direktes Vermögen',
} as const;
