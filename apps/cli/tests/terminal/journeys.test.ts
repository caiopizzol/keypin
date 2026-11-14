import { describe, expect, test } from "vite-plus/test";
import { type Drive, drive } from "./drive";

const SLOW = 30_000;
const FINISHED = /^[✓✗] /;

function clean(result: Drive): void {
  expect(result.leaks).toEqual([]);
  expect(result.overlong).toEqual([]);
}

describe("keypin in a real terminal", () => {
  test(
    "publish shows the plan, asks [y/N], and y writes once",
    async () => {
      const result = await drive({
        scenario: "ready",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain("  + GitHub  acme/billing  first write  needs approval");
      expect(result.screen).toContain("Write 1 secret? [y/N] y");
      expect(result.screen).toMatch(/^✓ GitHub {2}acme\/billing {2}wrote STRIPE_KEY {2}\d+\.\ds$/m);
      expect(result.effects).toEqual([
        "destination write github-actions:acme/billing STRIPE_KEY (23 chars)",
      ]);
      expect(result.files[".local/state/keypin/state.json"]).toContain("STRIPE_KEY");
      clean(result);
    },
    SLOW,
  );

  test(
    "publish answered with anything but y writes nothing and exits 3",
    async () => {
      for (const answer of ["n", "", "yess"]) {
        const result = await drive({
          scenario: "ready",
          args: ["publish", "STRIPE_KEY"],
          answers: [answer],
        });
        expect(result.exit).toBe(3);
        expect(result.screen).toContain("Not confirmed. Nothing was written.");
        expect(result.effects).toEqual([]);
        clean(result);
      }
    },
    SLOW,
  );

  test(
    "each spinner ends as one finished line with a mark and a time",
    async () => {
      const result = await drive({ scenario: "ready", args: ["check"] });
      expect(result.exit).toBe(0);
      const steps = result.screen.split("\n").filter((line) => FINISHED.test(line));
      expect(steps).toEqual([
        expect.stringMatching(
          /^✓ Looked up 2 items in 1Password account my\.1password\.com, not the values {2}\d+\.\ds$/,
        ),
        expect.stringMatching(/^✓ Checked 1 account {2}\d+\.\ds$/),
        "✓ 1 key, 1 destination. Everything checks out.",
      ]);
      expect(result.screen).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      clean(result);
    },
    SLOW,
  );

  test(
    "while 1Password is slow, the approval hint shows and no frame wraps at 60 columns",
    async () => {
      const result = await drive({
        scenario: "slow-1password",
        args: ["run", "--", "true"],
        cols: 60,
      });
      expect(result.exit).toBe(0);
      expect(result.frames.some((frame) => frame.includes("1Password may be asking"))).toBe(true);
      clean(result);
    },
    SLOW,
  );

  test(
    "an account 1Password doesn't have: failed steps say so, and check says to fix the map",
    async () => {
      const result = await drive({ scenario: "unknown-account", args: ["check"] });
      expect(result.exit).toBe(1);
      expect(result.screen).toMatch(
        /^✗ Couldn't look up 2 of 2 items in 1Password account no-such-account\.invalid/m,
      );
      expect(result.screen).toMatch(/^✗ 1 of 1 account failed the check/m);
      expect(result.screen).toContain("1 Sign in to GitHub\n");
      expect(result.screen).toContain(
        "2 Sign in to 1Password\n  Set account under [1password] in keypin.toml",
      );
      expect(result.screen).not.toContain("Fix the login");
      expect(result.screen).not.toContain("Error {");
      clean(result);
    },
    SLOW,
  );

  test(
    "status names a sign-in failure once and places by name",
    async () => {
      const failed = await drive({ scenario: "unknown-account", args: ["status"] });
      expect(failed.exit).toBe(1);
      expect(failed.screen.match(/sign-in failed/g)).toHaveLength(1);
      const ready = await drive({ scenario: "ready", args: ["status"] });
      expect(ready.screen).toContain("not published yet to GitHub acme/billing;");
      expect(ready.screen).not.toContain("github-actions:");
      clean(failed);
      clean(ready);
    },
    SLOW,
  );

  test(
    "import shows its plan, asks [y/N], creates the item, and maps the key",
    async () => {
      const result = await drive({
        scenario: "env-file",
        args: ["import", ".env", "RESEND_API_KEY", "--vault", "Private"],
        answers: ["y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain("Create 1 item in 1Password? [y/N] y");
      expect(result.effects).toEqual([
        "1password create my.1password.com/Private/billing dev resend api key",
      ]);
      expect(result.files["keypin.toml"]).toContain("[keys.RESEND_API_KEY]");
      clean(result);
    },
    SLOW,
  );

  test(
    "init in an empty repository writes the template, registers it, and says what's next",
    async () => {
      const result = await drive({ scenario: "fresh", args: ["init"] });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain("✓ wrote <sandbox>/billing/keypin.toml");
      expect(result.screen).toContain("Next: keypin check");
      expect(result.files[".config/keypin/registry.json"]).toContain("<sandbox>/billing");
      clean(result);
    },
    SLOW,
  );

  test(
    "a typo gets a suggestion and exit 2",
    async () => {
      const result = await drive({ scenario: "ready", args: ["chek"] });
      expect(result.exit).toBe(2);
      expect(result.screen).toContain('unknown command "chek". Did you mean check?');
    },
    SLOW,
  );

  test(
    "without a terminal, or with NO_COLOR, there are no escape codes and steps read ok or FAILED",
    async () => {
      const plain = await drive({ scenario: "unknown-account", args: ["check"], plain: true });
      const noColor = await drive({
        scenario: "unknown-account",
        args: ["check"],
        env: { NO_COLOR: "1" },
      });
      for (const result of [plain, noColor]) {
        expect(result.raw).not.toContain("\x1b[");
        expect(result.screen).toMatch(/^FAILED Couldn't look up/m);
      }
    },
    SLOW,
  );
});
