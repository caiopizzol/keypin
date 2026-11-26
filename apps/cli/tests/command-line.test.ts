import { describe, expect, test } from "vite-plus/test";
import { commandLine, terminalCommand } from "../src/approval";
import { fakeDeps } from "./fakes";

const RUN = "/opt/bun/bin/bun --no-env-file /home/me/keypin/apps/cli/src/main.ts rotate A";

describe("a command keypin prints", () => {
  test("in a CI checkout, a retry keeps the runner's folder and a terminal hand-off names it from the checkout", () => {
    const { deps } = fakeDeps({ deps: { ciCheckout: "/work" } });
    expect(commandLine(deps, "rotate", ["A"])).toBe(`cd /work/billing && ${RUN}`);
    expect(terminalCommand(deps, "rotate", ["A"])).toBe(`cd billing && ${RUN}`);
  });

  test("at the checkout's root, the terminal hand-off has no cd", () => {
    const { deps } = fakeDeps({ deps: { ciCheckout: "/work/billing" } });
    expect(terminalCommand(deps, "rotate", ["A"])).toBe(RUN);
    expect(commandLine(deps, "rotate", ["A"])).toBe(`cd /work/billing && ${RUN}`);
  });

  test("outside CI, or in a folder outside the checkout, both keep the full folder", () => {
    for (const ciCheckout of [null, "/elsewhere"]) {
      const { deps } = fakeDeps({ deps: { ciCheckout } });
      expect(terminalCommand(deps, "rotate", ["A"])).toBe(`cd /work/billing && ${RUN}`);
    }
  });
});
