import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "keypin", specifier: "./lint-plugin.ts" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "keypin/no-comments": "error",
      "keypin/no-reveal": "error",
      "typescript/no-explicit-any": "error",
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "typescript/no-non-null-assertion": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "no-console": "error",
    },
    overrides: [
      {
        files: ["packages/core/src/**"],
        rules: { "no-restricted-imports": ["error", { paths: ["bun"], patterns: ["bun:*"] }] },
      },
    ],
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
  },
});
