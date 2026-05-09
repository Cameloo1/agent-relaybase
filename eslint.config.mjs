import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  AbortController: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  fetch: "readonly",
  module: "readonly",
  process: "readonly",
  require: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  structuredClone: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly"
};

export default [
  {
    ignores: ["coverage/**", "node_modules/**", "*.tgz"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs"
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  }
];
