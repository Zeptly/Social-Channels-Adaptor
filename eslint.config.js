import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "migrations/**", "openapi/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: "module" },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
