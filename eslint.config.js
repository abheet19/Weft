// ESLint flat config for the Weft monorepo. Two jobs: typescript-eslint's recommended rules, and
// one house rule — `any` is allowed only when argued for in a `// any: <reason>` comment on the
// same line (LLD §9). The stock `no-explicit-any` stays an ERROR (S3 hardening, item 16): the one
// way to write `any` is to silence it for that line AND give the reason the house rule checks —
//   `x: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- any: <reason>`
// — so an unjustified `any` fails on the stock rule and a justified one is visible in the diff. The
// house rule is written inline so the repository carries no custom-plugin package.
import tseslint from 'typescript-eslint';

/** The house rule: every `any` keyword must share its line with an `any:` justification (after `//`, alone or behind an eslint-disable directive's `--`). */
const anyNeedsReason = {
  meta: {
    type: 'problem',
    docs: { description: 'forbid `any` unless the same line carries a `// any: <reason>` comment' },
    schema: [],
    messages: { needsReason: '`any` requires a same-line `// any: <reason>` comment (LLD §9).' },
  },
  create(context) {
    const lines = context.sourceCode.getText().split(/\r?\n/);
    return {
      TSAnyKeyword(node) {
        const line = lines[node.loc.start.line - 1] ?? '';
        if (!/\/\/.*\bany:/.test(line)) context.report({ node, messageId: 'needsReason' });
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', 'docs/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts'],
    plugins: { weft: { rules: { 'any-needs-reason': anyNeedsReason } } },
    rules: {
      // Both: the stock rule refuses every `any`; the house rule demands the reason on the line that silences it.
      '@typescript-eslint/no-explicit-any': 'error',
      'weft/any-needs-reason': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
