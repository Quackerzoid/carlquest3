import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  // .superpowers/ holds git-ignored session scratch (debug scripts, ledgers) — not project code.
  { ignores: ['**/dist/**', '**/node_modules/**', '.superpowers/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
);
