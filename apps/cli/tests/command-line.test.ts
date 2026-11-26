import { describe, expect, test } from "vite-plus/test";
import { commandLine, inTerminal, terminalCommand } from "../src/approval";
import { fakeDeps } from "./fakes";

const RUN = "/opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts rotate A";

describe("a command keypin prints", () => {
  test("in a CI checkout, a retry keeps the runner's folder and keypin", () => {
    const { deps } = fakeDeps({ deps: { ciCheckout: "/work" } });
    expect(commandLine(deps, "rotate", ["A"])).toBe(`cd /work/billing && ${RUN}`);
  });

  test("in a CI checkout, a terminal hand-off says where to run it, with no cd, and runs keypin from npm", () => {
    const { deps } = fakeDeps({ deps: { ciCheckout: "/work" } });
    expect(inTerminal(deps)).toBe("in a terminal, from billing/ in your checkout");
    expect(terminalCommand(deps, "rotate", ["A"])).toBe("npx keypin@0.39.0 rotate A");
    const atRoot = fakeDeps({ deps: { ciCheckout: "/work/billing" } }).deps;
    expect(inTerminal(atRoot)).toBe("in a terminal, from your checkout's root");
    expect(terminalCommand(atRoot, "rotate", ["A"])).toBe("npx keypin@0.39.0 rotate A");
  });

  test("a keypin the runner found on its PATH stays keypin in the hand-off", () => {
    const { deps } = fakeDeps({ deps: { ciCheckout: "/work" } });
    const onPath = { ...deps, self: { ...deps.self, command: ["keypin"] } };
    expect(terminalCommand(onPath, "rotate", ["A"])).toBe("keypin rotate A");
  });

  test("outside CI, or in a folder outside the checkout, the hand-off is the same as a retry", () => {
    for (const ciCheckout of [null, "/elsewhere"]) {
      const { deps } = fakeDeps({ deps: { ciCheckout } });
      expect(inTerminal(deps)).toBe("in a terminal");
      expect(terminalCommand(deps, "rotate", ["A"])).toBe(`cd /work/billing && ${RUN}`);
    }
  });
});
