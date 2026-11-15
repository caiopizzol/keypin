import { envValues } from "@keypin/core";
import { localDay } from "../../src/deps";
import type { FakeInfisical } from "@keypin/vault-infisical/testing";

export interface FakeItem {
  title: string;
  value: string;
  rotated?: string;
}

export interface Place {
  check?: { reason: string; fix?: string; publisher?: string; destinationAccount?: string | null };
  write?: string;
}

export interface Scenario {
  about: string;
  files: Record<string, string>;
  state?: object;
  resend?: { keys: string[]; failCreate?: boolean };
  neon?: { roles: Record<string, string> };
  registered: boolean;
  git: { origin?: string; account?: string };
  onePassword: {
    accounts: Record<string, Record<string, FakeItem[]>>;
    slowMs?: number;
    signIn?: string;
    noDesktopApp?: boolean;
  };
  gh: "ok" | "not installed" | "not logged in";
  wrangler: boolean;
  githubSecrets: string[] | null;
  places: Record<string, Place>;
  env?: Record<string, string>;
  infisical?: FakeInfisical;
}

export const FAKE_TOKEN = `ops_${Buffer.from(JSON.stringify({ signInAddress: "my.1password.com" })).toString("base64url")}`;

export function day(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return localDay(date);
}

const MAP = `[1password]
account = "my.1password.com"

[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "op://Private/billing dev stripe key/password"

[keys.STRIPE_KEY.prod]
from = "op://Private/billing prod stripe key/password"

[[keys.STRIPE_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

const WORKFLOW = `on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        env:
          STRIPE_KEY: \${{ secrets.STRIPE_KEY }}
`;

export const ready: Scenario = {
  about:
    "a mapped project where every sign-in works and GitHub already has STRIPE_KEY; keypin has no receipt yet",
  files: { "keypin.toml": MAP, ".github/workflows/deploy.yml": WORKFLOW },
  registered: true,
  git: { origin: "git@github.com:acme/billing.git" },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "billing dev stripe key", value: "verify-dev-stripe-6b1e", rotated: day(-30) },
          {
            title: "billing prod stripe key",
            value: "verify-prod-stripe-9d4a",
            rotated: day(-85),
          },
        ],
      },
    },
  },
  gh: "ok",
  wrangler: true,
  githubSecrets: ["STRIPE_KEY"],
  places: {},
};

const INFISICAL_MAP = `[infisical]
organization = "acme"

[keys.STRIPE_KEY]
rotate_every = "90d"
dev = "infisical://billing/dev/STRIPE_KEY"

[keys.STRIPE_KEY.prod]
from = "infisical://billing/prod/STRIPE_KEY"

[[keys.STRIPE_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

const RESEND_MAP = `[1password]
account = "my.1password.com"

[keys.RESEND_API_KEY]
rotate_every = "90d"

[keys.RESEND_API_KEY.prod]
from = "op://Private/mailer resend key/credential"

[keys.RESEND_API_KEY.prod.issuer]
kind = "resend"
admin = "op://Private/resend admin key/credential"
permission = "sending_access"

[[keys.RESEND_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/mailer"

[[keys.RESEND_API_KEY.prod.publish]]
to = "cloudflare-worker"
account = "11111111111111111111111111111111"
worker = "mailer"
`;

const RESEND_OLD = "re_verify_old_key_3c7e";
export const ISSUED_PREFIX = "re_verify_new_";

const resendReceipt = (
  destinationId: string,
  pinned: string,
  generation: string,
  field = "credential",
) => ({
  keyId: "RESEND_API_KEY",
  environment: "prod",
  mapFile: "<project>/keypin.toml",
  source: {
    kind: "1password",
    account: "my.1password.com",
    vault: "Private",
    item: "mailer resend key",
    section: null,
    field,
  },
  sourceIds: { vault: "Private", item: "mailer resend key" },
  destinationId,
  generation,
  account: { pinned, publisher: pinned, destinationAccount: pinned },
  at: "2026-08-01T12:00:00.000Z",
  evidence: { version: "verify" },
});

const RESEND_OLD_GENERATION = "5f85700cd2d85825";

const resend: Scenario = {
  ...ready,
  about:
    "RESEND_API_KEY has a Resend issuer and was published from this machine as key re-old; a fake Resend lists it",
  files: { "keypin.toml": RESEND_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "mailer resend key", value: RESEND_OLD, rotated: day(-95) },
          { title: "resend admin key", value: "re_verify_admin_key_51ad" },
        ],
      },
    },
  },
  state: {
    version: 5,
    receipts: [
      resendReceipt("github-actions:acme/mailer:RESEND_API_KEY", "acme", RESEND_OLD_GENERATION),
      resendReceipt(
        "cloudflare-worker:mailer:RESEND_API_KEY",
        "11111111111111111111111111111111",
        RESEND_OLD_GENERATION,
      ),
    ],
    operations: [],
    issued: [
      {
        keyId: "RESEND_API_KEY",
        environment: "prod",
        mapFile: "<project>/keypin.toml",
        issuer: "resend",
        id: "re-old",
        generation: RESEND_OLD_GENERATION,
        at: "2026-08-01T12:00:00.000Z",
        old: { id: "re-older", generation: "0000000000000000", revoked: true },
      },
    ],
  },
  resend: { keys: ["re-old"] },
};

const NEON_MAP = `[1password]
account = "my.1password.com"

[keys.DATABASE_URL]
rotate_every = "90d"

[keys.DATABASE_URL.prod]
from = "op://Private/app database url/password"

[keys.DATABASE_URL.prod.issuer]
kind = "neon"
admin = "op://Private/neon api key/credential"
project_id = "quiet-lake-12345678"
branch_id = "br-main-a1b2c3d4"
database = "appdb"
roles = ["app_a", "app_b"]

[[keys.DATABASE_URL.prod.publish]]
to = "github-actions"
repo = "acme/billing"

[[keys.DATABASE_URL.prod.publish]]
to = "cloudflare-worker"
account = "11111111111111111111111111111111"
worker = "billing"
`;

export const NEON_HOST = "ep-quiet-lake-a1b2c3d4-pooler.us-east-2.aws.neon.tech";
export const NEON_PREFIX = "npg_verify_new_";
const NEON_LIVE = "npg_verify_live_a_7c2e";

const neon: Scenario = {
  ...ready,
  about:
    "DATABASE_URL has a Neon issuer with roles app_a and app_b; the vault's pooled URL uses app_a and keypin has never rotated it",
  files: { "keypin.toml": NEON_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          {
            title: "app database url",
            value: `postgresql://app_a:${NEON_LIVE}@${NEON_HOST}/appdb?sslmode=require&channel_binding=require`,
            rotated: day(-95),
          },
          { title: "neon api key", value: "napi_verify_admin_key_5e8b" },
        ],
      },
    },
  },
  neon: { roles: { app_a: NEON_LIVE, app_b: "npg_verify_idle_b_3a9d" } },
};

export const scenarios: Record<string, Scenario> = {
  ready,
  "env-file": {
    ...ready,
    about: "ready, plus a .env with a key keypin.toml doesn't map, to import",
    files: { ...ready.files, ".env": "RESEND_API_KEY=verify-resend-2f7c\nPORT=3000\n" },
  },
  "quoted-env": {
    ...ready,
    about: "ready, plus a .env whose value is quoted and has an inline comment, for the leak check",
    files: {
      ...ready.files,
      ".env": 'RESEND_API_KEY="review-secret-sentinel" # test fixture\n',
    },
  },
  "slow-1password": {
    ...ready,
    about: "ready, but 1Password takes 1.5s to answer, as when it asks to approve keypin",
    onePassword: { ...ready.onePassword, slowMs: 1500 },
  },
  "no-1password-app": {
    ...ready,
    about: "a server without the 1Password desktop app, as on CI",
    onePassword: { ...ready.onePassword, noDesktopApp: true },
  },
  "unknown-account": {
    ...ready,
    about:
      "keypin.toml pins a 1Password account the app doesn't have, and gh is signed out; nothing works",
    files: {
      ...ready.files,
      "keypin.toml": MAP.replace("my.1password.com", "no-such-account.invalid"),
      ".env": "PORT=3000\nDEBUG=1\n",
    },
    gh: "not logged in",
    githubSecrets: null,
    places: {
      "github-actions:acme/billing": {
        check: {
          reason: "gh has no token for an active login; run: gh auth login --hostname github.com",
          publisher: "unknown",
          destinationAccount: null,
        },
      },
    },
  },
  "service-account": {
    ...ready,
    about:
      "ready, but signed in with a fake service account token for my.1password.com, the items in a vault named Deploy; 1Password takes 1.5s to answer",
    files: { ...ready.files, "keypin.toml": MAP.replaceAll("op://Private/", "op://Deploy/") },
    onePassword: {
      ...ready.onePassword,
      slowMs: 1500,
      accounts: {
        "my.1password.com": {
          Deploy: ready.onePassword.accounts["my.1password.com"]?.Private ?? [],
        },
      },
    },
    env: { KEYPIN_1PASSWORD: "service-account", OP_SERVICE_ACCOUNT_TOKEN: FAKE_TOKEN },
  },
  infisical: {
    ...ready,
    about:
      "ready, but keypin.toml reads from a fake Infisical organization acme, signed in as a machine identity",
    files: { ...ready.files, "keypin.toml": INFISICAL_MAP },
    onePassword: { accounts: {} },
    infisical: {
      organization: "acme",
      projects: {
        billing: {
          dev: { STRIPE_KEY: { value: "verify-dev-stripe-6b1e", rotated: day(-30) } },
          prod: { STRIPE_KEY: { value: "verify-prod-stripe-9d4a", rotated: day(-85) } },
        },
      },
    },
    env: {
      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "verify-client-id",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "verify-client-secret-3e7a",
    },
  },
  resend,
  neon,
  "resend-password": {
    ...resend,
    about: "resend, but keypin.toml reads the key from the item's password field",
    files: {
      "keypin.toml": RESEND_MAP.replace(
        "mailer resend key/credential",
        "mailer resend key/password",
      ),
    },
    state: {
      ...resend.state,
      receipts: [
        resendReceipt(
          "github-actions:acme/mailer:RESEND_API_KEY",
          "acme",
          RESEND_OLD_GENERATION,
          "password",
        ),
        resendReceipt(
          "cloudflare-worker:mailer:RESEND_API_KEY",
          "11111111111111111111111111111111",
          RESEND_OLD_GENERATION,
          "password",
        ),
      ],
    },
  },
  "resend-removed": {
    ...resend,
    about: "resend, but acme/mailer left keypin.toml after it got the old key",
    files: {
      "keypin.toml": RESEND_MAP.replace(
        '[[keys.RESEND_API_KEY.prod.publish]]\nto = "github-actions"\nrepo = "acme/mailer"\n\n',
        "",
      ),
    },
  },
  "resend-domain": {
    ...resend,
    about: "resend, but the new key may send only from the Resend domain dom-verify",
    files: {
      "keypin.toml": RESEND_MAP.replace(
        'permission = "sending_access"\n',
        'permission = "sending_access"\ndomain_id = "dom-verify"\n',
      ),
    },
  },
  "resend-worker-down": {
    ...resend,
    about: "resend, but the Cloudflare Worker rejects the write",
    places: { "cloudflare-worker:mailer": { write: "Cloudflare PUT /secrets returned HTTP 500" } },
  },
  fresh: {
    ...ready,
    about: "an empty git repository: no keypin.toml, not registered, nothing signed in",
    files: {},
    registered: false,
    gh: "not logged in",
    wrangler: false,
    githubSecrets: null,
  },
};

export const SHORTEST_VALUE = 8;
export const SANDBOX_MARKER = ".keypin-verify-sandbox";

export function valuesOf(scenario: Scenario): string[] {
  const items = Object.values(scenario.onePassword.accounts).flatMap((vaults) =>
    Object.values(vaults).flat(),
  );
  const short = items.filter((item) => item.value.length < SHORTEST_VALUE);
  if (short.length)
    throw new Error(
      `vault values need ${SHORTEST_VALUE} characters or more, so the leak check can find them: ${short.map((item) => item.title).join(", ")}`,
    );
  const env = Object.entries(scenario.files)
    .filter(([path]) => path.split("/").at(-1)?.startsWith(".env"))
    .flatMap(([, text]) => [...envValues(text).values()].map((secret) => secret.reveal()))
    .filter((value) => value.length >= SHORTEST_VALUE);
  const infisical = Object.values(scenario.infisical?.projects ?? {})
    .flatMap((environments) => Object.values(environments))
    .flatMap((secrets) => Object.values(secrets));
  if (infisical.some((secret) => secret.value.length < SHORTEST_VALUE))
    throw new Error(`Infisical values need ${SHORTEST_VALUE} characters or more`);
  const tokens = [
    scenario.env?.OP_SERVICE_ACCOUNT_TOKEN,
    scenario.env?.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET,
  ].flatMap((token) => (token ? [token] : []));
  const issued = [
    ...(scenario.resend ? [ISSUED_PREFIX] : []),
    ...(scenario.neon ? [NEON_PREFIX, ...Object.values(scenario.neon.roles)] : []),
  ];
  return [
    ...items.map((item) => item.value),
    ...infisical.map((secret) => secret.value),
    ...env,
    ...tokens,
    ...issued,
  ];
}
