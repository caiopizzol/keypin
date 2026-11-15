import { describe, expect, test } from "vite-plus/test";
import { type Drive, drive } from "./drive";
import { FAKE_TOKEN, ready, valuesOf } from "./scenarios";

const SLOW = 30_000;
const FINISHED = /^[✓✗] /;

function clean(result: Drive): void {
  expect(result.leaks).toEqual([]);
  expect(result.overlong).toEqual([]);
}

describe("the leak check", () => {
  test("knows a .env value the way keypin parses it: quoted, commented or padded", () => {
    const values = valuesOf({
      ...ready,
      files: {
        ".env": [
          'RESEND_API_KEY="review-secret-sentinel" # test fixture',
          "  export SENTRY_DSN = 'single-quoted-sentinel'  ",
          "TOKEN=bare-sentinel-value # note",
          "PORT=3000",
        ].join("\n"),
      },
    });
    expect(values).toEqual(
      expect.arrayContaining([
        "review-secret-sentinel",
        "single-quoted-sentinel",
        "bare-sentinel-value",
      ]),
    );
    expect(values).not.toContain("3000");
  });

  test(
    "flags a run that prints a quoted .env value",
    async () => {
      const result = await drive({
        scenario: "quoted-env",
        args: ["run", "--", "cat", ".env"],
      });
      expect(result.leaks).toEqual(["review-secret-sentinel"]);
    },
    SLOW,
  );
});

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
    "with a service account, check shows no approval hint, notes my.1password.com, and leaks no token",
    async () => {
      const result = await drive({
        scenario: "service-account",
        args: ["check"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toMatch(
        /^✓ Looked up 2 items in 1Password account my\.1password\.com, not the values/m,
      );
      expect(result.frames.some((frame) => frame.includes("Looking up"))).toBe(true);
      expect(result.raw).not.toContain("approve keypin");
      expect(result.screen).toContain(
        "Note: individual 1Password accounts share the sign-in address my.1password.com",
      );
      clean(result);
    },
    SLOW,
  );

  test(
    "with a service account, import saves the new item to 1Password",
    async () => {
      const result = await drive({
        scenario: "service-account",
        args: ["import", ".env", "RESEND_API_KEY", "--vault", "Deploy", "--yes"],
      });
      expect(result.exit).toBe(0);
      expect(result.effects).toEqual([
        "1password create my.1password.com/Deploy/billing dev resend api key (18 chars)",
      ]);
      expect(result.screen).not.toContain("desktop app");
      clean(result);
    },
    SLOW,
  );

  test(
    "with a service account, rotate creates the key, saves it to 1Password, publishes and revokes",
    async () => {
      const result = await drive({
        scenario: "resend-service-account",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.effects).toEqual([
        "resend create re-new-1",
        "1password update my.1password.com/Deploy/mailer resend key (20 chars)",
        "destination write github-actions:acme/mailer RESEND_API_KEY (20 chars)",
        "destination write cloudflare-worker:mailer RESEND_API_KEY (20 chars)",
        "resend revoke re-old",
      ]);
      expect(result.raw).not.toContain("approve keypin");
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
    "check without the 1Password desktop app says to install it, with no SDK trace",
    async () => {
      const result = await drive({ scenario: "no-1password-app", args: ["check"] });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        "1 Sign in to 1Password\n  Install the 1Password desktop app.\n",
      );
      expect(result.screen.match(/sign-in failed/g)).toHaveLength(1);
      expect(result.screen).not.toContain("critical error");
      expect(result.screen).not.toContain("find1PasswordLibPath");
      clean(result);
    },
    SLOW,
  );

  test(
    "on CI with only OP_SERVICE_ACCOUNT_TOKEN set, run says to set KEYPIN_1PASSWORD",
    async () => {
      const result = await drive({
        scenario: "no-1password-app",
        args: ["run", "--", "true"],
        env: { OP_SERVICE_ACCOUNT_TOKEN: FAKE_TOKEN },
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        "the 1Password desktop app isn't installed; OP_SERVICE_ACCOUNT_TOKEN is set, so set KEYPIN_1PASSWORD=service-account to use the service account",
      );
      expect(result.screen).not.toContain(FAKE_TOKEN);
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
        "1password create my.1password.com/Private/billing dev resend api key (18 chars)",
      ]);
      expect(result.files["keypin.toml"]).toContain("[keys.RESEND_API_KEY]");
      clean(result);
    },
    SLOW,
  );

  test(
    "with Infisical, run, status and publish read from the organization and leak nothing",
    async () => {
      const where = "Infisical organization acme at https://app.infisical.com";
      const run = await drive({
        scenario: "infisical",
        args: ["run", "--", "sh", "-c", "env | grep -c INFISICAL_UNIVERSAL_AUTH || true"],
      });
      expect(run.exit).toBe(0);
      expect(run.screen).toMatch(new RegExp(`^✓ Read 1 dev value from ${where}`, "m"));
      expect(run.screen).toMatch(/^0$/m);
      const status = await drive({ scenario: "infisical", args: ["status"] });
      expect(status.screen).toContain(`✓ Read 2 rotated dates from ${where}, not the values`);
      expect(status.screen).toContain("STRIPE_KEY  prod  due in 5 days");
      const publish = await drive({
        scenario: "infisical",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(publish.exit).toBe(0);
      expect(publish.screen).toContain(`from infisical://billing/prod/STRIPE_KEY in ${where}`);
      expect(publish.effects).toEqual([
        "destination write github-actions:acme/billing STRIPE_KEY (23 chars)",
      ]);
      for (const result of [run, status, publish]) {
        expect(result.screen).not.toContain("1Password");
        clean(result);
      }
    },
    SLOW,
  );

  test(
    "with Infisical, check and run need no 1Password token, though KEYPIN_1PASSWORD=service-account",
    async () => {
      const env = { KEYPIN_1PASSWORD: "service-account" };
      const check = await drive({ scenario: "infisical", args: ["check"], env });
      expect(check.exit).toBe(0);
      expect(check.screen).toContain("Everything checks out.");
      const run = await drive({ scenario: "infisical", args: ["run", "--", "true"], env });
      expect(run.exit).toBe(0);
      for (const result of [check, run]) {
        expect(result.screen).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
        clean(result);
      }
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

describe("keypin rotate in a real terminal", () => {
  test(
    "creates at Resend, saves, publishes, then revokes the old key after a second y",
    async () => {
      const result = await drive({
        scenario: "resend",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  - Resend                   revoke the old key re-old, after a second y",
      );
      expect(result.screen).toContain("Rotate RESEND_API_KEY? [y/N] y");
      expect(result.screen).toContain("Revoke the old key at Resend? [y/N] y");
      expect(result.screen).toMatch(/^✓ Resend {2}revoked re-old {2}\d+\.\ds$/m);
      expect(result.effects).toEqual([
        "resend create re-new-1",
        "1password update my.1password.com/Private/mailer resend key (20 chars)",
        "destination write github-actions:acme/mailer RESEND_API_KEY (20 chars)",
        "destination write cloudflare-worker:mailer RESEND_API_KEY (20 chars)",
        "resend revoke re-old",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Neon: resets the idle role, publishes its URL, then resets the old role after a second y",
    async () => {
      const result = await drive({
        scenario: "neon",
        args: ["rotate", "DATABASE_URL"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "    resets the password of role app_b, which the vault's URL doesn't use; every open connection drops",
      );
      expect(result.screen).toContain(
        "  - Neon                      revoke the old key app_a@2026-11-15T12:00:00Z, after a second y\n    resets the password of role app_a: every connection string that uses app_a stops working, and every open connection drops",
      );
      expect(result.screen).toMatch(/^✓ Neon {2}revoked app_a@2026-11-15T12:00:00Z {2}\d+\.\ds$/m);
      expect(result.effects).toEqual([
        "neon reset app_b",
        "1password update my.1password.com/Private/app database url (135 chars)",
        "destination write github-actions:acme/billing DATABASE_URL (135 chars)",
        "destination write cloudflare-worker:billing DATABASE_URL (135 chars)",
        "neon reset app_a",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Neon: a role missing from the branch stops before any reset",
    async () => {
      const result = await drive({ scenario: "neon-one-role", args: ["rotate", "DATABASE_URL"] });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        "    Neon branch br-main-a1b2c3d4 has no role app_b\n    fix: create app_b with SQL, in the same group role as the other (see docs/configuration.md#neon)",
      );
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "a key read from the password field saves the new key to that field",
    async () => {
      const result = await drive({
        scenario: "resend-password",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.effects).toContain(
        "1password update my.1password.com/Private/mailer resend key (20 chars)",
      );
      clean(result);
    },
    SLOW,
  );

  test(
    "a key limited to one domain is created for that domain",
    async () => {
      const result = await drive({
        scenario: "resend-domain",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y", "n"],
      });
      expect(result.exit).toBe(0);
      expect(result.effects[0]).toBe("resend create re-new-1 for domain dom-verify");
      clean(result);
    },
    SLOW,
  );

  test(
    "a destination that left the map is named in the plan and again before the revoke prompt",
    async () => {
      const result = await drive({
        scenario: "resend-removed",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y", "n"],
      });
      expect(result.exit).toBe(0);
      const gone =
        "- github-actions:acme/mailer:RESEND_API_KEY: not in the map any more (last got 5f85700cd2d85825 at 2026-08-01T12:00:00.000Z). keypin doesn't delete it.";
      expect(result.screen.split(gone)).toHaveLength(3);
      expect(result.screen).toContain(
        "the new key is in 1Password and the destination in the map.\nNot in the map any more, so keypin didn't write them; they may still use the old key:",
      );
      expect(result.screen.lastIndexOf(gone)).toBeLessThan(
        result.screen.indexOf("Revoke the old key at Resend?"),
      );
      expect(result.effects).toEqual([
        "resend create re-new-1",
        "1password update my.1password.com/Private/mailer resend key (20 chars)",
        "destination write cloudflare-worker:mailer RESEND_API_KEY (20 chars)",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "declining the revoke keeps the old key and prints the command for later",
    async () => {
      const result = await drive({
        scenario: "resend",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y", "n"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "To revoke it later, run this in a terminal:\n  cd <sandbox>/billing && keypin rotate RESEND_API_KEY",
      );
      expect(result.effects.some((e) => e.startsWith("resend revoke"))).toBe(false);
      clean(result);
    },
    SLOW,
  );

  test(
    "a create whose reply is lost names the key Resend made",
    async () => {
      const result = await drive({
        scenario: "resend-reply-lost",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toMatch(
        /^Stopped: keypin didn't get the new key back, but Resend lists key re-new-1, named RESEND_API_KEY prod \d{4}-\d{2}-\d{2}\. Delete it at https:\/\/resend\.com\/api-keys, then run this again:$/m,
      );
      expect(result.screen).not.toContain("Nothing was created");
      expect(result.effects).toEqual(["resend create re-new-1"]);
      clean(result);
    },
    SLOW,
  );

  test(
    "a destination that fails stops before the revoke, with the new key saved",
    async () => {
      const result = await drive({
        scenario: "resend-worker-down",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toMatch(
        /^✗ Cloudflare {2}mailer {7}writing RESEND_API_KEY {2}\d+\.\ds$/m,
      );
      expect(result.screen).toContain(
        "Stopped. The new key is in 1Password, and the old key still works. To continue, run:",
      );
      expect(result.screen).not.toContain("Revoke the old key");
      expect(result.effects).toEqual([
        "resend create re-new-1",
        "1password update my.1password.com/Private/mailer resend key (20 chars)",
        "destination write github-actions:acme/mailer RESEND_API_KEY (20 chars)",
      ]);
      clean(result);
    },
    SLOW,
  );
});
