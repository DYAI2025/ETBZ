import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * ETBZ-25B — the architecture and secret-surface guards for the real LLM slice.
 *
 * ETBZ-25B is the first slice that puts a CREDENTIAL and a REMOTE ENDPOINT into
 * this service. Both are configuration, not product truth, and both are exactly
 * the kind of thing that leaks inward one convenient import at a time: a base
 * URL pasted into the adapter "just for the smoke test", a key echoed into a
 * log line, an evidence field that seemed harmless. None of that is visible in
 * a behavioural test — a run with a hard-coded endpoint and a logged key passes
 * every functional assertion in the suite.
 *
 * So this file asserts properties of the SOURCE rather than of a run:
 *
 *  1. `src/application` and `src/domain` never depend on `src/adapters`. The
 *     LLM provider is infrastructure; the application knows only the port.
 *  2. `src/adapters/llm` hard-codes no provider endpoint and no credential.
 *  3. The route credential has exactly ONE consumer in `src/`: the
 *     `Authorization` header of the OpenAI-compatible client.
 *  4. `NarrativeRunEvidence` declares no field whose NAME invites a credential.
 *  5. The slice's modules sit where the architecture says they do.
 *
 * TWO DELIBERATE IMPLEMENTATION CHOICES, because both are load-bearing:
 *
 * SPECIFIERS ARE PARSED, NOT MATCHED. Several application modules discuss
 * `src/adapters` in prose — `narrative-evidence.ts` explains why it declares
 * its own usage type rather than importing the adapter's. A text scan for
 * "adapters" reports those comments as violations, and a guard that cries wolf
 * on its own documentation gets deleted. The TypeScript compiler supplies the
 * real specifier list, which also covers multi-line named imports, `import
 * type`, re-exports, `import x = require(...)` and dynamic `import()` — forms a
 * single-line regex silently misses.
 *
 * DETECTABLE FIXTURES ARE ASSEMBLED AT RUNTIME. The self-checks below need
 * strings shaped like real credentials. Writing one as a literal would put a
 * scanner-detectable shape into a committed file and make `scripts/secret-scan.sh`
 * report this test file as a finding. They are therefore composed from
 * fragments at runtime, the same technique that script uses on itself. Do not
 * "simplify" them back into literals.
 */

const REPO_ROOT = process.cwd();
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const LLM_ADAPTER_DIR = resolve(SRC_ROOT, 'adapters', 'llm');

/** Emitted for a dynamic import whose target cannot be determined statically. */
const UNRESOLVABLE_DYNAMIC_IMPORT = '<unresolvable-dynamic-import>';

// ---------------------------------------------------------------------------
// Source access
// ---------------------------------------------------------------------------

function listTypeScriptFiles(absoluteRoot: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const entryPath = join(current, entry);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath);
      } else if (entry.endsWith('.ts')) {
        found.push(entryPath);
      }
    }
  };
  walk(absoluteRoot);
  return found.sort();
}

function displayPath(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split('\\').join('/');
}

/** `setParentNodes` is required: the line lookups below call `node.getStart`. */
function parseSource(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
}

function parseFile(absolutePath: string): ts.SourceFile {
  return parseSource(readFileSync(absolutePath, 'utf8'), absolutePath);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

// ---------------------------------------------------------------------------
// (1) Dependency direction: application / domain must not reach into adapters
// ---------------------------------------------------------------------------

function moduleSpecifierNodes(sourceFile: ts.SourceFile): Set<ts.Node> {
  const nodes = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      nodes.add(node.moduleSpecifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return nodes;
}

/**
 * Every module specifier in the file, in source order.
 *
 * A dynamic import whose argument is computed is reported as
 * UNRESOLVABLE_DYNAMIC_IMPORT rather than dropped: an inner layer must not be
 * able to reach infrastructure through an expression this guard cannot read.
 */
function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
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
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
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

/** The path under `src/` a relative specifier resolves to, or null if outside. */
function resolvedPathUnderSrc(filePath: string, specifier: string): string | null {
  const fromSrc = relative(SRC_ROOT, resolve(filePath, '..', specifier));
  return fromSrc.startsWith('..') ? null : fromSrc.split('\\').join('/');
}

/** True when a specifier NAMES the adapters directory, however it resolves. */
function namesAdaptersDirectory(specifier: string): boolean {
  return /(?:^|\/)adapters(?:\/|$)/.test(specifier);
}

interface ImportViolation {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

/**
 * Two INDEPENDENT rules, so neither one alone has to be complete.
 *
 * Resolution catches the ordinary relative form even when it is spelled
 * `../../adapters/../adapters/llm/...`; the name check catches a specifier that
 * says "adapters" but resolves nowhere this guard can follow — a path alias, a
 * bare package, a future workspace import. A violation needs only one of them.
 */
function findAdapterDependencies(filePath: string, sourceFile: ts.SourceFile): ImportViolation[] {
  const violations: ImportViolation[] = [];
  const file = displayPath(filePath);
  for (const specifier of collectModuleSpecifiers(sourceFile)) {
    if (specifier === UNRESOLVABLE_DYNAMIC_IMPORT) {
      violations.push({
        file,
        specifier,
        reason: 'dynamic import whose target this guard cannot resolve statically',
      });
      continue;
    }
    const resolvedPath = resolvedPathUnderSrc(filePath, specifier);
    if (resolvedPath !== null && /^adapters(?:\/|$)/.test(resolvedPath)) {
      violations.push({
        file,
        specifier,
        reason: `resolves into src/${resolvedPath}`,
      });
      continue;
    }
    if (namesAdaptersDirectory(specifier)) {
      violations.push({ file, specifier, reason: 'specifier names the adapters directory' });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// (2) Endpoint and credential literals in the LLM adapter
// ---------------------------------------------------------------------------

interface SourceLiteral {
  readonly text: string;
  readonly line: number;
}

/**
 * Every string/template literal that is a VALUE.
 *
 * Module specifiers are excluded: they are paths the compiler resolves, not
 * data, and rule (1) already governs them. Keeping them here would make a
 * renamed module able to trip the credential heuristics for no reason.
 */
function collectValueLiterals(sourceFile: ts.SourceFile): SourceLiteral[] {
  const excluded = moduleSpecifierNodes(sourceFile);
  const literals: SourceLiteral[] = [];
  const visit = (node: ts.Node): void => {
    const isLiteralText =
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    if (isLiteralText && !excluded.has(node)) {
      literals.push({ text: node.text, line: lineOf(sourceFile, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}

/**
 * The folded text of every constant string concatenation.
 *
 * MEASURED GAP, not a theoretical one. Without this, a canary that pasted
 * `'sk-' + '<thirty-two characters>'` into the client left the suite fully
 * green: neither half matches a credential pattern on its own. Splitting a
 * detectable string across a `+` is precisely how `scripts/secret-scan.sh`
 * keeps its own generator clean, so it is the first evasion anyone in this
 * repository would reach for. Folding constant `+` chains closes it, and costs
 * nothing: the adapter contains no string sums at all.
 */
function foldConstantConcatenations(sourceFile: ts.SourceFile): SourceLiteral[] {
  const folded: SourceLiteral[] = [];
  const evaluate = (node: ts.Node): string | null => {
    if (ts.isStringLiteralLike(node)) {
      return node.text;
    }
    if (ts.isParenthesizedExpression(node)) {
      return evaluate(node.expression);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = evaluate(node.left);
      const right = evaluate(node.right);
      return left === null || right === null ? null : left + right;
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const value = evaluate(node);
      if (value !== null) {
        folded.push({ text: value, line: lineOf(sourceFile, node) });
        // The operands are pure literals and are already collected on their
        // own; descending would only duplicate them.
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return folded;
}

/** What the endpoint and credential scans below look at: literals AND their sums. */
function scannableLiterals(sourceFile: ts.SourceFile): SourceLiteral[] {
  return [...collectValueLiterals(sourceFile), ...foldConstantConcatenations(sourceFile)];
}

/**
 * Host fragments of the four approved routes plus the obvious neighbours.
 *
 * Named explicitly rather than guessed from a generic hostname shape: the
 * claim under test is "no approved provider endpoint is hard-coded", and an
 * explicit list makes a failure name the provider instead of a regex.
 */
const APPROVED_PROVIDER_HOST_MARKERS = [
  'openrouter',
  'opencode.ai',
  'tokenrouter',
  'generativelanguage',
  'googleapis',
  'api.openai.com',
  'anthropic.com',
] as const;

/** A bare host with a real TLD, anchored so `etbz-25b.openai-compatible.` cannot match. */
const BARE_HOST_LITERAL = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ai|com|io|dev|net|org|app|cloud)(?::\d+)?(?:\/|$)/i;

interface LiteralFinding {
  readonly line: number;
  readonly reason: string;
}

function findEndpointLiterals(sourceFile: ts.SourceFile): LiteralFinding[] {
  const findings: LiteralFinding[] = [];
  for (const literal of scannableLiterals(sourceFile)) {
    const text = literal.text;
    if (text.includes('://')) {
      findings.push({ line: literal.line, reason: 'absolute URL literal' });
      continue;
    }
    if (text.startsWith('//') && text.length > 2) {
      findings.push({ line: literal.line, reason: 'protocol-relative URL literal' });
      continue;
    }
    const marker = APPROVED_PROVIDER_HOST_MARKERS.find((host) =>
      text.toLowerCase().includes(host),
    );
    if (marker !== undefined) {
      findings.push({ line: literal.line, reason: `names the provider host "${marker}"` });
      continue;
    }
    if (BARE_HOST_LITERAL.test(text)) {
      findings.push({ line: literal.line, reason: 'bare hostname literal' });
    }
  }
  return findings;
}

/**
 * Credential shapes.
 *
 * The named patterns mirror `narrative-evidence.ts`, so the source guard and
 * the evidence guard agree on what a credential looks like. The opaque-token
 * rule is the catch-all for a key whose provider nobody enumerated: twenty or
 * more non-space characters mixing upper case, lower case and digits is not
 * something this codebase writes by hand.
 */
const CREDENTIAL_LITERAL_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/, 'an OpenAI-style `sk-` secret key'],
  [/\bAIza[0-9A-Za-z_-]{30,}/, 'a Google API key'],
  [/\bBearer\s+[A-Za-z0-9._-]{16,}/i, 'a literal Authorization bearer credential'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub personal access token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
] as const;

const OPAQUE_TOKEN_LITERAL =
  /^(?=\S{20,}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z0-9._:/+=-]+$/;

function findCredentialLiterals(sourceFile: ts.SourceFile): LiteralFinding[] {
  const findings: LiteralFinding[] = [];
  for (const literal of scannableLiterals(sourceFile)) {
    for (const [pattern, description] of CREDENTIAL_LITERAL_PATTERNS) {
      if (pattern.test(literal.text)) {
        findings.push({ line: literal.line, reason: `contains ${description}` });
      }
    }
    if (OPAQUE_TOKEN_LITERAL.test(literal.text)) {
      findings.push({ line: literal.line, reason: 'opaque mixed-case high-entropy literal' });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// (3) The single credential consumer
// ---------------------------------------------------------------------------

/**
 * Every EXPRESSION that reads a `.apiKey` property.
 *
 * Property-access nodes are used rather than text, because the claim is about
 * what the code DOES. `openai-compatible-client.ts` states in a comment that no
 * other branch reads `route.apiKey`; that sentence must not count as a second
 * read, and an AST walk never sees a comment. `definition.apiKeyVariable` is
 * likewise not a credential read — it is the NAME of an environment variable.
 */
function collectApiKeyReads(sourceFile: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'apiKey') {
      lines.push(lineOf(sourceFile, node));
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'apiKey'
    ) {
      lines.push(lineOf(sourceFile, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return lines;
}

// ---------------------------------------------------------------------------
// (4) Credential-shaped field names
// ---------------------------------------------------------------------------

function interfaceMembers(
  sourceFile: ts.SourceFile,
  interfaceName: string,
): { readonly name: string; readonly type: string }[] {
  const members: { name: string; type: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
          members.push({
            name: member.name.text,
            type: member.type === undefined ? '' : member.type.getText(sourceFile).trim(),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return members;
}

function declaredInterfaceNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** `apiKey` -> ['api', 'key'];  `access_token` -> ['access', 'token']. */
function nameWords(fieldName: string): string[] {
  return fieldName
    .split(/(?=[A-Z])|[_-]/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

const CREDENTIAL_FIELD_WORDS: ReadonlySet<string> = new Set([
  'apikey',
  'key',
  'keys',
  'token',
  'tokens',
  'secret',
  'secrets',
  'credential',
  'credentials',
  'authorization',
  'password',
  'passwd',
  'bearer',
]);

/**
 * Token COUNTS are numbers a provider reported, not credentials.
 *
 * The exemption is VERIFIED rather than granted: an exempted field must still
 * be declared as a number, so a credential cannot slip through by borrowing one
 * of these three names.
 */
const TOKEN_COUNT_FIELDS: ReadonlySet<string> = new Set([
  'promptTokens',
  'completionTokens',
  'totalTokens',
]);

function isCredentialShapedFieldName(fieldName: string): boolean {
  return nameWords(fieldName).some((word) => CREDENTIAL_FIELD_WORDS.has(word));
}

// ---------------------------------------------------------------------------
// Synthetic fixtures, assembled at runtime (see the file docblock)
// ---------------------------------------------------------------------------

const SYNTHETIC_OPENAI_STYLE_KEY = ['sk', 'notarealkey0123456789abcdefghij'].join('-');
const SYNTHETIC_GOOGLE_STYLE_KEY = `AIza${'Sy0123456789abcdefghijklmnopqrstuvw'}`;
const SYNTHETIC_BEARER_LITERAL = `Bearer ${'abcdef0123456789abcdef0123456789'}`;
// Assembled at runtime like the three above, and for the same reason: a
// high-entropy literal sitting in a committed file is a finding for the
// repository's own secret scanner, whatever the string actually means. A test
// that proves credential-shaped values are caught must not itself ship one.
const SYNTHETIC_OPAQUE_TOKEN = ['Qx7Lm9Pv', '1Rb8Tn3Wy', '6Ac5Ef0Hj', '2Kd4Zs'].join('');

// ---------------------------------------------------------------------------

describe('ETBZ-25B: src/application and src/domain never depend on src/adapters', () => {
  it.each(['application', 'domain'] as const)(
    'no file under src/%s declares an import reaching into src/adapters',
    (layer) => {
      const violations = listTypeScriptFiles(resolve(SRC_ROOT, layer)).flatMap((file) =>
        findAdapterDependencies(file, parseFile(file)),
      );

      expect(
        violations,
        `src/${layer} must know the port, never the adapter:\n${violations
          .map((violation) => `  ${violation.file}: "${violation.specifier}" (${violation.reason})`)
          .join('\n')}`,
      ).toEqual([]);
    },
  );

  it('actually scans both inner layers and reads real imports from them', () => {
    // Anti-vacuous positive control. A green result above is worthless if the
    // walker found no files, or found files but parsed no specifiers out of
    // them - both would be silently indistinguishable from a clean codebase.
    const applicationFiles = listTypeScriptFiles(resolve(SRC_ROOT, 'application'));
    const domainFiles = listTypeScriptFiles(resolve(SRC_ROOT, 'domain'));

    expect(applicationFiles.length).toBeGreaterThanOrEqual(15);
    expect(domainFiles.length).toBeGreaterThanOrEqual(3);

    const applicationSpecifiers = applicationFiles.flatMap((file) =>
      collectModuleSpecifiers(parseFile(file)),
    );
    expect(applicationSpecifiers.length).toBeGreaterThan(20);
    // The port IS imported by the application layer; the adapter is not.
    expect(applicationSpecifiers.some((s) => s.includes('ports/narrative-provider.js'))).toBe(true);
  });

  it('reports a synthetic application module that imports the LLM adapter', () => {
    // Guard self-check: the exact import the architecture forbids.
    const syntheticFile = resolve(SRC_ROOT, 'application/interpretation/synthetic.ts');
    const source = [
      "import { generateNarrativeFromPlan } from '../../adapters/llm/llm-narrative-provider.js';",
      'export const run = generateNarrativeFromPlan;',
    ].join('\n');

    const violations = findAdapterDependencies(syntheticFile, parseSource(source, syntheticFile));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe('../../adapters/llm/llm-narrative-provider.js');
    expect(violations[0]?.reason).toBe('resolves into src/adapters/llm/llm-narrative-provider.js');
  });

  it('reports nothing for a synthetic application module that stays in its layer', () => {
    // Positive control: the same detector on a legitimate baseline is green, so
    // the test above proves detection rather than a guard that is always red.
    const syntheticFile = resolve(SRC_ROOT, 'application/interpretation/synthetic.ts');
    const source = [
      "import type { NarrativeProviderOutput } from '../ports/narrative-provider.js';",
      "import { canonicalJson } from '../../domain/canonical-json.js';",
      'export type Out = NarrativeProviderOutput;',
      'export const json = canonicalJson;',
    ].join('\n');

    expect(findAdapterDependencies(syntheticFile, parseSource(source, syntheticFile))).toEqual([]);
  });

  it.each([
    [
      'multi-line named import',
      "import {\n  generateNarrativeFromPlan,\n  providerIdFor,\n} from '../../adapters/llm/llm-narrative-provider.js';",
    ],
    [
      'type-only import',
      "import type { Transport } from '../../adapters/llm/openai-compatible-client.js';",
    ],
    ['side-effect import', "import '../../adapters/llm/openai-compatible-client.js';"],
    ['star re-export', "export * from '../../adapters/llm/openai-compatible-client.js';"],
    [
      'multi-line re-export',
      "export {\n  requestChatCompletion,\n} from '../../adapters/llm/openai-compatible-client.js';",
    ],
    ['dynamic import', "await import('../../adapters/llm/openai-compatible-client.js');"],
    ['require call', "const c = require('../../adapters/llm/openai-compatible-client.js');"],
    [
      'import-equals',
      "import c = require('../../adapters/llm/openai-compatible-client.js');",
    ],
  ])('sees the forbidden dependency written as a %s', (_label, source) => {
    // A single-line regex over `^import .* from` misses every wrapped form
    // here, and the wrapped forms are the ordinary way this code is formatted.
    const syntheticFile = resolve(SRC_ROOT, 'application/interpretation/synthetic.ts');

    expect(findAdapterDependencies(syntheticFile, parseSource(source, syntheticFile))).toHaveLength(
      1,
    );
  });

  it('does not mistake prose about src/adapters for a dependency on it', () => {
    // Precision control with a real file: narrative-evidence.ts explains in a
    // comment WHY it declares its own usage type instead of importing the
    // adapter's. A text scan reports that sentence; the parser does not.
    const file = resolve(SRC_ROOT, 'application/interpretation/narrative-evidence.ts');
    const raw = readFileSync(file, 'utf8');

    expect(raw, 'the precision control needs a file that really mentions adapters').toContain(
      'application -> adapters',
    );
    expect(findAdapterDependencies(file, parseFile(file))).toEqual([]);
  });

  it('reports an adapters specifier that resolves nowhere this guard can follow', () => {
    // The name rule, alone: a bare/aliased specifier resolves outside src/, so
    // the resolution rule cannot see it - and it is still a violation.
    const syntheticFile = resolve(SRC_ROOT, 'domain/synthetic.ts');
    const source = "import { requestChatCompletion } from '@etbz/adapters/llm/client.js';";

    const violations = findAdapterDependencies(syntheticFile, parseSource(source, syntheticFile));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('specifier names the adapters directory');
  });

  it('reports a dynamic import whose target it cannot resolve, rather than ignoring it', () => {
    const syntheticFile = resolve(SRC_ROOT, 'domain/synthetic.ts');
    const source = 'const part = "adapters"; await import(`../${part}/llm/client.js`);';

    const violations = findAdapterDependencies(syntheticFile, parseSource(source, syntheticFile));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.specifier).toBe(UNRESOLVABLE_DYNAMIC_IMPORT);
  });
});

describe('ETBZ-25B: src/adapters/llm hard-codes no provider endpoint and no credential', () => {
  const adapterFiles = listTypeScriptFiles(LLM_ADAPTER_DIR);

  it('contains the two declared modules and scans every source in the directory', () => {
    // Anti-vacuous positive control for this whole block: the per-file
    // assertions below prove nothing if the directory listing is empty.
    expect(adapterFiles.map((file) => basename(file))).toEqual(
      expect.arrayContaining(['llm-narrative-provider.ts', 'openai-compatible-client.ts']),
    );
    expect(adapterFiles.length).toBeGreaterThanOrEqual(2);

    const literals = adapterFiles.flatMap((file) => collectValueLiterals(parseFile(file)));
    expect(
      literals.length,
      'the literal walker must actually be seeing the adapter strings',
    ).toBeGreaterThan(50);
  });

  it.each(adapterFiles.map((file) => [displayPath(file), file] as const))(
    '%s hard-codes no endpoint: base URLs are configuration, not product truth',
    (_label, file) => {
      const findings = findEndpointLiterals(parseFile(file));

      expect(
        findings,
        `endpoint literals:\n${findings.map((f) => `  line ${String(f.line)}: ${f.reason}`).join('\n')}`,
      ).toEqual([]);
    },
  );

  it.each(adapterFiles.map((file) => [displayPath(file), file] as const))(
    '%s contains no credential-shaped literal',
    (_label, file) => {
      const findings = findCredentialLiterals(parseFile(file));

      expect(
        findings,
        `credential-shaped literals:\n${findings.map((f) => `  line ${String(f.line)}: ${f.reason}`).join('\n')}`,
      ).toEqual([]);
    },
  );

  it('pins a request PATH and takes the host from the route plan', () => {
    // The positive statement behind the two negatives above: the adapter does
    // own the path (so no caller and no model output can redirect the call),
    // and owns nothing else about the URL.
    const source = readFileSync(
      resolve(LLM_ADAPTER_DIR, 'openai-compatible-client.ts'),
      'utf8',
    );

    expect(source).toMatch(/export const CHAT_COMPLETIONS_PATH = '\/chat\/completions';/);
    expect(source).toContain('${route.baseUrl}${CHAT_COMPLETIONS_PATH}');
    expect(source).not.toContain('://');
  });

  it('reads no environment variable itself', () => {
    // The other half of "configuration, not product truth": the adapter must
    // receive its route, not go and find one. `process.env` is read once, in
    // src/main.ts, and the route plan is built in the composition root.
    for (const file of adapterFiles) {
      expect(readFileSync(file, 'utf8'), `${displayPath(file)} must not read process.env`).not.toMatch(
        /process\s*\.\s*env/,
      );
    }
  });

  it.each([
    ['a hard-coded provider URL', "const url = 'https://openrouter.ai/api/v1/chat/completions';"],
    ['a bare provider host', "const host = 'openrouter.ai/api/v1';"],
    ['a protocol-relative URL', "const url = '//openrouter.ai/api/v1';"],
  ])('reports %s in a synthetic adapter source (guard self-check)', (_label, source) => {
    const findings = findEndpointLiterals(parseSource(source, 'synthetic-adapter.ts'));

    expect(findings.length).toBeGreaterThan(0);
  });

  it.each([
    ['an OpenAI-style key', SYNTHETIC_OPENAI_STYLE_KEY],
    ['a Google API key', SYNTHETIC_GOOGLE_STYLE_KEY],
    ['a literal bearer credential', SYNTHETIC_BEARER_LITERAL],
    ['an opaque high-entropy token', SYNTHETIC_OPAQUE_TOKEN],
  ])('reports %s embedded in a synthetic adapter source (guard self-check)', (_label, secret) => {
    // The secret is interpolated, never written as a literal in this file - see
    // the docblock: a literal here would make the repository secret scan report
    // this test as a finding.
    const source = `const fallback = ${JSON.stringify(secret)};\nexport default fallback;`;

    const findings = findCredentialLiterals(parseSource(source, 'synthetic-adapter.ts'));

    expect(findings.length).toBeGreaterThan(0);
  });

  it('reports a credential SPLIT across a string concatenation (measured evasion)', () => {
    // Regression guard for a gap this suite actually had: while the scan looked
    // at literals only, `'sk-' + '<32 chars>'` pasted into the client left every
    // assertion green, because neither half is credential-shaped on its own.
    const [head, tail] = [SYNTHETIC_OPENAI_STYLE_KEY.slice(0, 3), SYNTHETIC_OPENAI_STYLE_KEY.slice(3)];
    const source = `const key = ${JSON.stringify(head)} + ${JSON.stringify(tail)};\nexport default key;`;
    const sourceFile = parseSource(source, 'synthetic-adapter.ts');

    // Each half alone is invisible to the pattern - that is what made the gap.
    expect(collectValueLiterals(sourceFile).map((literal) => literal.text)).toEqual([head, tail]);
    expect(findCredentialLiterals(sourceFile).length).toBeGreaterThan(0);
  });

  it('reports an endpoint SPLIT across a string concatenation', () => {
    const source = "const url = 'https://' + 'openrouter.ai' + '/api/v1';\nexport default url;";

    expect(findEndpointLiterals(parseSource(source, 'synthetic-adapter.ts')).length).toBeGreaterThan(
      0,
    );
  });

  it('reports nothing for an ordinary message built by concatenation', () => {
    // Precision control for the folding: joining prose is not smuggling a key.
    const source = "const message = 'route ' + 'rejected the request';\nexport default message;";
    const sourceFile = parseSource(source, 'synthetic-adapter.ts');

    expect(findCredentialLiterals(sourceFile)).toEqual([]);
    expect(findEndpointLiterals(sourceFile)).toEqual([]);
  });

  it('reports nothing for a synthetic adapter source that takes both from configuration', () => {
    // Positive control: the guard is not always red. This is the shape the real
    // adapter uses - path pinned, host and credential injected.
    const source = [
      "const PATH = '/chat/completions';",
      'export function url(route: { baseUrl: string }): string {',
      '  return `${route.baseUrl}${PATH}`;',
      '}',
      'export function auth(route: { apiKey: string }): string {',
      '  return `Bearer ${route.apiKey}`;',
      '}',
    ].join('\n');
    const sourceFile = parseSource(source, 'synthetic-adapter.ts');

    expect(findEndpointLiterals(sourceFile)).toEqual([]);
    expect(findCredentialLiterals(sourceFile)).toEqual([]);
  });

  it('does not mistake a screaming-snake error code for an opaque token', () => {
    // Precision control for the opaque-token heuristic: PROVIDER_OUTPUT_SCHEMA_INVALID
    // is thirty characters of upper case and would be a false positive under a
    // naive "long literal" rule.
    const source = "const code = 'PROVIDER_OUTPUT_SCHEMA_INVALID';\nexport default code;";

    expect(findCredentialLiterals(parseSource(source, 'synthetic-adapter.ts'))).toEqual([]);
  });
});

describe('ETBZ-25B: the route credential has exactly one consumer in src/', () => {
  const allSourceFiles = listTypeScriptFiles(SRC_ROOT);

  const ROUTE_BUILDER = 'src/app/configuration/llm-routes.ts';
  const LLM_CLIENT = 'src/adapters/llm/openai-compatible-client.ts';
  /** Pre-existing, unrelated credential: the FuFirE boundary client's own key. */
  const FUFIRE_CLIENT = 'src/adapters/fufire/http-client.ts';

  it('mentions `apiKey` in exactly three files across src/', () => {
    const mentioning = allSourceFiles
      .filter((file) => readFileSync(file, 'utf8').includes('apiKey'))
      .map((file) => displayPath(file));

    // Stated as an exact set, not a subset: a NEW file acquiring the word
    // `apiKey` - a logger, a serialiser, a debug helper - turns this red, which
    // is the entire point. The FuFirE client is listed because its credential
    // predates this slice and lives behind its own boundary adapter.
    expect(mentioning.sort()).toEqual([FUFIRE_CLIENT, LLM_CLIENT, ROUTE_BUILDER].sort());
  });

  it('mentions `apiKey` nowhere under src/application or src/domain', () => {
    const inner = [
      ...listTypeScriptFiles(resolve(SRC_ROOT, 'application')),
      ...listTypeScriptFiles(resolve(SRC_ROOT, 'domain')),
    ];

    expect(inner.length).toBeGreaterThan(15);
    for (const file of inner) {
      expect(
        readFileSync(file, 'utf8'),
        `${displayPath(file)} is inner-layer code and must not know a credential exists`,
      ).not.toContain('apiKey');
    }
  });

  it('reads the LLM route credential in exactly one expression in src/', () => {
    const reads = allSourceFiles
      .map((file) => ({ file: displayPath(file), lines: collectApiKeyReads(parseFile(file)) }))
      .filter((entry) => entry.lines.length > 0);

    const llmReads = reads.filter((entry) => entry.file !== FUFIRE_CLIENT);

    expect(
      llmReads.map((entry) => `${entry.file}:${entry.lines.join(',')}`),
      'the route credential must be read once, by the client that sends it',
    ).toHaveLength(1);
    expect(llmReads[0]?.file).toBe(LLM_CLIENT);
    expect(llmReads[0]?.lines).toHaveLength(1);
  });

  it('reads it inside the Authorization header and nowhere else', () => {
    const file = resolve(REPO_ROOT, LLM_CLIENT);
    const source = readFileSync(file, 'utf8');
    const lines = source.split('\n');
    const [readLine] = collectApiKeyReads(parseFile(file));

    expect(readLine).toBeDefined();
    const statement = readLine === undefined ? '' : (lines[readLine - 1] ?? '');

    expect(statement.trim()).toBe('Authorization: `Bearer ${route.apiKey}`,');
  });

  it('never places the credential in a log, an error or a hash', () => {
    // The consequence the single-read property is FOR. Every error message in
    // this client interpolates the route id, the status or the timeout; none of
    // them can reach the key, because the key is read in one statement above.
    const source = readFileSync(resolve(REPO_ROOT, LLM_CLIENT), 'utf8');
    const errorConstructions = source.match(/new LlmProviderError\([\s\S]*?\);/g) ?? [];

    expect(errorConstructions.length).toBeGreaterThanOrEqual(6);
    for (const construction of errorConstructions) {
      expect(construction).not.toContain('apiKey');
    }
  });

  it('declares the credential in the route plan and never reads it back there', () => {
    // The route builder OWNS the field: it declares it and fills it from the
    // environment. It performs no property read of it, so nothing in the
    // composition root can log or hash the value on its way past.
    const file = resolve(REPO_ROOT, ROUTE_BUILDER);
    const source = readFileSync(file, 'utf8');

    expect(source).toContain('readonly apiKey: string;');
    expect(source).toMatch(/const apiKey = readPresentValue\(environment, definition\.apiKeyVariable\);/);
    expect(collectApiKeyReads(parseFile(file))).toEqual([]);
  });

  it('reports a synthetic module that reads the credential for a log line', () => {
    // Guard self-check, in both access forms.
    const dotted = 'export const line = { route: route.routeId, key: route.apiKey };';
    const indexed = "export const line = { key: route['apiKey'] };";

    expect(collectApiKeyReads(parseSource(dotted, 'synthetic.ts'))).toHaveLength(1);
    expect(collectApiKeyReads(parseSource(indexed, 'synthetic.ts'))).toHaveLength(1);
  });

  it('reports nothing for a synthetic module that logs only non-secret route facts', () => {
    // Positive control: the detector is green on the legitimate baseline.
    const source =
      'export const line = { route: route.routeId, model: route.model, base: route.baseUrl };';

    expect(collectApiKeyReads(parseSource(source, 'synthetic.ts'))).toEqual([]);
  });

  it('does not count a comment naming route.apiKey as a read', () => {
    // Precision control: the real client documents its own single-read rule in
    // prose. A text-matching guard counts that sentence and reports two reads.
    const source = ['// no branch below reads `route.apiKey` again.', 'export const x = 1;'].join(
      '\n',
    );

    expect(collectApiKeyReads(parseSource(source, 'synthetic.ts'))).toEqual([]);
    expect(source).toContain('route.apiKey');
  });

  it('does not count the environment VARIABLE NAME as a credential read', () => {
    // Precision control: `definition.apiKeyVariable` is the string
    // "OPENROUTER_API_KEY", not a secret, and the route builder reads it for
    // every approved route.
    const source = 'export const v = definition.apiKeyVariable;';

    expect(collectApiKeyReads(parseSource(source, 'synthetic.ts'))).toEqual([]);
  });
});

describe('ETBZ-25B: the run evidence record declares no credential-shaped field', () => {
  const EVIDENCE_FILE = resolve(SRC_ROOT, 'application/interpretation/narrative-evidence.ts');

  it('declares NarrativeRunEvidence with the reconstruction fields the contract names', () => {
    // Anti-vacuous positive control: the field scan below is meaningless if the
    // interface was not found, or was found empty.
    const members = interfaceMembers(parseFile(EVIDENCE_FILE), 'NarrativeRunEvidence');

    expect(members.length).toBeGreaterThanOrEqual(20);
    expect(members.map((member) => member.name)).toEqual(
      expect.arrayContaining([
        'candidateSha',
        'briefStructuralHash',
        'promptStructuralHash',
        'acceptedRouteId',
        'acceptedModel',
        'attempts',
        'routeVerdicts',
        'structuralHash',
        // The cost POLICY and the cost OBSERVATION, pinned as two distinct
        // fields. They were one, and a reader could not tell an approved cap
        // from a measured charge. Collapsing them again fails here.
        'approvedCostCapEur',
        'allowPaid',
        'observedBillableCostEur',
        'observedCostBasis',
      ]),
    );
  });

  it('names no field in NarrativeRunEvidence after a credential', () => {
    const offending = interfaceMembers(parseFile(EVIDENCE_FILE), 'NarrativeRunEvidence')
      .map((member) => member.name)
      .filter((name) => isCredentialShapedFieldName(name));

    expect(
      offending,
      'evidence must be reconstructable without ever having a place to put a secret',
    ).toEqual([]);
  });

  it('names no field in ANY evidence interface after a credential, token counts excepted', () => {
    const sourceFile = parseFile(EVIDENCE_FILE);
    const interfaceNames = declaredInterfaceNames(sourceFile);

    expect(interfaceNames).toEqual(
      expect.arrayContaining([
        'NarrativeRunEvidence',
        'EvidenceRouteAttempt',
        'EvidenceRouteVerdict',
        'EvidenceUsage',
      ]),
    );

    const offending: string[] = [];
    for (const interfaceName of interfaceNames) {
      for (const member of interfaceMembers(sourceFile, interfaceName)) {
        if (!isCredentialShapedFieldName(member.name)) {
          continue;
        }
        // The exemption is checked, not granted: a token COUNT must be a number.
        const exempt =
          TOKEN_COUNT_FIELDS.has(member.name) && /^number\s*\|\s*null$/.test(member.type);
        if (!exempt) {
          offending.push(`${interfaceName}.${member.name}: ${member.type}`);
        }
      }
    }

    expect(offending).toEqual([]);
  });

  it('exempts the token counters only because they are declared as numbers', () => {
    // Makes the exemption's own condition visible: if `promptTokens` were ever
    // retyped to `string`, the test above would report it.
    const usage = interfaceMembers(parseFile(EVIDENCE_FILE), 'EvidenceUsage');

    expect(usage.map((member) => member.name).sort()).toEqual([
      'completionTokens',
      'promptTokens',
      'totalTokens',
    ]);
    for (const member of usage) {
      expect(isCredentialShapedFieldName(member.name)).toBe(true);
      expect(member.type).toBe('number | null');
    }
  });

  it('reports a synthetic evidence interface that adds a credential field', () => {
    // Guard self-check, using the exact regression this test exists to catch:
    // someone adding "just the key id" to the record.
    const source = [
      'export interface NarrativeRunEvidence {',
      '  readonly candidateSha: string;',
      '  readonly apiKey: string;',
      '}',
    ].join('\n');

    const offending = interfaceMembers(parseSource(source, 'synthetic.ts'), 'NarrativeRunEvidence')
      .map((member) => member.name)
      .filter((name) => isCredentialShapedFieldName(name));

    expect(offending).toEqual(['apiKey']);
  });

  it('reports nothing for a synthetic evidence interface of non-secret facts', () => {
    // Positive control: the classifier is not simply always true.
    const source = [
      'export interface NarrativeRunEvidence {',
      '  readonly candidateSha: string;',
      '  readonly acceptedRouteId: string | null;',
      '  readonly responseHash: string | null;',
      '}',
    ].join('\n');

    const offending = interfaceMembers(parseSource(source, 'synthetic.ts'), 'NarrativeRunEvidence')
      .map((member) => member.name)
      .filter((name) => isCredentialShapedFieldName(name));

    expect(offending).toEqual([]);
  });

  it.each([
    'apiKey',
    'api_key',
    'routeKey',
    'accessToken',
    'bearerToken',
    'clientSecret',
    'authorizationHeader',
    'providerCredentials',
    'password',
  ])('classifies the field name "%s" as credential-shaped', (fieldName) => {
    expect(isCredentialShapedFieldName(fieldName)).toBe(true);
  });

  it.each([
    'candidateSha',
    'briefStructuralHash',
    'acceptedRouteId',
    'failoverAuthorized',
    'observedCostBasis',
    'observedBillableCostEur',
    'approvedCostCapEur',
    'goldenReadingHash',
    'semanticQaFindings',
    'canonicalJson',
  ])('does not classify the real evidence field "%s" as credential-shaped', (fieldName) => {
    // Precision control: an over-eager word list would flag hashes and ids and
    // force the record to be renamed around the guard.
    expect(isCredentialShapedFieldName(fieldName)).toBe(false);
  });
});

describe('ETBZ-25B: the LLM slice modules sit where the architecture says', () => {
  const REQUIRED_PATHS = [
    'src/adapters/llm',
    'src/adapters/llm/openai-compatible-client.ts',
    'src/adapters/llm/llm-narrative-provider.ts',
    'src/app/configuration/llm-routes.ts',
    'src/application/interpretation/semantic-qa.ts',
    'src/application/interpretation/semantic-qa-lexicon.ts',
    'src/application/interpretation/narrative-qa-policy.ts',
    'src/application/interpretation/narrative-evidence.ts',
    'src/application/interpretation/golden-reading.ts',
    'src/application/interpretation/prompt-policy.ts',
    'src/application/interpretation/narrative-draft.ts',
    'src/application/ports/narrative-provider.ts',
  ] as const;

  it.each(REQUIRED_PATHS)('%s exists', (path) => {
    expect(existsSync(resolve(REPO_ROOT, path))).toBe(true);
  });

  it('keeps the LLM provider modules in the adapter layer and nowhere else', () => {
    // A copy of the client under src/application would satisfy every import
    // rule above - nobody would be importing across the boundary, because the
    // boundary would have been moved.
    for (const moduleName of ['openai-compatible-client.ts', 'llm-narrative-provider.ts']) {
      const locations = listTypeScriptFiles(SRC_ROOT)
        .filter((file) => basename(file) === moduleName)
        .map((file) => displayPath(file));

      expect(locations).toEqual([`src/adapters/llm/${moduleName}`]);
    }
  });

  it('keeps the route plan in the composition root, not in the application layer', () => {
    const locations = listTypeScriptFiles(SRC_ROOT)
      .filter((file) => basename(file) === 'llm-routes.ts')
      .map((file) => displayPath(file));

    expect(locations).toEqual(['src/app/configuration/llm-routes.ts']);
  });

  it('reports a path the architecture does not declare as missing (guard self-check)', () => {
    // Positive control for `existsSync` itself: the assertions above are
    // vacuous if every path "exists".
    expect(existsSync(resolve(REPO_ROOT, 'src/application/interpretation/llm-routes.ts'))).toBe(
      false,
    );
    expect(existsSync(resolve(REPO_ROOT, 'src/adapters/llm/semantic-qa.ts'))).toBe(false);
  });
});

describe('ETBZ-25B: a blocked live run still leaves a reviewable record', () => {
  // The live harness is excluded from the CI gate by design — it needs a
  // network, a credential and a third party's availability. That exclusion is
  // exactly why this property needs a home INSIDE the gate: without one, the
  // harness's refusal path is verified by nobody until a real run hits it.
  //
  // It already went wrong once, measured on a real run against a real route.
  // `buildReportModel` threw on a candidate that cited a fact absent from the
  // chart, and the throw travelled straight past `buildRunEvidence` — so the
  // blocked candidate produced NO evidence file at all, while the harness's own
  // docblock promised it writes "the evidence record and the findings anyway".
  // A structural refusal is a real result of this slice; a result nobody can
  // review is barely better than no result.
  const HARNESS = resolve(REPO_ROOT, 'tests/live/golden-reading.live.test.ts');

  function harnessSource(): string {
    return readFileSync(HARNESS, 'utf8');
  }

  it('catches the structural gate refusal instead of letting it escape', () => {
    const source = harnessSource();
    // Positive control: the assertions below are vacuous if the file moved.
    expect(existsSync(HARNESS)).toBe(true);
    expect(source).toContain('buildReportModel');
    // The refusal is caught by TYPE, not swallowed wholesale: anything that is
    // not a ReportError must still escape unchanged.
    //
    // Asserted as the WHOLE rethrow statement, not as the bare substring
    // 'throw error;'. That substring already appears in this file inside an
    // unrelated catch 23 lines earlier, so matching it pinned nothing: the
    // structural-gate catch could be rewritten to swallow a TypeError entirely
    // and the assertion would still pass on the other statement.
    expect(source).toContain('if (!(error instanceof ReportError)) {\n      throw error;\n    }');
  });

  it('builds the evidence record before the refusal propagates', () => {
    const source = harnessSource();
    const caught = source.indexOf('structuralBlocker = error');
    const built = source.indexOf('const evidence = buildRunEvidence(');
    // Searched from `built` onwards: the provider-refusal branch earlier in the
    // file writes its own record, and matching THAT write would let this
    // ordering pass with the structural path's write deleted.
    const written = source.indexOf('writeFileSync(', built);
    const rethrown = source.lastIndexOf('throw structuralBlocker;');

    // Ordering IS the property. Evidence has to be assembled and on disk before
    // the refusal leaves the function, or the blocked run is invisible again.
    expect(caught).toBeGreaterThan(-1);
    expect(built).toBeGreaterThan(caught);
    expect(written).toBeGreaterThan(built);
    expect(rethrown).toBeGreaterThan(written);
  });

  it('never records a gate that did not execute as a pass', () => {
    const source = harnessSource();
    // When the structural gate blocks there is no report, so semantic QA cannot
    // have run. NOT_RUN and PASS are different facts and the record must not
    // blur them — the same rule the cost fields now follow.
    expect(source).toContain("semanticQaStatus: qa?.status ?? 'NOT_RUN'");
    expect(source).toContain("structuralGate: structuralBlocker === null ? 'PASS' : 'BLOCKED'");
  });

  it('files a PROVIDER refusal on disk before the refusal propagates', () => {
    // The second refusal path, and the one a real run actually took: HTTP 200,
    // no content, 700 seconds — and no file, because this branch only printed.
    // The builder pins every gate NOT_RUN itself (see its own tests); what only
    // the harness source can show is that the record is sanitized, cost-checked
    // and WRITTEN before the error leaves.
    const source = harnessSource();
    const caught = source.indexOf('if (error instanceof NarrativeProviderError) {');
    const built = source.indexOf('buildProviderRefusalEvidence({', caught);
    const sanitized = source.indexOf('assertEvidenceSanitized(refusalEvidence', built);
    const capped = source.indexOf('assertObservedCostWithinCap(refusalEvidence)', built);
    const written = source.indexOf('refusalEvidence.canonicalJson', built);
    const rethrown = source.indexOf('throw error;', written);

    expect(caught).toBeGreaterThan(-1);
    expect(built).toBeGreaterThan(caught);
    expect(sanitized).toBeGreaterThan(built);
    expect(capped).toBeGreaterThan(built);
    expect(written).toBeGreaterThan(Math.max(sanitized, capped));
    expect(rethrown).toBeGreaterThan(written);
  });

  it('asks for the reasoning effort it records, on both the accepted and the refused path', () => {
    // A record that states one effort while the request carried another would
    // be evidence of nothing. Both paths read the same constant the request does.
    const source = harnessSource();
    expect(source).toContain('reasoningEffort: LIVE_REASONING_EFFORT,');
    expect(source).toContain('generateNarrativeFromPlan(chain.brief, plan, liveTransport, LIVE_OPTIONS)');
    expect(source.split('requestedReasoningEffort: LIVE_REASONING_EFFORT,').length - 1).toBe(2);
  });
});

describe('ETBZ-25B: the prompt and the QA gate read one policy, and neither reads the other', () => {
  // The prompt has to ANNOUNCE the floors the gate judges, so two modules read
  // the same five numbers. v1 let each keep its own copy and they drifted: R7
  // asked for one chart term per paragraph while the gate blocked anything
  // under two, and the report-wide floor of four was stated nowhere at all.
  //
  // The fix is a shared policy module, not an import from the prompt into the
  // gate or back. This test is what keeps it that way: either direction would
  // work today and would make the prompt builder depend on `report-model.ts`
  // and the error types for the sake of five numbers.
  const POLICY = 'src/application/interpretation/narrative-qa-policy.ts';
  const PROMPT = 'src/application/interpretation/prompt-policy.ts';
  const QA = 'src/application/interpretation/semantic-qa.ts';

  function importsOf(path: string): readonly string[] {
    // The same parser every other rule in this file uses: a specifier written
    // across several lines sits outside any single-line text pattern.
    return collectModuleSpecifiers(parseFile(resolve(REPO_ROOT, path)));
  }

  it('the policy module imports nothing at all', () => {
    // What makes it safe for both sides to import. A policy that reached for
    // the lexicon or the report model would drag that graph into the prompt.
    expect(importsOf(POLICY)).toEqual([]);
  });

  it('both readers import the policy module', () => {
    expect(importsOf(PROMPT)).toContain('./narrative-qa-policy.js');
    expect(importsOf(QA)).toContain('./narrative-qa-policy.js');
  });

  it('the prompt does not import the QA gate, and the gate does not import the prompt', () => {
    expect(importsOf(PROMPT)).not.toContain('./semantic-qa.js');
    expect(importsOf(QA)).not.toContain('./prompt-policy.js');
  });

  it('guard self-check: the extractor really sees this file’s imports', () => {
    // Every assertion above is an absence except one; an extractor returning []
    // for everything would satisfy all of them.
    expect(importsOf(PROMPT)).toContain('./semantic-qa-lexicon.js');
    expect(importsOf(QA)).toContain('./report-model.js');
  });
});
