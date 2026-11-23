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
          { name: "core", test: /[\\/]core[\\/]src[\\/].*(?<!\.d)\.ts$|[\\/]smol-toml[\\/]/ },
          {
            name: "kinds",
            test: /[\\/](connectors[\\/]src[\\/].*(?<!\.d)|rules[\\/]src[\\/]load-map)\.ts$/,
          },
        ],
      },
    },
  },
});
