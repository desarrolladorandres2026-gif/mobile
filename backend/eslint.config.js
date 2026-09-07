// @ts-check
const tseslint = require('typescript-eslint');

/**
 * Minimal config: this project had `lint` wired to a script but no ESLint
 * installed at all, so `npm run lint` had never actually run once. This
 * turns it on with `recommended` only — real-bug rules (unreachable code,
 * unresolved promises treated as booleans, shadowed variables) — not a
 * stylistic rule set. Introducing a full style guide across ~130
 * pre-existing files is a separate decision from getting the command to
 * work; scoping it this way surfaces genuine issues without demanding an
 * unrelated repo-wide reformat as a side effect of a payments audit.
 */
module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // TS's own noUnusedLocals/noUnusedParameters (tsconfig) already cover
      // this more precisely (they know about `_`-prefixed intentional
      // unused params, which this rule does not out of the box).
      '@typescript-eslint/no-unused-vars': 'off',
      // The codebase leans on `any` deliberately at Mongoose/Express
      // boundaries (req.user as any, populated refs, etc.) — flagging every
      // instance is noise, not signal, for this pass.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
