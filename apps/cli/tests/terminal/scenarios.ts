import { envValues } from "@keypin/core";
import { localDay } from "@keypin/core";
import type { FakeToken } from "@keypin/connectors/cloudflare/testing";
import type { FakeInfisical } from "@keypin/connectors/infisical/testing";
import type { FakeOpenAIKey } from "@keypin/connectors/openai/testing";
import type { SupabaseKey } from "@keypin/connectors/supabase/testing";

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
  resend?: {
    keys: string[];
    failCreate?: number;
    loseCreated?: boolean;
    domains?: Record<string, string>;
  };
  neon?: { roles: Record<string, string> };
  openai?: { keys: FakeOpenAIKey[]; loseCreated?: boolean };
  supabase?: { keys: SupabaseKey[]; loseCreated?: boolean; prefixOnly?: boolean };
  cloudflareTokens?: { tokens: FakeToken[]; loseCreated?: boolean };
  registered: boolean;
  git: { origin?: string; account?: string };
  onePassword: {
    accounts: Record<string, Record<string, FakeItem[]>>;
    slowMs?: number;
    signIn?: string;
    noDesktopApp?: boolean;
    saveTimesOut?: boolean;
  };
  gh: "ok" | "not installed" | "not logged in";
  wrangler: boolean;
  githubSecrets: string[] | null;
  places: Record<string, Place>;
  env?: Record<string, string>;
  infisical?: FakeInfisical;
}

export const FAKE_TOKEN = `ops_${Buffer.from(JSON.stringify({ signInAddress: "https://my.1password.com/" })).toString("base64url")}`;

function day(offset: number): string {
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

const VERCEL_MAP = MAP.replace(
  'to = "github-actions"\nrepo = "acme/billing"',
  'to = "vercel-project"\nteam = "acme"\nproject = "billing"\nenvironment = "production"',
);

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
export const RESEND_ADMIN = "re_verify_admin_key_51ad";
export const RESEND_KNOWN = { [RESEND_OLD]: "re-old" };
export const ISSUED_PREFIX = "re_verify_new_";

const resendReceipt = (
  destinationId: string,
  pinned: string,
  generation: string,
  field = "credential",
  vault = "Private",
) => ({
  keyId: "RESEND_API_KEY",
  environment: "prod",
  mapFile: "<project>/keypin.toml",
  source: {
    kind: "1password",
    account: "my.1password.com",
    vault,
    item: "mailer resend key",
    section: null,
    field,
  },
  sourceIds: { vault, item: "mailer resend key" },
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
          { title: "resend admin key", value: RESEND_ADMIN },
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

const OPENAI_MAP = `[1password]
account = "my.1password.com"

[keys.OPENAI_API_KEY]
rotate_every = "90d"

[keys.OPENAI_API_KEY.prod]
from = "op://Private/billing openai key/credential"

[keys.OPENAI_API_KEY.prod.issuer]
kind = "openai"
admin = "op://Private/openai admin key/credential"
project_id = "proj_verify"
scopes = []

[[keys.OPENAI_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const OPENAI_ADMIN = "sk-admin-verify-admin-key-4b7e";
export const OPENAI_PREFIX = "sk-svcacct-verify-new-";
const OPENAI_OLD = "sk-svcacct-verify-old-key-8d3c";
const OPENAI_BOT = { type: "service_account", id: "svc_verify", name: "billing-bot" } as const;

const openai: Scenario = {
  ...ready,
  about:
    "OPENAI_API_KEY has an OpenAI issuer; the vault holds key_old of service account billing-bot, and keypin has never rotated it",
  files: { "keypin.toml": OPENAI_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "billing openai key", value: OPENAI_OLD, rotated: day(-95) },
          { title: "openai admin key", value: OPENAI_ADMIN },
        ],
      },
    },
  },
  openai: { keys: [{ id: "key_old", name: "prod", value: OPENAI_OLD, owner: OPENAI_BOT }] },
};

const SUPABASE_MAP = `[1password]
account = "my.1password.com"

[keys.SUPABASE_SECRET_KEY]
rotate_every = "90d"

[keys.SUPABASE_SECRET_KEY.prod]
from = "op://Private/app supabase key/credential"

[keys.SUPABASE_SECRET_KEY.prod.issuer]
kind = "supabase"
admin = "op://Private/supabase token/credential"
project_ref = "abcdefghijklmnopqrst"

[[keys.SUPABASE_SECRET_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

const SUPABASE_FUNCTIONS_MAP = MAP.replace(
  'to = "github-actions"\nrepo = "acme/billing"',
  'to = "supabase-functions"\nproject_ref = "abcdefghijklmnopqrst"',
);

export const SUPABASE_ADMIN = "sbp_verify_admin_token_4c2a";
export const SUPABASE_PREFIX = "sb_secret_Nw";
const SUPABASE_LIVE = "sb_secret_Bk7Qv2live_backend_2d7e";
const SUPABASE_DEFAULT = "sb_secret_Df9Xa1live_default_9b3c";

const supabase: Scenario = {
  ...ready,
  about:
    "SUPABASE_SECRET_KEY has a Supabase issuer; the vault holds secret key backend, and the project also has secret key default",
  files: { "keypin.toml": SUPABASE_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "app supabase key", value: SUPABASE_LIVE, rotated: day(-95) },
          { title: "supabase token", value: SUPABASE_ADMIN },
        ],
      },
    },
  },
  supabase: {
    keys: [
      { id: "key-default", name: "default", type: "secret", value: SUPABASE_DEFAULT },
      { id: "key-backend", name: "backend", type: "secret", value: SUPABASE_LIVE },
    ],
  },
};

const CLOUDFLARE_MAP = `[1password]
account = "my.1password.com"

[keys.CLOUDFLARE_API_TOKEN]
rotate_every = "90d"

[keys.CLOUDFLARE_API_TOKEN.prod]
from = "op://Private/deploy cloudflare token/credential"

[keys.CLOUDFLARE_API_TOKEN.prod.issuer]
kind = "cloudflare"
admin = "op://Private/cloudflare token maker/credential"

[[keys.CLOUDFLARE_API_TOKEN.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const CLOUDFLARE_ADMIN = "cfut_verifyadminverifyadminverify00000000_4b7e";
export const CLOUDFLARE_PREFIX = "cfut_verifynew";
const CLOUDFLARE_OLD = "cfut_verifyoldverifyoldverifyold000000000_8d3c";

const cloudflareTokens: Scenario = {
  ...ready,
  about:
    'CLOUDFLARE_API_TOKEN has a Cloudflare issuer; the vault holds user API token "deploy" with an IP filter, expiring 30 days after it was made',
  files: { "keypin.toml": CLOUDFLARE_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "deploy cloudflare token", value: CLOUDFLARE_OLD, rotated: day(-95) },
          { title: "cloudflare token maker", value: CLOUDFLARE_ADMIN },
        ],
      },
    },
  },
  cloudflareTokens: {
    tokens: [
      {
        id: "a".repeat(32),
        name: "deploy",
        value: CLOUDFLARE_OLD,
        policies: [
          {
            id: "f267e341f3dd4697bd3b9f71dd96247f",
            effect: "allow",
            resources: { "com.cloudflare.api.account.0123456789abcdef0123456789abcdef": "*" },
            permission_groups: [
              { id: "e086da7e2179491d91ee5f35b3ca210a", name: "Workers Scripts Write" },
            ],
          },
        ],
        condition: { "request.ip": { in: ["192.0.2.0/24"] } },
        issued_on: "2026-11-01T00:00:00Z",
        expires_on: "2026-12-01T00:00:00Z",
      },
    ],
  },
};

const infisical: Scenario = {
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
};

export const scenarios: Record<string, Scenario> = {
  ready,
  "env-file": {
    ...ready,
    about: "ready, plus a .env with a key keypin.toml doesn't map, to import",
    files: { ...ready.files, ".env": "RESEND_API_KEY=verify-resend-2f7c\nPORT=3000\n" },
  },
  "ignored-keys": {
    ...ready,
    about:
      "ready, plus a copied review workflow with two optional model keys, both in keypin.toml's ignore list",
    files: {
      ...ready.files,
      "keypin.toml": `ignore = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]\n${MAP}`,
      ".github/workflows/review.yml": `on: pull_request
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - run: ./review.sh
        env:
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`,
    },
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
    files: {
      ...ready.files,
      "keypin.toml": MAP.replaceAll("op://Private/", "op://Deploy/"),
      ".env": "RESEND_API_KEY=verify-resend-2f7c\n",
    },
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
  infisical,
  "infisical-token": {
    ...infisical,
    about: "infisical, but signed in with a machine identity's access token in INFISICAL_TOKEN",
    infisical: {
      organization: "acme",
      projects: {},
      ...infisical.infisical,
      accessToken: "verify-access-token-8c3f",
    },
    env: { INFISICAL_TOKEN: "verify-access-token-8c3f" },
  },
  resend,
  neon,
  supabase,
  "supabase-default": {
    ...supabase,
    about: "supabase, but the vault holds the secret key named default",
    onePassword: {
      accounts: {
        "my.1password.com": {
          Private: [
            { title: "app supabase key", value: SUPABASE_DEFAULT, rotated: day(-95) },
            { title: "supabase token", value: SUPABASE_ADMIN },
          ],
        },
      },
    },
  },
  "supabase-legacy": {
    ...supabase,
    about: "supabase, but the vault holds a legacy service_role JWT",
    onePassword: {
      accounts: {
        "my.1password.com": {
          Private: [
            {
              title: "app supabase key",
              value: "eyJhbGciOiJIUzI1NiJ9.verify.legacy",
              rotated: day(-95),
            },
            { title: "supabase token", value: SUPABASE_ADMIN },
          ],
        },
      },
    },
  },
  "supabase-lost-create": {
    ...supabase,
    about: "supabase, but the reply to the create is lost after Supabase made the key",
    supabase: { keys: supabase.supabase?.keys ?? [], loseCreated: true },
  },
  "supabase-prefix-only": {
    ...supabase,
    about: "supabase, but the create reply holds only the key's 15-character prefix",
    supabase: { keys: supabase.supabase?.keys ?? [], prefixOnly: true },
  },
  "supabase-functions": {
    ...ready,
    about: "ready, but STRIPE_KEY publishes to a Supabase project's Edge Function secrets",
    files: { "keypin.toml": SUPABASE_FUNCTIONS_MAP },
    env: { KEYPIN_SUPABASE_ACCESS_TOKEN: "sbp_verify_functions_token_6e1d" },
  },
  "supabase-functions-no-token": {
    ...ready,
    about: "supabase-functions, but KEYPIN_SUPABASE_ACCESS_TOKEN isn't set",
    files: { "keypin.toml": SUPABASE_FUNCTIONS_MAP },
    places: {
      "supabase-functions:abcdefghijklmnopqrst": {
        check: {
          reason:
            "keypin signs in to Supabase with KEYPIN_SUPABASE_ACCESS_TOKEN, which isn't set. Create a personal access token at https://supabase.com/dashboard/account/tokens with Edge Function Secrets Read-write on the project and set KEYPIN_SUPABASE_ACCESS_TOKEN; keypin doesn't read the supabase login",
          publisher: "unknown",
          destinationAccount: null,
        },
      },
    },
  },
  "neon-one-role": {
    ...neon,
    about: "neon, but the branch has only app_a: nobody created app_b",
    neon: { roles: { app_a: NEON_LIVE } },
  },
  "resend-service-account": {
    ...resend,
    about:
      "resend, but signed in with a fake service account token for my.1password.com, the items in a vault named Deploy",
    files: { "keypin.toml": RESEND_MAP.replaceAll("op://Private/", "op://Deploy/") },
    onePassword: {
      accounts: {
        "my.1password.com": {
          Deploy: resend.onePassword.accounts["my.1password.com"]?.Private ?? [],
        },
      },
    },
    state: {
      ...resend.state,
      receipts: [
        resendReceipt(
          "github-actions:acme/mailer:RESEND_API_KEY",
          "acme",
          RESEND_OLD_GENERATION,
          "credential",
          "Deploy",
        ),
        resendReceipt(
          "cloudflare-worker:mailer:RESEND_API_KEY",
          "11111111111111111111111111111111",
          RESEND_OLD_GENERATION,
          "credential",
          "Deploy",
        ),
      ],
    },
    env: { KEYPIN_1PASSWORD: "service-account", OP_SERVICE_ACCOUNT_TOKEN: FAKE_TOKEN },
  },
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
    resend: { keys: ["re-old"], domains: { "dom-verify": "mail.acme.dev" } },
  },
  "resend-deleted": {
    ...resend,
    about: "resend, but someone deleted key re-old at Resend after a leak",
    resend: { keys: [] },
  },
  "resend-worker-down": {
    ...resend,
    about: "resend, but the Cloudflare Worker rejects the write",
    places: { "cloudflare-worker:mailer": { write: "Cloudflare PUT /secrets returned HTTP 500" } },
  },
  "resend-reply-lost": {
    ...resend,
    about: "resend, but the network drops Resend's reply after it creates the new key",
    resend: { keys: ["re-old"], loseCreated: true },
  },
  "resend-save-timeout": {
    ...resend,
    about: "resend, but 1Password saves the new key and then its reply times out",
    onePassword: { ...resend.onePassword, saveTimesOut: true },
  },
  vercel: {
    ...ready,
    about: "ready, but STRIPE_KEY publishes to a Vercel project's production environment",
    files: { "keypin.toml": VERCEL_MAP },
    env: { KEYPIN_VERCEL_TOKEN: "verify-vercel-token-8c2f" },
  },
  "vercel-no-token": {
    ...ready,
    about: "vercel, but KEYPIN_VERCEL_TOKEN isn't set",
    files: { "keypin.toml": VERCEL_MAP },
    places: {
      "vercel-project:billing/production": {
        check: {
          reason:
            "keypin signs in to Vercel with KEYPIN_VERCEL_TOKEN, which isn't set. Create a token at https://vercel.com/account/tokens for the project's team and set KEYPIN_VERCEL_TOKEN; keypin doesn't read the vercel login",
          publisher: "unknown",
          destinationAccount: null,
        },
      },
    },
  },
  cloudflare: cloudflareTokens,
  "cloudflare-global-key": {
    ...cloudflareTokens,
    about: "cloudflare, but the vault holds a Global API Key, not an API token",
    onePassword: {
      accounts: {
        "my.1password.com": {
          Private: [
            {
              title: "deploy cloudflare token",
              value: "cfk_verifyglobalverifyglobalverify000000000_1a2b",
              rotated: day(-95),
            },
            { title: "cloudflare token maker", value: CLOUDFLARE_ADMIN },
          ],
        },
      },
    },
  },
  openai,
  "openai-user-key": {
    ...openai,
    about: "openai, but the vault's key belongs to a user, not a service account",
    openai: {
      keys: [
        {
          id: "key_old",
          name: "prod",
          value: OPENAI_OLD,
          owner: { type: "user", id: "user_verify", name: "Ada" },
        },
      ],
    },
  },
  "openai-reply-lost": {
    ...openai,
    about: "openai, but the network drops OpenAI's reply after it creates the new key",
    openai: { ...openai.openai, keys: openai.openai?.keys ?? [], loseCreated: true },
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

const SHORTEST_VALUE = 8;
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
    scenario.env?.INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN,
    scenario.env?.INFISICAL_TOKEN,
  ].flatMap((token) => (token ? [token] : []));
  const issued = [
    ...(scenario.resend ? [ISSUED_PREFIX] : []),
    ...(scenario.neon ? [NEON_PREFIX, ...Object.values(scenario.neon.roles)] : []),
    ...(scenario.openai ? [OPENAI_PREFIX] : []),
    ...(scenario.cloudflareTokens ? [CLOUDFLARE_PREFIX] : []),
  ];
  return [
    ...items.map((item) => item.value),
    ...infisical.map((secret) => secret.value),
    ...env,
    ...tokens,
    ...issued,
  ];
}
