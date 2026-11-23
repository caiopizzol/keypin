import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    platform: "neutral",
    tsconfig: "../../tsconfig.rules.json",
    dts: true,
    hash: false,
    outputOptions: {
      codeSplitting: {
        groups: [
          {
            name: "rules",
            test: /[\\/](core|connectors)[\\/]src[\\/].*(?<!\.d)\.ts$|[\\/]smol-toml[\\/]/,
          },
          { name: "load-map", test: /[\\/]rules[\\/]src[\\/]load-map\.ts$/ },
        ],
      },
    },
  },
});
