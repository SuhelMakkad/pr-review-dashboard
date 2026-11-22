import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Never the default data folders, nor built or generated output.
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
    // Named by where this repository keeps its code, so a data folder anywhere else (its AI
    // workspaces hold the repositories under review) is never in scope, whatever it is called.
    files: [
      'apps/*/{src,tests}/**/*.{ts,tsx,mts,cts}',
      'apps/*/*.{ts,mts,cts}',
      'packages/*/{src,tests}/**/*.{ts,tsx,mts,cts}',
      'tests/**/*.{ts,tsx,mts,cts}',
      '*.{ts,mts,cts}',
    ],
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
