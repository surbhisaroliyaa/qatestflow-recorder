import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // Local-only scratch folders (both gitignored). ESLint doesn't read
      // .gitignore, so they inflated the count the audit saw.
      '.qa-audit/**',
      'Recorded/**',
      // Test output, written by the DOM suite / export gate while they run.
      'test-results/**',
      'playwright-report/**',
      '.export-gate/**',
      // GOLDEN files: the exact bytes the exporter must produce. They are specs
      // a user receives, compared byte-for-byte — not this repo's own code.
      'test/__snapshots__/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // `const { secret: _secret, ...rest } = step` — naming a field only to
      // leave it OUT of `rest` is the idiomatic way to omit a key. This option
      // exists for exactly that pattern; everything else unused still reports.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }]
    }
  },
  {
    // Plain-JavaScript tool scripts: there is no type to annotate a return with.
    files: ['**/*.{js,mjs,cjs}'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  eslintConfigPrettier,
  // QF-009: formatting is checked by `npm run format:check` (prettier --check),
  // NOT by lint. Reported through ESLint, 3,300+ formatting warnings buried
  // the handful of real findings — the exact failure the audit described.
  { rules: { 'prettier/prettier': 'off' } }
)
