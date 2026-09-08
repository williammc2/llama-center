import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The pages intentionally run their boot effect once ([] deps) and read
      // the latest cfg/detection through the mount-time closure — the
      // eslint-disable comments in the pages document that.
      'react-hooks/exhaustive-deps': 'warn',

      // The bridge Proxy and a couple of config casts genuinely need `any`.
      '@typescript-eslint/no-explicit-any': 'off',
      // `_`-prefixed params are intentional (unused bridge stubs, destructured
      // ids we strip) — don't flag them.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],

      // The react-hooks plugin now ships React *compiler* rules. They are
      // stricter than the classic rules and flag idioms this codebase uses on
      // purpose (setState-in-effect for external subscriptions, reading a ref
      // during render for the latest closure). Keep them visible as warnings
      // rather than build-blocking until we migrate each site deliberately.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
)
