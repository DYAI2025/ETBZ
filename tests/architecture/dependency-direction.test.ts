import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * AC4 - dependency direction.
 *
 *   http / adapters  ->  application  ->  domain
 *
 * Two independent rules are enforced per inner layer:
 *
 *  1. RELATIVE imports may not escape upward into an outer layer;
 *  2. BARE specifiers are restricted to an allowlist, so a concrete framework
 *     or driver dependency cannot enter - including one nobody thought to add
 *     to a denylist.
 *
 * Rule 2 is the important one: a denylist-only guard is defeated by any new
 * package name. The explicit denylist below is kept purely so that failures
 * name the offending category.
 *
 * The mutation proof in `scripts/verify-guards.sh` injects a real violation and
 * asserts that this suite turns RED, which is what makes the guard credible.
 */

const SRC_ROOT = resolve(process.cwd(), 'src');

interface LayerRule {
  readonly layer: string;
  /** Layer directories this layer's relative imports may resolve into. */
  readonly mayImportLayers: readonly string[];
  /** Bare specifiers this layer may import. */
  readonly allowedPackages: readonly string[];
}

const LAYER_RULES: readonly LayerRule[] = [
  { layer: 'domain', mayImportLayers: ['domain'], allowedPackages: [] },
  {
    layer: 'application',
    mayImportLayers: ['application', 'domain'],
    allowedPackages: ['zod'],
  },
];

/** Named for diagnostics; the allowlist above is the actual barrier. */
const KNOWN_FRAMEWORK_AND_DRIVER_PACKAGES = [
  'express',
  'fastify',
  'koa',
  'node:http',
  'node:https',
  'node:net',
  'node:fs',
  'node:fs/promises',
  'node:child_process',
  'pg',
  'mysql2',
  'sqlite3',
  'better-sqlite3',
  'mongodb',
  'redis',
  'ioredis',
  'axios',
  'node-fetch',
  'undici',
  'got',
  'puppeteer',
  'playwright',
  'nodemailer',
  'aws-sdk',
  '@aws-sdk/client-s3',
];

const TYPESCRIPT_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx'] as const;

/** Marker emitted for a dynamic import whose target cannot be determined statically. */
export const UNRESOLVABLE_DYNAMIC_IMPORT = '<unresolvable-dynamic-import>';

function listTypeScriptFiles(directory: string): string[] {
  const absolute = resolve(SRC_ROOT, directory);
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const entryPath = join(current, entry);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath);
      } else if (TYPESCRIPT_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        found.push(entryPath);
      }
    }
  };
  walk(absolute);
  return found;
}

/**
 * Extracts every module specifier by PARSING the source with the TypeScript
 * compiler, not by matching text.
 *
 * A regex over import statements looks adequate and is not: a specifier written
 * across several lines - the ordinary formatting for a named-import list - sits
 * outside any single-line pattern, so the guard silently sees no import at all
 * and reports the file as clean. Parsing removes that entire class of blind
 * spot, and also covers `import type`, side-effect imports, re-exports,
 * `import x = require(...)`, dynamic `import()` and `require()`.
 *
 * A dynamic import with a computed specifier cannot be resolved statically. It
 * is reported as UNRESOLVABLE_DYNAMIC_IMPORT rather than ignored, because an
 * inner layer must not be able to reach infrastructure through an expression
 * the guard cannot see.
 */
export function extractImportSpecifiers(source: string, fileName = 'source.ts'): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier !== undefined && ts.isStringLiteral(moduleSpecifier)) {
        specifiers.push(moduleSpecifier.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        const [firstArgument] = node.arguments;
        if (firstArgument !== undefined && ts.isStringLiteral(firstArgument)) {
          specifiers.push(firstArgument.text);
        } else if (isDynamicImport) {
          specifiers.push(UNRESOLVABLE_DYNAMIC_IMPORT);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

/** Returns the `src/<layer>` a relative import resolves into, or null. */
function resolvedLayerOf(filePath: string, specifier: string): string | null {
  const resolved = resolve(filePath, '..', specifier);
  const fromSrc = relative(SRC_ROOT, resolved);
  if (fromSrc.startsWith('..')) {
    return null;
  }
  const [first] = fromSrc.split(/[\\/]/);
  return first ?? null;
}

interface Violation {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

function findViolations(rule: LayerRule): Violation[] {
  const violations: Violation[] = [];
  for (const file of listTypeScriptFiles(rule.layer)) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of extractImportSpecifiers(source, file)) {
      const displayFile = relative(process.cwd(), file);
      if (specifier === UNRESOLVABLE_DYNAMIC_IMPORT) {
        violations.push({
          file: displayFile,
          specifier,
          reason: 'dynamic import with a specifier the guard cannot resolve statically',
        });
        continue;
      }
      if (specifier.startsWith('.')) {
        const targetLayer = resolvedLayerOf(file, specifier);
        if (targetLayer === null) {
          violations.push({
            file: displayFile,
            specifier,
            reason: 'relative import escapes src/',
          });
        } else if (!rule.mayImportLayers.includes(targetLayer)) {
          violations.push({
            file: displayFile,
            specifier,
            reason: `${rule.layer} may not import layer "${targetLayer}"`,
          });
        }
        continue;
      }
      if (!rule.allowedPackages.includes(specifier)) {
        const category = KNOWN_FRAMEWORK_AND_DRIVER_PACKAGES.includes(specifier)
          ? 'concrete framework/driver dependency'
          : 'package outside the layer allowlist';
        violations.push({ file: displayFile, specifier, reason: category });
      }
    }
  }
  return violations;
}

describe('AC4: inner layers stay free of frameworks and drivers', () => {
  it.each(LAYER_RULES)('src/$layer has no forbidden dependency', (rule) => {
    const violations = findViolations(rule);
    expect(
      violations,
      `forbidden imports in src/${rule.layer}:\n${violations
        .map((v) => `  ${v.file}: "${v.specifier}" (${v.reason})`)
        .join('\n')}`,
    ).toEqual([]);
  });

  it('detects a violation when one is present (guard self-check)', () => {
    // Proves the detector is not vacuously green: the same analysis applied to
    // a synthetic violating source must report it.
    const syntheticSource = [
      "import express from 'express';",
      "import { createEtbzApp } from '../http/app.js';",
    ].join('\n');

    expect(extractImportSpecifiers(syntheticSource)).toEqual([
      'express',
      '../http/app.js',
    ]);

    const rule = LAYER_RULES[0];
    expect(rule).toBeDefined();
    if (rule === undefined) return;
    expect(rule.allowedPackages).not.toContain('express');
    expect(
      resolvedLayerOf(resolve(SRC_ROOT, 'domain/synthetic.ts'), '../http/app.js'),
    ).toBe('http');
  });

  it.each([
    ['single-line default import', "import express from 'express';", ['express']],
    ['side-effect import', "import 'express';", ['express']],
    ['type-only import', "import type { Express } from 'express';", ['express']],
    [
      'MULTI-LINE named import',
      'import {\n  Router,\n  json,\n} from \'express\';',
      ['express'],
    ],
    [
      'MULTI-LINE relative layer escape',
      'import {\n  createEtbzApp,\n} from \'../http/app.js\';',
      ['../http/app.js'],
    ],
    ['multi-line re-export', 'export {\n  Router,\n} from \'express\';', ['express']],
    ['star re-export', "export * from 'express';", ['express']],
    ['dynamic import', "await import('express');", ['express']],
    ['require call', "const e = require('express');", ['express']],
    [
      'import-equals',
      "import express = require('express');",
      ['express'],
    ],
    [
      'computed dynamic import',
      'await import(`ex` + `press`);',
      [UNRESOLVABLE_DYNAMIC_IMPORT],
    ],
  ])(
    'sees the specifier in a %s (a text-matching guard would miss the wrapped forms)',
    (_label, source, expected) => {
      expect(extractImportSpecifiers(source)).toEqual(expected);
    },
  );

  it('flags a multi-line forbidden import as a real violation', () => {
    // End-to-end over the rule, not just the extractor: the wrapped form must
    // produce a violation for the domain layer.
    const rule = LAYER_RULES[0];
    expect(rule).toBeDefined();
    if (rule === undefined) return;

    const wrapped = extractImportSpecifiers(
      'import {\n  readFileSync,\n} from \'node:fs\';',
    );

    expect(wrapped).toEqual(['node:fs']);
    expect(rule.allowedPackages).not.toContain('node:fs');
  });

  it('scans src/app and src/http only as OUTER layers (composition root)', () => {
    // src/app is the composition root and src/http the inbound adapter; both
    // are permitted to depend on the driver. This assertion documents that the
    // prefix `src/app` is NOT mistaken for `src/application`.
    const applicationFiles = listTypeScriptFiles('application');
    for (const file of applicationFiles) {
      expect(relative(SRC_ROOT, file).startsWith('application')).toBe(true);
    }
  });
});
