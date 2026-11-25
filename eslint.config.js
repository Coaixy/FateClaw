import { fileURLToPath } from 'node:url'

import globals from 'globals'
import pluginJs from '@eslint/js'
import next from '@next/eslint-plugin-next'
import { defineConfig, globalIgnores } from 'eslint/config'
import tseslint from 'typescript-eslint'
import noCatchAll from 'eslint-plugin-no-catch-all'
import reactHooks from 'eslint-plugin-react-hooks'

export default defineConfig(
  globalIgnores(['**/dist/**', '**/.next/**', '**/out/**', '**/next-env.d.ts', 'groups/']),
  {
    files: ['apps/api/{src,tests}/**/*.{js,ts}'],
    extends: [pluginJs.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    plugins: { 'no-catch-all': noCatchAll },
    rules: {
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
      'no-useless-assignment': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-catch-all/no-catch-all': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['apps/{web,admin}/**/*.{js,mjs,ts,tsx}'],
    extends: [next.configs['core-web-vitals']],
    languageOptions: { parser: tseslint.parser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['apps/web/**/*'],
    settings: { next: { rootDir: fileURLToPath(new URL('./apps/web/', import.meta.url)) } },
  },
  {
    files: ['apps/admin/**/*'],
    settings: { next: { rootDir: fileURLToPath(new URL('./apps/admin/', import.meta.url)) } },
  },
)
