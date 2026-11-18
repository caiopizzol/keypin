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

  test("knows either Infisical access token", () => {
    const values = valuesOf({
      ...ready,
      env: {
        INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN: "universal-access-token-sentinel",
        INFISICAL_TOKEN: "infisical-token-sentinel",
      },
    });
    expect(values).toEqual(
      expect.arrayContaining(["universal-access-token-sentinel", "infisical-token-sentinel"]),
    );
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
    "publish to Supabase Edge Function secrets says functions read it with no redeploy",
    async () => {
      const result = await drive({
        scenario: "supabase-functions",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  + Supabase  abcdefghijklmnopqrst  first write  needs approval",
      );
      expect(result.screen).toContain(
        "    Edge Functions read the new value at once, with no redeploy",
      );
      expect(result.effects).toEqual([
        "destination write supabase-functions:abcdefghijklmnopqrst STRIPE_KEY (23 chars)",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "check without KEYPIN_SUPABASE_ACCESS_TOKEN says how to sign in to Supabase",
    async () => {
      const result = await drive({ scenario: "supabase-functions-no-token", args: ["check"] });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("1 Sign in to Supabase");
      expect(result.screen).toContain("KEYPIN_SUPABASE_ACCESS_TOKEN, which isn't set");
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "publish to Vercel says new values need a new deployment, and triggers none",
    async () => {
      const result = await drive({
        scenario: "vercel",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  + Vercel  billing (production)  first write  needs approval",
      );
      expect(result.screen).toContain(
        "    Vercel uses the new value only in new deployments; redeploy to use it",
      );
      expect(result.effects).toEqual([
        "destination write vercel-project:billing/production STRIPE_KEY (23 chars)",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "check without KEYPIN_VERCEL_TOKEN says how to sign in to Vercel",
    async () => {
      const result = await drive({ scenario: "vercel-no-token", args: ["check"] });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("1 Sign in to Vercel");
      expect(result.screen).toContain("KEYPIN_VERCEL_TOKEN, which isn't set");
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "publish to Netlify says new values need a new build and deploy, and triggers none",
    async () => {
      const result = await drive({
        scenario: "netlify",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  + Netlify  billing.netlify.app (production)  first write  needs approval",
      );
      expect(result.screen).toContain(
        "    Netlify uses the new value only from the next build and deploy; redeploy to use it",
      );
      expect(result.effects).toEqual([
        "destination write netlify-project:billing.netlify.app/production STRIPE_KEY (23 chars)",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "publish to Railway says the new value waits for the next deploy, and deploys nothing",
    async () => {
      const result = await drive({
        scenario: "railway",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain("  + Railway  api (production)  first write  needs approval");
      expect(result.screen).toContain(
        "    Railway uses the new value only from the service's next deploy; deploy it to use it",
      );
      expect(result.effects).toEqual([
        "destination write railway-service:production/api STRIPE_KEY (23 chars)",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "check without KEYPIN_NETLIFY_TOKEN says how to sign in to Netlify",
    async () => {
      const result = await drive({ scenario: "netlify-no-token", args: ["check"] });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("1 Sign in to Netlify");
      expect(result.screen).toContain("KEYPIN_NETLIFY_TOKEN, which isn't set");
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "publish to Convex says every subscription is invalidated",
    async () => {
      const result = await drive({
        scenario: "convex",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain("  + Convex  happy-animal-123  first write  needs approval");
      expect(result.screen).toContain(
        "    Convex invalidates every subscription when a variable changes; cron definitions read it only on the next deploy",
      );
      expect(result.effects).toEqual([
        "destination write convex-deployment:happy-animal-123.convex.cloud STRIPE_KEY (23 chars)",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "check without KEYPIN_CONVEX_DEPLOY_KEY says how to sign in to Convex",
    async () => {
      const result = await drive({ scenario: "convex-no-key", args: ["check"] });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("1 Sign in to Convex");
      expect(result.screen).toContain("KEYPIN_CONVEX_DEPLOY_KEY, which isn't set");
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "publish to Fly.io says Machines use the value only after fly secrets deploy",
    async () => {
      const result = await drive({
        scenario: "fly",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain("  + Fly.io  billing-api  first write  needs approval");
      expect(result.screen).toContain(
        "    Fly.io stages the new value; Machines use it only after fly secrets deploy or the app's next deploy, which keypin doesn't run",
      );
      expect(result.effects).toEqual([
        "destination write fly-app:billing-api STRIPE_KEY (23 chars)",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "check without KEYPIN_FLY_API_TOKEN says how to sign in to Fly.io",
    async () => {
      const result = await drive({ scenario: "fly-no-token", args: ["check"] });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("1 Sign in to Fly.io");
      expect(result.screen).toContain("KEYPIN_FLY_API_TOKEN, which isn't set");
      expect(result.effects).toEqual([]);
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
    "a copied workflow's optional keys in ignore leave check green, with one note",
    async () => {
      const result = await drive({ scenario: "ignored-keys", args: ["check"] });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain("✓ 1 key, 1 destination. Everything checks out.");
      expect(result.screen).toContain("Note: keypin.toml ignores 2 keys");
      expect(result.screen).not.toContain("OPENAI_API_KEY");
      expect(result.screen).not.toContain("ANTHROPIC_API_KEY");
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
    "with Doppler, run and publish read from the workplace, and the token never leaks",
    async () => {
      const where = "Doppler workplace acme";
      const run = await drive({
        scenario: "doppler",
        args: ["run", "--", "sh", "-c", "env | grep -c DOPPLER_TOKEN || true"],
      });
      expect(run.exit).toBe(0);
      expect(run.screen).toMatch(new RegExp(`^✓ Read 1 dev value from ${where}`, "m"));
      expect(run.screen).toMatch(/^0$/m);
      const publish = await drive({
        scenario: "doppler",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(publish.exit).toBe(0);
      expect(publish.screen).toContain(`from doppler://billing/prd/STRIPE_KEY in ${where}`);
      expect(publish.effects).toEqual([
        "destination write github-actions:acme/billing STRIPE_KEY (23 chars)",
      ]);
      for (const result of [run, publish]) {
        expect(result.screen).not.toContain("1Password");
        clean(result);
      }
    },
    SLOW,
  );

  test(
    "with Bitwarden, run, status and publish read from the organization and leak nothing",
    async () => {
      const where =
        "Bitwarden organization 2f1d6c9e-8a3b-4c5d-9e7f-0a1b2c3d4e5f at https://vault.bitwarden.com";
      const run = await drive({
        scenario: "bitwarden",
        args: ["run", "--", "sh", "-c", "env | grep -c BWS_ACCESS_TOKEN || true"],
      });
      expect(run.exit).toBe(0);
      expect(run.screen).toMatch(new RegExp(`^✓ Read 1 dev value from ${where}`, "m"));
      expect(run.screen).toMatch(/^0$/m);
      const status = await drive({ scenario: "bitwarden", args: ["status"] });
      expect(status.screen).toContain(`✓ Read 2 rotated dates from ${where}, not the values`);
      expect(status.screen).toContain("STRIPE_KEY  prod  due in 5 days");
      const publish = await drive({
        scenario: "bitwarden",
        args: ["publish", "STRIPE_KEY"],
        answers: ["y"],
      });
      expect(publish.exit).toBe(0);
      expect(publish.screen).toContain(`from bitwarden://billing/STRIPE_KEY in ${where}`);
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
    "with an Infisical access token, check names it and run's command never sees it",
    async () => {
      const check = await drive({ scenario: "infisical-token", args: ["check"] });
      expect(check.exit).toBe(0);
      expect(check.screen).toContain(
        "Note: keypin signs in to Infisical with the access token in INFISICAL_TOKEN",
      );
      const run = await drive({
        scenario: "infisical-token",
        args: ["run", "--", "sh", "-c", "env | grep -c INFISICAL || true"],
      });
      expect(run.exit).toBe(0);
      expect(run.screen).toMatch(/^0$/m);
      for (const result of [check, run]) clean(result);
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
    "a key whose ID is another key: saves the secret then the ID, writes both to each destination, and warns about the gap",
    async () => {
      const result = await drive({
        scenario: "paired",
        args: ["rotate", "API_SECRET"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  ~ 1Password             save its ID to op://Private/api key id/credential, rotated today",
      );
      expect(result.screen).toContain(
        "GitHub acme/api, the Worker api get API_SECRET and API_KEY_ID one write after the other; a run that starts between them reads a mismatched pair. Pause new runs there until the rotation finishes.",
      );
      expect(result.effects).toEqual([
        "paired create AKID-1",
        "1password update my.1password.com/Private/api secret (19 chars)",
        "1password update my.1password.com/Private/api key id (6 chars)",
        "destination write github-actions:acme/api API_SECRET (19 chars)",
        "destination write github-actions:acme/api API_KEY_ID (6 chars)",
        "destination write cloudflare-worker:api API_SECRET (19 chars)",
        "destination write cloudflare-worker:api API_KEY_ID (6 chars)",
        "paired revoke AKID-0",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "AWS: replaces an IAM user's access key and its ID together, then deactivates and deletes the old key after a second y",
    async () => {
      const result = await drive({
        scenario: "aws",
        args: ["rotate", "AWS_SECRET_ACCESS_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "✓ AWS IAM  the vault holds access key AKIAAPPVERIFY0000001 of IAM user billing-app in account 123456789012",
      );
      expect(result.screen).toContain(
        "  - AWS IAM               revoke the old key AKIAAPPVERIFY0000001, after a second y\n    keypin deactivates it, then deletes it",
      );
      expect(result.effects).toEqual([
        "aws create billing-app/AKIANEWVERIFY0000001",
        "1password update my.1password.com/Private/app aws secret (24 chars)",
        "1password update my.1password.com/Private/app aws key id (20 chars)",
        "destination write github-actions:acme/billing AWS_SECRET_ACCESS_KEY (24 chars)",
        "destination write github-actions:acme/billing AWS_ACCESS_KEY_ID (20 chars)",
        "aws delete billing-app/AKIAAPPVERIFY0000001",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "AWS: a user with no free key slot stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "aws-full",
        args: ["rotate", "AWS_SECRET_ACCESS_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        "aws iam delete-access-key --user-name billing-app --access-key-id AKIAOTHERVERIFY00001",
      );
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "AWS: a lost create reply isn't retried, and says how to find the extra key",
    async () => {
      const result = await drive({
        scenario: "aws-lost",
        args: ["rotate", "AWS_SECRET_ACCESS_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("Run aws iam list-access-keys --user-name billing-app");
      expect(result.effects).toEqual(["aws create billing-app/AKIANEWVERIFY0000001"]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Twilio: replaces an API key and its SID together with the old key's permissions, then deletes the old key after a second y",
    async () => {
      const result = await drive({
        scenario: "twilio",
        args: ["rotate", "TWILIO_API_SECRET"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  + Twilio                create a new key\n    a Restricted key with the old key's 2 permissions",
      );
      expect(result.effects).toEqual([
        "twilio create SKfeed0000000000000000000000000001 restricted with /twilio/messaging/messages/create,/twilio/messaging/messages/read",
        "1password update my.1password.com/Private/app twilio secret (27 chars)",
        "1password update my.1password.com/Private/app twilio key sid (34 chars)",
        "destination write github-actions:acme/billing TWILIO_API_SECRET (27 chars)",
        "destination write github-actions:acme/billing TWILIO_API_KEY (34 chars)",
        "twilio delete SKa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Twilio: a lost create reply isn't retried, and names the key to delete",
    async () => {
      const result = await drive({
        scenario: "twilio-lost",
        args: ["rotate", "TWILIO_API_SECRET"],
        answers: ["y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("Twilio may have made the key before the reply was lost.");
      expect(result.effects).toEqual([
        "twilio create SKfeed0000000000000000000000000001 restricted with /twilio/messaging/messages/create,/twilio/messaging/messages/read",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Twilio: a Main key in the vault stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "twilio-main",
        args: ["rotate", "TWILIO_API_SECRET"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("Twilio's API makes only Standard and Restricted keys");
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "SendGrid: makes a key with the old key's scopes, publishes it, then deletes the old key after a second y",
    async () => {
      const result = await drive({
        scenario: "sendgrid",
        args: ["rotate", "SENDGRID_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  + SendGrid              create a new key\n    with the old key's 2 scopes",
      );
      expect(result.screen).toMatch(/^✓ SendGrid {2}revoked "mailer" {2}\d+\.\ds$/m);
      expect(result.effects).toEqual([
        "sendgrid create NewKey1Id with mail.send,templates.read",
        "1password update my.1password.com/Private/mailer sendgrid key (32 chars)",
        "destination write github-actions:acme/billing SENDGRID_API_KEY (32 chars)",
        "sendgrid revoke OldVerifyId",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "SendGrid: a lost create reply isn't retried, and names the key to delete",
    async () => {
      const result = await drive({
        scenario: "sendgrid-lost",
        args: ["rotate", "SENDGRID_API_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("SendGrid may have made the key before the reply was lost.");
      expect(result.effects).toEqual(["sendgrid create NewKey1Id with mail.send,templates.read"]);
      clean(result);
    },
    SLOW,
  );

  test(
    "SendGrid: a scope the admin key can't grant stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "sendgrid-billing",
        args: ["rotate", "SENDGRID_API_KEY"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        `key "mailer" has 1 scope the admin key doesn't have, so it can't give them to a new key: billing.read`,
      );
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "rotating the ID key points to the key that rotates it",
    async () => {
      const result = await drive({ scenario: "paired", args: ["rotate", "API_KEY_ID"] });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        'keypin rotate: key "API_KEY_ID" prod holds the ID of API_SECRET, and keypin rotates the two together. Run keypin rotate API_SECRET.',
      );
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

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
    "Supabase: creates a secret key, saves and publishes it, then deletes the old one after a second y",
    async () => {
      const result = await drive({
        scenario: "supabase",
        args: ["rotate", "SUPABASE_SECRET_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  - Supabase              revoke the old key key-backend, after a second y\n    Supabase can't undo deleting a secret key",
      );
      expect(result.screen).toContain("Revoke the old key at Supabase? [y/N] y");
      expect(result.effects).toEqual([
        "supabase create key-new-1",
        "1password update my.1password.com/Private/app supabase key (18 chars)",
        "destination write github-actions:acme/billing SUPABASE_SECRET_KEY (18 chars)",
        "supabase revoke key-backend",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Supabase: a create reply with only the key's prefix saves, publishes and deletes nothing",
    async () => {
      const result = await drive({
        scenario: "supabase-prefix-only",
        args: ["rotate", "SUPABASE_SECRET_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).not.toBe(0);
      expect(result.screen).toContain("didn't return its value");
      expect(result.effects).toEqual(["supabase create key-new-1"]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Cloudflare: copies the vault token's policies, IP filter and lifetime, publishes it, then deletes the old token after a second y",
    async () => {
      const result = await drive({
        scenario: "cloudflare",
        args: ["rotate", "CLOUDFLARE_API_TOKEN"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  + Cloudflare            create a new key\n    with the old token's 1 policy and IP filter; expiring 30 days after it starts",
      );
      expect(result.screen).toMatch(/^✓ Cloudflare {2}revoked "deploy" {2}\d+\.\ds$/m);
      expect(result.effects).toHaveLength(4);
      expect(result.effects[0]).toMatch(
        /^cloudflare create token 0001e+ with \[\{"effect":"allow",.*"permission_groups":\[\{"id":"e086da7e2179491d91ee5f35b3ca210a"\}\]\}\], condition \{"request\.ip":\{"in":\["192\.0\.2\.0\/24"\]\}\}, expires_on \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
      expect(result.effects.slice(1)).toEqual([
        "1password update my.1password.com/Private/deploy cloudflare token (20 chars)",
        "destination write github-actions:acme/billing CLOUDFLARE_API_TOKEN (20 chars)",
        `cloudflare delete token ${"a".repeat(32)}`,
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Google Cloud: copies the vault key's API targets and websites, publishes it, then deletes the old key after a second y",
    async () => {
      const result = await drive({
        scenario: "google",
        args: ["rotate", "GOOGLE_MAPS_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        `  + Google Cloud          create a new key\n    with the old key's API target maps-backend.googleapis.com and 2 websites`,
      );
      expect(result.screen).toMatch(
        /^✓ Google Cloud {2}revoked "Maps web" \(maps-web\) {2}\d+\.\ds$/m,
      );
      expect(result.effects).toHaveLength(4);
      expect(result.effects[0]).toMatch(
        /^google create projects\/481537286014\/locations\/global\/keys\/google-maps-api-key-prod-[\d-]+-[0-9a-f]{6} "GOOGLE_MAPS_API_KEY prod [\d-]+ [\d:]+ [0-9a-f]{6}" with \{"apiTargets":\[\{"service":"maps-backend\.googleapis\.com"\}\],"browserKeyRestrictions":\{"allowedReferrers":\["https:\/\/acme\.example\/\*","\*\.acme\.example\/\*"\]\}\}$/,
      );
      expect(result.effects.slice(1)).toEqual([
        "1password update my.1password.com/Private/maps api key (26 chars)",
        "destination write github-actions:acme/billing GOOGLE_MAPS_API_KEY (26 chars)",
        "google delete projects/481537286014/locations/global/keys/maps-web",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Google Cloud: a gcloud user login in the admin item stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "google-user-login",
        args: ["rotate", "GOOGLE_MAPS_API_KEY"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        "    keypin signs in to Google only with a service account key, so it runs without gcloud",
      );
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Cloudflare: a Global API Key in the vault stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "cloudflare-global-key",
        args: ["rotate", "CLOUDFLARE_API_TOKEN"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("    keypin rotates API tokens, not the Global API Key");
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "OpenAI: makes a key for the vault key's service account, publishes it, then deletes the old key after a second y",
    async () => {
      const result = await drive({
        scenario: "openai",
        args: ["rotate", "OPENAI_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  + OpenAI                create a new key\n    for service account billing-bot, with all permissions",
      );
      expect(result.screen).toContain(
        "  - OpenAI                revoke the old key key_old of service account billing-bot, after a second y",
      );
      expect(result.screen).toMatch(
        /^✓ OpenAI {2}revoked key_old of service account billing-bot {2}\d+\.\ds$/m,
      );
      expect(result.effects).toEqual([
        "openai create key_new1 for svc_verify",
        "1password update my.1password.com/Private/billing openai key (28 chars)",
        "destination write github-actions:acme/billing OPENAI_API_KEY (28 chars)",
        "openai revoke key_old",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "OpenAI: a user-owned vault key stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "openai-user-key",
        args: ["rotate", "OPENAI_API_KEY"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        "    key key_old belongs to a user, and OpenAI's Admin API makes keys only for service accounts",
      );
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "OpenAI: a create whose reply is lost names the key and project to look in",
    async () => {
      const result = await drive({
        scenario: "openai-reply-lost",
        args: ["rotate", "OPENAI_API_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toMatch(
        /^Stopped: keypin didn't get the new key back\. OpenAI may have made the key before the reply was lost\. Only this run uses the name "OPENAI_API_KEY prod \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [0-9a-f]{6}": delete a key with that name in project billing at https:\/\/platform\.openai\.com\/settings\/organization\/api-keys before you run this again, or the rerun leaves it live\.$/m,
      );
      expect(result.effects).toEqual(["openai create key_new1 for svc_verify"]);
      clean(result);
    },
    SLOW,
  );

  test(
    "OpenRouter: makes a key with the old key's limit, publishes it, then deletes the old key after a second y",
    async () => {
      const result = await drive({
        scenario: "openrouter",
        args: ["rotate", "OPENROUTER_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  + OpenRouter            create a new key\n    with the old key's $25 limit, reset monthly; no expiry, in the same workspace",
      );
      expect(result.screen).toMatch(/^✓ OpenRouter {2}revoked "chat" {2}\d+\.\ds$/m);
      expect(result.effects).toEqual([
        "openrouter create hash_new1 with limit $25 monthly, workspace ws_default",
        "1password update my.1password.com/Private/chat openrouter key (26 chars)",
        "destination write github-actions:acme/billing OPENROUTER_API_KEY (26 chars)",
        "openrouter revoke hash_old",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "OpenRouter: a disabled vault key stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "openrouter-disabled",
        args: ["rotate", "OPENROUTER_API_KEY"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        `    key "chat" is disabled at OpenRouter, and keypin won't make an active copy of it`,
      );
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "xAI: makes a key with the old key's ACLs and rate limits, waits for every cluster, publishes it, then deletes the old key after a second y",
    async () => {
      const result = await drive({
        scenario: "xai",
        args: ["rotate", "XAI_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  + xAI                   create a new key\n    with ACLs api-key:model:grok-4.7, api-key:endpoint:chat; 100 requests a minute; no expiry",
      );
      expect(result.screen).toMatch(/^✓ xAI {2}revoked "chat" {2}\d+\.\ds$/m);
      expect(result.effects).toEqual([
        "xai create key_new1 in team_1 with acls api-key:model:grok-4.7 api-key:endpoint:chat, qpm 100",
        "1password update my.1password.com/Private/chat xai key (21 chars)",
        "destination write github-actions:acme/billing XAI_API_KEY (21 chars)",
        "xai revoke key_old",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "xAI: an API key in the admin item stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "xai-api-key-as-admin",
        args: ["rotate", "XAI_API_KEY"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        "    the admin item holds an xAI API key, not a management key, and API keys can't create or delete keys",
      );
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "xAI: a lost create reply isn't retried, and names the key to delete",
    async () => {
      const result = await drive({
        scenario: "xai-reply-lost",
        args: ["rotate", "XAI_API_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("delete a key with that name in team team_1");
      expect(result.effects).toEqual([
        "xai create key_new1 in team_1 with acls api-key:model:grok-4.7 api-key:endpoint:chat, qpm 100",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "ElevenLabs: makes a key for the same service account, publishes it, then deletes the old key after a second y",
    async () => {
      const result = await drive({
        scenario: "elevenlabs",
        args: ["rotate", "ELEVENLABS_API_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        `  + ElevenLabs            create a new key\n    for service account "backend", with the old key's 3 permissions, the old key's limit of 100,000 credits a month, starting unspent; no expiry`,
      );
      expect(result.screen).toMatch(/^✓ ElevenLabs {2}revoked "voice" {2}\d+\.\ds$/m);
      expect(result.effects).toEqual([
        "elevenlabs create sa_voice/key_new1 with permissions text_to_speech,voices_read,user_read, limit 100000",
        "1password update my.1password.com/Private/voice elevenlabs key (19 chars)",
        "destination write github-actions:acme/billing ELEVENLABS_API_KEY (19 chars)",
        "elevenlabs revoke sa_voice/key_old",
      ]);
      clean(result);
    },
    SLOW,
  );

  test(
    "ElevenLabs: a disabled vault key stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "elevenlabs-disabled",
        args: ["rotate", "ELEVENLABS_API_KEY"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain("ElevenLabs doesn't accept the vault's key");
      expect(result.effects).toEqual([]);
      clean(result);
    },
    SLOW,
  );

  test(
    "Supabase: the secret key named default stops before anything is created",
    async () => {
      const result = await drive({
        scenario: "supabase-default",
        args: ["rotate", "SUPABASE_SECRET_KEY"],
        answers: ["y", "y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        "keypin won't replace the secret key named default: Edge Functions that check keys with withSupabase({ auth: 'secret' }) accept only that key",
      );
      expect(result.effects).toEqual([]);
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
    "a key keypin issued and someone deleted at Resend has nothing to revoke, and asks one y",
    async () => {
      const result = await drive({
        scenario: "resend-deleted",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(0);
      expect(result.screen).toContain(
        "  = Resend                   nothing to revoke: key re-old was deleted at Resend",
      );
      expect(result.screen).toContain("Rotate RESEND_API_KEY? [y/N] y");
      expect(result.screen).not.toContain("Revoke the old key");
      expect(result.effects).toEqual([
        "resend create re-new-1",
        "1password update my.1password.com/Private/mailer resend key (20 chars)",
        "destination write github-actions:acme/mailer RESEND_API_KEY (20 chars)",
        "destination write cloudflare-worker:mailer RESEND_API_KEY (20 chars)",
      ]);
      const state: unknown = JSON.parse(result.files[".local/state/keypin/state.json"] ?? "{}");
      expect(state).toMatchObject({
        issued: [{ id: "re-new-1", old: { id: null, revoked: true } }],
      });
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
    "a create whose reply is lost names the key to delete",
    async () => {
      const result = await drive({
        scenario: "resend-reply-lost",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toMatch(
        /^Stopped: keypin didn't get the new key back\. Resend may have made the key before the reply was lost\. Only this run uses the name "RESEND_API_KEY prod \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [0-9a-f]{6}": delete a key with that name at https:\/\/resend\.com\/api-keys before you run this again, or the rerun leaves it live\.$/m,
      );
      expect(result.screen).not.toContain("Nothing was created");
      expect(result.effects).toEqual(["resend create re-new-1"]);
      clean(result);
    },
    SLOW,
  );

  test(
    "a vault save that times out says to run again, not to delete the key",
    async () => {
      const result = await drive({
        scenario: "resend-save-timeout",
        args: ["rotate", "RESEND_API_KEY"],
        answers: ["y"],
      });
      expect(result.exit).toBe(1);
      expect(result.screen).toContain(
        "Stopped: keypin can't tell whether 1Password saved the new key re-new-1. Run this again, and keypin picks up from what 1Password holds:",
      );
      expect(result.screen).not.toContain("Delete it");
      expect(result.effects).toEqual([
        "resend create re-new-1",
        "1password update my.1password.com/Private/mailer resend key (20 chars)",
      ]);
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
