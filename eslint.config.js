import tsparser from "@typescript-eslint/parser";
import tsplugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Minimal flat config for ESLint 9.
 *
 * Scope is intentionally narrow: parse TypeScript/TSX, run `react-hooks`
 * rules (the most load-bearing correctness checks for this codebase),
 * and surface unused variables. We deliberately do *not* enable
 * `js.configs.recommended` here — without `globals` declared the
 * `no-undef` rule false-positives on browser globals, and we don't want
 * lint blocking PRs over noise. Tighten in M8 once the noise is gone.
 */
export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "src-tauri/**",
      "*.config.js",
      "*.config.ts",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsplugin,
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },
];
