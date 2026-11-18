import { defineConfig } from "vite-plus";

const TESTING_ONLY = [
  {
    group: ["@keypin/**/testing", "./testing", "./testing/*", "../testing", "../testing/*"],
    message: "testing modules hold fakes for tests; production code must not import them",
  },
];

const GUARDRAILS = "See docs/development.md#guardrails.";

const CONNECTORS = [
  "@keypin/destination-*",
  "@keypin/issuer-*",
  "@keypin/vault-*",
  "@keypin/connectors*",
  "@keypin/connectors/**",
];

const NO_CONNECTORS_IN_CORE = [
  {
    group: CONNECTORS,
    message: `core defines the contracts and connectors implement them; register the connector in apps/cli/src/start.ts instead. ${GUARDRAILS}`,
  },
];

const ONLY_CORE_IN_CONNECTORS = [
  {
    group: ["@keypin/**", "!@keypin/core"],
    message: `A connector imports only @keypin/core among keypin packages; move shared code into packages/core. ${GUARDRAILS}`,
  },
  {
    group: ["..", "../**", "**/../**"],
    message: `A provider folder imports only its own files; move code two providers share into packages/core. ${GUARDRAILS}`,
  },
];

const CONNECTORS_IN_COMPOSITION = [
  {
    group: CONNECTORS,
    message: `Only apps/cli/src/start.ts and sign-in.ts import @keypin/connectors; take the connector from deps (deps.vault(), deps.destination(), deps.issuer(), deps.destinations, deps.vaults) instead. ${GUARDRAILS}`,
  },
];

const NO_OUTSIDE_WORLD = [
  {
    group: [
      "fs",
      "fs/*",
      "node:fs",
      "node:fs/*",
      "child_process",
      "node:child_process",
      "net",
      "node:net",
      "http",
      "node:http",
      "https",
      "node:https",
      "bun",
      "bun:*",
      "process",
      "node:process",
      "os",
      "node:os",
      "crypto",
      "node:crypto",
      "perf_hooks",
      "node:perf_hooks",
      "dns",
      "node:dns",
      "dns/*",
      "node:dns/*",
      "tls",
      "node:tls",
      "dgram",
      "node:dgram",
      "worker_threads",
      "node:worker_threads",
      "readline",
      "node:readline",
      "readline/*",
      "node:readline/*",
      "tty",
      "node:tty",
      "vm",
      "node:vm",
    ],
    message: `Core and commands don't touch files, processes, the network, the environment, the clock or randomness; take them from deps (deps.env, deps.files, deps.launch, deps.now(), deps.vault()…) so they stay testable. ${GUARDRAILS}`,
  },
];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  test: { env: { TZ: "UTC" } },
  lint: {
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "keypin", specifier: "./lint-plugin.ts" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "keypin/no-comments": "error",
      "keypin/no-reveal": "error",
      "keypin/no-ambient": "error",
      "keypin/no-hidden-clock": "error",
      "typescript/no-explicit-any": "error",
      "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "typescript/no-non-null-assertion": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "typescript/switch-exhaustiveness-check": "error",
      "no-console": "error",
    },
    overrides: [
      {
        files: ["packages/*/src/**", "apps/*/src/**"],
        rules: { "no-restricted-imports": ["error", { patterns: TESTING_ONLY }] },
      },
      {
        files: ["packages/core/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: ["bun"],
              patterns: [
                { group: ["bun:*"] },
                ...TESTING_ONLY,
                ...NO_CONNECTORS_IN_CORE,
                ...NO_OUTSIDE_WORLD,
              ],
            },
          ],
        },
      },
      {
        files: ["packages/connectors/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            { patterns: [...TESTING_ONLY, ...ONLY_CORE_IN_CONNECTORS] },
          ],
        },
      },
      {
        files: ["apps/cli/src/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            { patterns: [...TESTING_ONLY, ...CONNECTORS_IN_COMPOSITION] },
          ],
        },
      },
      {
        files: ["apps/cli/src/commands/**"],
        rules: {
          "no-restricted-imports": [
            "error",
            { patterns: [...TESTING_ONLY, ...CONNECTORS_IN_COMPOSITION, ...NO_OUTSIDE_WORLD] },
          ],
        },
      },
      {
        files: ["apps/cli/src/start.ts", "apps/cli/src/sign-in.ts"],
        rules: { "no-restricted-imports": ["error", { patterns: TESTING_ONLY }] },
      },
      {
        files: ["packages/*/src/**", "apps/*/src/**"],
        rules: { "keypin/no-error-text-matching": "error" },
      },
    ],
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
  },
});
