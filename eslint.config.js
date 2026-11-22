import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // This repository's own code only: never the data folders, whose AI workspaces hold the
    // repositories under review, nor built or generated output.
    ignores: [
      '.data*/**',
      '**/dist/**',
      '**/dev-dist/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/coverage/**',
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
);
