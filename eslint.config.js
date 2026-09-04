// =============================================================================
// ETBZ-9 lint contract.
//
// Scope: DEFECT DETECTION ONLY. No formatting policy, no style opinions - the
// editor contract lives in `.editorconfig` and is deliberately not enforced
// here.
//
// This gate must earn its place next to `tsc --noEmit`. A lint configuration
// that only restates the compiler is ceremony, so the rules below are the ones
// the type checker structurally cannot express: whether a produced value is
// DISCARDED. `tsc` happily accepts a promise that is never awaited and never
// caught; in an Express service that is a silently swallowed rejection.
// =============================================================================
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Generated and transient output is never source.
    ignores: ['dist/**', 'coverage/**', '.etbz-verify/**', 'docs/evidence/run/**'],
  },
  {
    // This configuration file itself - kept lintable so the gate has no blind
    // spot in its own definition.
    files: ['**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        // Type-aware linting. Without it the rules below degrade to no-ops,
        // which would make the gate silently weaker than it claims to be.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- type-aware defect rules, not expressible as `tsc --noEmit` -------
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    },
  },
);
