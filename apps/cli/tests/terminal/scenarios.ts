import { envValues } from "@keypin/core";
import { localDay } from "@keypin/core";
import { accessKeyJson, type FakeAwsKey } from "@keypin/connectors/aws/testing";
import type { FakeToken } from "@keypin/connectors/cloudflare/testing";
import {
  type FakeGoogleKey,
  type FakeIamAccount,
  iamKeyFile,
  serviceAccountKeyId,
} from "@keypin/connectors/google/testing";
import type { FakeInfisical } from "@keypin/connectors/infisical/testing";
import { FAKE_ACCESS_TOKEN, type FakeBitwarden } from "@keypin/connectors/bitwarden/testing";
import type { FakeDoppler } from "@keypin/connectors/doppler/testing";
import type { FakeOpenAIKey } from "@keypin/connectors/openai/testing";
import type { FakeElevenLabsKey } from "@keypin/connectors/elevenlabs/testing";
import type { FakeOpenRouterKey } from "@keypin/connectors/openrouter/testing";
import type { FakeXaiKey } from "@keypin/connectors/xai/testing";
import type { SupabaseKey } from "@keypin/connectors/supabase/testing";
import type { FakeSendGridKey } from "@keypin/connectors/sendgrid/testing";
import { adminJson, type FakeTwilioKey } from "@keypin/connectors/twilio/testing";
import type { FakeAtlasUser } from "@keypin/connectors/mongodb-atlas/testing";

export interface FakeItem {
  title: string;
  value: string;
  rotated?: string;
  public?: true;
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
  google?: { keys: FakeGoogleKey[]; pendingPolls?: number };
  googleIam?: { accounts: FakeIamAccount[]; policy?: string; loseCreated?: boolean };
  openrouter?: { keys: FakeOpenRouterKey[] };
  elevenlabs?: { keys: FakeElevenLabsKey[] };
  aws?: { keys: FakeAwsKey[]; unready?: number; loseCreated?: boolean };
  sendgrid?: { keys: FakeSendGridKey[]; loseCreated?: boolean };
  twilio?: { keys: FakeTwilioKey[]; loseCreated?: boolean };
  xai?: { keys: FakeXaiKey[]; pendingPolls?: number; loseCreated?: boolean };
  atlas?: { users: FakeAtlasUser[]; loseCreated?: boolean };
  paired?: { keys: string[] };
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
  bitwarden?: FakeBitwarden;
  doppler?: FakeDoppler;
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

const NETLIFY_MAP = MAP.replace(
  'to = "github-actions"\nrepo = "acme/billing"',
  'to = "netlify-project"\nteam = "acme"\nproject = "billing.netlify.app"\ncontext = "production"',
);

const CONVEX_MAP = MAP.replace(
  'to = "github-actions"\nrepo = "acme/billing"',
  'to = "convex-deployment"\nurl = "https://happy-animal-123.convex.cloud"',
);

const FLY_MAP = MAP.replace(
  'to = "github-actions"\nrepo = "acme/billing"',
  'to = "fly-app"\napp = "billing-api"',
);

const GITLAB_MAP = MAP.replace(
  'to = "github-actions"\nrepo = "acme/billing"',
  'to = "gitlab-project"\nproject = "acme/billing"',
);

const RAILWAY_MAP = MAP.replace(
  'to = "github-actions"\nrepo = "acme/billing"',
  'to = "railway-service"\nproject = "1d01c0c0-4554-4747-93b8-34ce3448ab95"\nenvironment = "production"\nservice = "api"',
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

const OPENROUTER_MAP = `[1password]
account = "my.1password.com"

[keys.OPENROUTER_API_KEY]
rotate_every = "90d"

[keys.OPENROUTER_API_KEY.prod]
from = "op://Private/chat openrouter key/credential"

[keys.OPENROUTER_API_KEY.prod.issuer]
kind = "openrouter"
admin = "op://Private/openrouter management key/credential"

[[keys.OPENROUTER_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const OPENROUTER_ADMIN = "sk-or-v1-verify-management-key-4b7e";
export const OPENROUTER_PREFIX = "sk-or-v1-verify-new-";
const OPENROUTER_OLD = "sk-or-v1-verify-old-key-8d3c";

const openrouter: Scenario = {
  ...ready,
  about:
    'OPENROUTER_API_KEY has an OpenRouter issuer; the vault holds key "chat" with a $25 monthly limit, and keypin has never rotated it',
  files: { "keypin.toml": OPENROUTER_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "chat openrouter key", value: OPENROUTER_OLD, rotated: day(-95) },
          { title: "openrouter management key", value: OPENROUTER_ADMIN },
        ],
      },
    },
  },
  openrouter: {
    keys: [
      { hash: "hash_old", name: "chat", value: OPENROUTER_OLD, limit: 25, limitReset: "monthly" },
    ],
  },
};

const XAI_MAP = `[1password]
account = "my.1password.com"

[keys.XAI_API_KEY]
rotate_every = "90d"

[keys.XAI_API_KEY.prod]
from = "op://Private/chat xai key/credential"

[keys.XAI_API_KEY.prod.issuer]
kind = "xai"
admin = "op://Private/xai management key/credential"

[[keys.XAI_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const XAI_ADMIN = "xai-token-verify-management-4b7e";
export const XAI_PREFIX = "xai-verify-new-";
const XAI_OLD = "xai-verify-old-key-8d3c";
const XAI_API_KEY_AS_ADMIN = "xai-verify-ops-key-6e1d";
const XAI_KEY = {
  id: "key_old",
  name: "chat",
  value: XAI_OLD,
  acls: ["api-key:model:grok-4.7", "api-key:endpoint:chat"],
  qpm: 100,
};

const xai: Scenario = {
  ...ready,
  about:
    'XAI_API_KEY has an xAI issuer; the vault holds key "chat" of team team_1, limited to grok-4.7 and 100 requests a minute, and a new key takes one extra check to reach every cluster',
  files: { "keypin.toml": XAI_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "chat xai key", value: XAI_OLD, rotated: day(-95) },
          { title: "xai management key", value: XAI_ADMIN },
        ],
      },
    },
  },
  xai: { keys: [XAI_KEY], pendingPolls: 1 },
};

const ELEVENLABS_MAP = `[1password]
account = "my.1password.com"

[keys.ELEVENLABS_API_KEY]
rotate_every = "90d"

[keys.ELEVENLABS_API_KEY.prod]
from = "op://Private/voice elevenlabs key/credential"

[keys.ELEVENLABS_API_KEY.prod.issuer]
kind = "elevenlabs"
admin = "op://Private/elevenlabs admin key/credential"

[[keys.ELEVENLABS_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const ELEVENLABS_ADMIN = "sk_verify_admin_key_4b7e";
export const ELEVENLABS_PREFIX = "sk_verify_new_";
const ELEVENLABS_OLD = "sk_verify_old_key_8d3c";
const ELEVENLABS_KEY: FakeElevenLabsKey = {
  account: "sa_voice",
  keyId: "key_old",
  name: "voice",
  value: ELEVENLABS_OLD,
  characterLimit: 100_000,
};

const elevenlabs: Scenario = {
  ...ready,
  about:
    'ELEVENLABS_API_KEY has an ElevenLabs issuer; the vault holds key "voice" of service account "backend", with a 100,000-credit limit, and keypin has never rotated it',
  files: { "keypin.toml": ELEVENLABS_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "voice elevenlabs key", value: ELEVENLABS_OLD, rotated: day(-95) },
          { title: "elevenlabs admin key", value: ELEVENLABS_ADMIN },
        ],
      },
    },
  },
  elevenlabs: { keys: [ELEVENLABS_KEY] },
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

const GOOGLE_MAP = `[1password]
account = "my.1password.com"

[keys.GOOGLE_MAPS_API_KEY]
rotate_every = "90d"

[keys.GOOGLE_MAPS_API_KEY.prod]
from = "op://Private/maps api key/credential"

[keys.GOOGLE_MAPS_API_KEY.prod.issuer]
kind = "google"
admin = "op://Private/google key maker/credential"
project_number = "481537286014"

[[keys.GOOGLE_MAPS_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const GOOGLE_ADMIN = "verify-google-admin-key-id-7f3a";
export const GOOGLE_EMAIL = "keypin@acme-admin.iam.gserviceaccount.com";
export const GOOGLE_PREFIX = "AIzaSyVerifyNewVerifyNew";
const GOOGLE_OLD = "AIzaSyVerifyOldVerifyOldVerifyOld00000";

const google: Scenario = {
  ...ready,
  about:
    'GOOGLE_MAPS_API_KEY has a Google Cloud issuer; the vault holds key "Maps web", limited to the Maps API and two websites',
  files: { "keypin.toml": GOOGLE_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "maps api key", value: GOOGLE_OLD, rotated: day(-95) },
          { title: "google key maker", value: GOOGLE_ADMIN },
        ],
      },
    },
  },
  google: {
    keys: [
      {
        name: "projects/481537286014/locations/global/keys/maps-web",
        value: GOOGLE_OLD,
        displayName: "Maps web",
        restrictions: {
          apiTargets: [{ service: "maps-backend.googleapis.com" }],
          browserKeyRestrictions: {
            allowedReferrers: ["https://acme.example/*", "*.acme.example/*"],
          },
        },
      },
    ],
  },
};

const GOOGLE_IAM_MAP = `[1password]
account = "my.1password.com"

[keys.GOOGLE_APPLICATION_CREDENTIALS]
rotate_every = "90d"

[keys.GOOGLE_APPLICATION_CREDENTIALS.prod]
from = "op://Private/app service account/credential"

[keys.GOOGLE_APPLICATION_CREDENTIALS.prod.issuer]
kind = "google-service-account"
admin = "op://Private/google key maker/credential"

[[keys.GOOGLE_APPLICATION_CREDENTIALS.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const GOOGLE_IAM_PREFIX = "verify-new-private-key-";
const GOOGLE_IAM_APP = "billing@acme-prod.iam.gserviceaccount.com";
const GOOGLE_IAM_OLD = serviceAccountKeyId(0xf00);

const googleIam: Scenario = {
  ...ready,
  about: `GOOGLE_APPLICATION_CREDENTIALS has a google-service-account issuer; the vault holds key ${GOOGLE_IAM_OLD} of ${GOOGLE_IAM_APP}, which also has a disabled key`,
  files: { "keypin.toml": GOOGLE_IAM_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          {
            title: "app service account",
            value: iamKeyFile(
              GOOGLE_IAM_APP,
              "acme-prod",
              GOOGLE_IAM_OLD,
              "verify-old-private-key-4d1c",
            ),
            rotated: day(-95),
          },
          { title: "google key maker", value: GOOGLE_ADMIN },
        ],
      },
    },
  },
  googleIam: {
    accounts: [
      {
        email: GOOGLE_IAM_APP,
        project: "acme-prod",
        keys: [
          { id: serviceAccountKeyId(0xbee), disabled: true, created: "2026-03-02T00:00:00Z" },
          { id: GOOGLE_IAM_OLD, created: "2026-08-15T00:00:00Z" },
        ],
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

const BITWARDEN_ORGANIZATION = "2f1d6c9e-8a3b-4c5d-9e7f-0a1b2c3d4e5f";

const doppler: Scenario = {
  ...ready,
  about:
    "ready, but keypin.toml reads from a fake Doppler workplace acme, signed in with a service account token",
  files: {
    ...ready.files,
    "keypin.toml": INFISICAL_MAP.replace(
      '[infisical]\norganization = "acme"',
      '[doppler]\nworkplace = "acme"',
    )
      .replaceAll("infisical://billing/prod/", "doppler://billing/prd/")
      .replaceAll("infisical://", "doppler://"),
  },
  onePassword: { accounts: {} },
  doppler: {
    workplace: "acme",
    projects: {
      billing: {
        dev: { STRIPE_KEY: { value: "verify-dev-stripe-2c7d" } },
        prd: { STRIPE_KEY: { value: "verify-prod-stripe-5e8b" } },
      },
    },
    tokens: { "dp.sa.verify-account-token-1a9f": { type: "service_account", write: true } },
  },
  env: { DOPPLER_TOKEN: "dp.sa.verify-account-token-1a9f" },
};

const bitwarden: Scenario = {
  ...ready,
  about: "ready, but keypin.toml reads from a fake Bitwarden Secrets Manager organization",
  files: {
    ...ready.files,
    "keypin.toml": INFISICAL_MAP.replace(
      '[infisical]\norganization = "acme"',
      `[bitwarden]\norganization = "${BITWARDEN_ORGANIZATION}"`,
    )
      .replace("infisical://billing/dev/", "bitwarden://billing-dev/")
      .replace("infisical://billing/prod/", "bitwarden://billing/"),
  },
  onePassword: { accounts: {} },
  bitwarden: {
    organization: BITWARDEN_ORGANIZATION,
    projects: {
      "billing-dev": {
        secrets: [
          { name: "STRIPE_KEY", value: "verify-dev-stripe-2c7f", note: `rotated: ${day(-30)}` },
        ],
      },
      billing: {
        secrets: [
          { name: "STRIPE_KEY", value: "verify-prod-stripe-8e1b", note: `rotated: ${day(-85)}` },
        ],
      },
    },
  },
  env: { BWS_ACCESS_TOKEN: FAKE_ACCESS_TOKEN },
};

const PAIRED_MAP = `[1password]
account = "my.1password.com"

[keys.API_SECRET]
rotate_every = "90d"

[keys.API_SECRET.prod]
from = "op://Private/api secret/credential"

[keys.API_SECRET.prod.issuer]
kind = "paired"
admin = "op://Private/keys admin/credential"
key_id = "API_KEY_ID"

[[keys.API_SECRET.prod.publish]]
to = "github-actions"
repo = "acme/api"

[[keys.API_SECRET.prod.publish]]
to = "cloudflare-worker"
account = "11111111111111111111111111111111"
worker = "api"

[keys.API_KEY_ID]
rotate_every = "never"

[keys.API_KEY_ID.prod]
from = "op://Private/api key id/credential"

[[keys.API_KEY_ID.prod.publish]]
to = "github-actions"
repo = "acme/api"

[[keys.API_KEY_ID.prod.publish]]
to = "cloudflare-worker"
account = "11111111111111111111111111111111"
worker = "api"
`;

export const PAIRED_ADMIN = "paired_verify_admin_key_8e1d";
export const PAIRED_PREFIX = "paired_verify_new_";

const paired: Scenario = {
  ...ready,
  about:
    "API_SECRET has a test issuer whose key ID is API_KEY_ID, a second key in the map; a fake account lists key AKID-0",
  files: { "keypin.toml": PAIRED_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "api secret", value: "paired_verify_old_secret_2a9c", rotated: day(-95) },
          { title: "api key id", value: "AKID-0", rotated: day(-95), public: true },
          { title: "keys admin", value: PAIRED_ADMIN },
        ],
      },
    },
  },
  paired: { keys: ["AKID-0"] },
};

const AWS_MAP = `[1password]
account = "my.1password.com"

[keys.AWS_SECRET_ACCESS_KEY]
rotate_every = "90d"

[keys.AWS_SECRET_ACCESS_KEY.prod]
from = "op://Private/app aws secret/credential"

[keys.AWS_SECRET_ACCESS_KEY.prod.issuer]
kind = "aws"
admin = "op://Private/aws admin/credential"
key_id = "AWS_ACCESS_KEY_ID"

[[keys.AWS_SECRET_ACCESS_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"

[keys.AWS_ACCESS_KEY_ID]
rotate_every = "never"

[keys.AWS_ACCESS_KEY_ID.prod]
from = "op://Private/app aws key id/credential"

[[keys.AWS_ACCESS_KEY_ID.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const AWS_PREFIX = "aws_verify_new_secret_";
const AWS_ADMIN_ID = "AKIAADMINVERIFY00001";
const AWS_ADMIN_SECRET = "aws_verify_admin_secret_5c1f";
const AWS_OLD_ID = "AKIAAPPVERIFY0000001";
const AWS_OLD_SECRET = "aws_verify_old_secret_9b2e";

const aws: Scenario = {
  ...ready,
  about:
    "AWS_SECRET_ACCESS_KEY has an AWS issuer whose key ID is AWS_ACCESS_KEY_ID; the vault holds access key AKIAAPPVERIFY0000001 of IAM user billing-app, and the admin item holds a key of IAM user keypin-admin",
  files: { "keypin.toml": AWS_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "app aws secret", value: AWS_OLD_SECRET, rotated: day(-95) },
          { title: "app aws key id", value: AWS_OLD_ID, rotated: day(-95), public: true },
          { title: "aws admin", value: accessKeyJson(AWS_ADMIN_ID, AWS_ADMIN_SECRET) },
        ],
      },
    },
  },
  aws: {
    keys: [
      { id: AWS_ADMIN_ID, secret: AWS_ADMIN_SECRET, user: "keypin-admin" },
      { id: AWS_OLD_ID, secret: AWS_OLD_SECRET, user: "billing-app" },
    ],
    unready: 1,
  },
};

const SENDGRID_MAP = `[1password]
account = "my.1password.com"

[keys.SENDGRID_API_KEY]
rotate_every = "90d"

[keys.SENDGRID_API_KEY.prod]
from = "op://Private/mailer sendgrid key/credential"

[keys.SENDGRID_API_KEY.prod.issuer]
kind = "sendgrid"
admin = "op://Private/sendgrid admin key/credential"

[[keys.SENDGRID_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const SENDGRID_ADMIN = "SG.AdminVerifyId.sg_verify_admin_key_7e2a";
export const SENDGRID_PREFIX = "sg_verify_new_";
const SENDGRID_OLD = "SG.OldVerifyId.sg_verify_old_key_3b9d";
const SENDGRID_KEY: FakeSendGridKey = {
  id: "OldVerifyId",
  name: "mailer",
  value: SENDGRID_OLD,
  scopes: ["mail.send", "templates.read", "sender_verification_eligible", "2fa_required"],
};

const sendgrid: Scenario = {
  ...ready,
  about:
    'SENDGRID_API_KEY has a SendGrid issuer; the vault holds key "mailer" with scopes mail.send and templates.read, and keypin has never rotated it',
  files: { "keypin.toml": SENDGRID_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "mailer sendgrid key", value: SENDGRID_OLD, rotated: day(-95) },
          { title: "sendgrid admin key", value: SENDGRID_ADMIN },
        ],
      },
    },
  },
  sendgrid: { keys: [SENDGRID_KEY] },
};

const TWILIO_MAP = `[1password]
account = "my.1password.com"

[keys.TWILIO_API_SECRET]
rotate_every = "90d"

[keys.TWILIO_API_SECRET.prod]
from = "op://Private/app twilio secret/credential"

[keys.TWILIO_API_SECRET.prod.issuer]
kind = "twilio"
admin = "op://Private/twilio admin/credential"
key_id = "TWILIO_API_KEY"

[[keys.TWILIO_API_SECRET.prod.publish]]
to = "github-actions"
repo = "acme/billing"

[keys.TWILIO_API_KEY]
rotate_every = "never"

[keys.TWILIO_API_KEY.prod]
from = "op://Private/app twilio key sid/credential"

[[keys.TWILIO_API_KEY.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const TWILIO_ACCOUNT = `AC${"0123456789abcdef".repeat(2)}`;
export const TWILIO_TOKEN = "twilio_verify_auth_token_4e7c";
export const TWILIO_PREFIX = "twilio_verify_new_secret_";
const TWILIO_OLD_SID = `SK${"a1".repeat(16)}`;
const TWILIO_OLD_SECRET = "twilio_verify_old_secret_8d3f";
const TWILIO_KEY: FakeTwilioKey = {
  sid: TWILIO_OLD_SID,
  secret: TWILIO_OLD_SECRET,
  name: "billing sms",
  type: "restricted",
  policy: ["/twilio/messaging/messages/create", "/twilio/phone-numbers/available-numbers/list"],
};

const twilio: Scenario = {
  ...ready,
  about: `TWILIO_API_SECRET has a Twilio issuer whose key ID is TWILIO_API_KEY; the vault holds Restricted key ${TWILIO_OLD_SID} with a messaging and a phone-numbers permission, and the admin item holds the account's auth token`,
  files: { "keypin.toml": TWILIO_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "app twilio secret", value: TWILIO_OLD_SECRET, rotated: day(-95) },
          { title: "app twilio key sid", value: TWILIO_OLD_SID, rotated: day(-95), public: true },
          {
            title: "twilio admin",
            value: adminJson({
              TWILIO_ACCOUNT_SID: TWILIO_ACCOUNT,
              TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
            }),
          },
        ],
      },
    },
  },
  twilio: { keys: [TWILIO_KEY] },
};

export const ATLAS_CLIENT = "mdb_sa_id_verify_6745";
export const ATLAS_SECRET = "mdb_sa_sk_verify_admin_secret_5c1f";
export const ATLAS_PROJECT = "5f1a2b3c4d5e6f7a8b9c0d1e";

const ATLAS_MAP = `[1password]
account = "my.1password.com"

[keys.MONGODB_URI]
rotate_every = "90d"

[keys.MONGODB_URI.prod]
from = "op://Private/app mongodb uri/password"

[keys.MONGODB_URI.prod.issuer]
kind = "mongodb-atlas"
admin = "op://Private/atlas service account/credential"
client_id = "${ATLAS_CLIENT}"
project_id = "${ATLAS_PROJECT}"

[[keys.MONGODB_URI.prod.publish]]
to = "github-actions"
repo = "acme/billing"
`;

export const ATLAS_HOST = "cluster0.ab1cd.mongodb.net";
const ATLAS_OLD = "atlas_verify_old_password_3b9d";
const ATLAS_USER: FakeAtlasUser = {
  username: "billing",
  password: ATLAS_OLD,
  roles: [{ roleName: "readWrite", databaseName: "billing" }],
  scopes: [{ name: "Cluster0", type: "CLUSTER" }],
};

const atlas: Scenario = {
  ...ready,
  about:
    "MONGODB_URI has a MongoDB Atlas issuer; the vault holds database user billing's connection string for Cluster0, and keypin has never rotated it",
  files: { "keypin.toml": ATLAS_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          {
            title: "app mongodb uri",
            value: `mongodb+srv://billing:${ATLAS_OLD}@${ATLAS_HOST}/billing?retryWrites=true&w=majority&appName=Cluster0`,
            rotated: day(-95),
          },
          { title: "atlas service account", value: ATLAS_SECRET },
        ],
      },
    },
  },
  atlas: { users: [ATLAS_USER] },
};

const RANDOM_MAP = `[1password]
account = "my.1password.com"

[keys.AUTH_SECRET]
rotate_every = "90d"

[keys.AUTH_SECRET.prod]
from = "op://Private/app auth secret/password"

[keys.AUTH_SECRET.prod.issuer]
kind = "random"

[[keys.AUTH_SECRET.prod.publish]]
to = "github-actions"
repo = "acme/app"
`;

const random: Scenario = {
  ...ready,
  about: "AUTH_SECRET has a random issuer and was never rotated by keypin",
  files: { "keypin.toml": RANDOM_MAP },
  onePassword: {
    accounts: {
      "my.1password.com": {
        Private: [
          { title: "app auth secret", value: "verify-auth-secret-old-9d4b", rotated: day(-95) },
        ],
      },
    },
  },
};

export const scenarios: Record<string, Scenario> = {
  twilio,
  "twilio-lost": {
    ...twilio,
    about: "twilio, but the reply to the create is lost after Twilio made the key",
    twilio: { keys: [TWILIO_KEY], loseCreated: true },
  },
  "twilio-main": {
    ...twilio,
    about: "twilio, but the vault's key is a Main key, which Twilio's API can't make",
    twilio: { keys: [{ ...TWILIO_KEY, type: "main" }] },
  },
  ready,
  paired,
  sendgrid,
  atlas,
  "atlas-lost": {
    ...atlas,
    about: "atlas, but the reply to the create is lost after Atlas made user billing-b",
    atlas: { users: [ATLAS_USER], loseCreated: true },
  },
  "atlas-x509": {
    ...atlas,
    about: "atlas, but database user billing signs in with an X.509 certificate",
    atlas: { users: [{ ...ATLAS_USER, x509Type: "MANAGED" }] },
  },
  "sendgrid-lost": {
    ...sendgrid,
    about: "sendgrid, but the reply to the create is lost after SendGrid made the key",
    sendgrid: { keys: [SENDGRID_KEY], loseCreated: true },
  },
  "sendgrid-billing": {
    ...sendgrid,
    about: "sendgrid, but the vault's key also has billing.read, which the admin key doesn't have",
    sendgrid: { keys: [{ ...SENDGRID_KEY, scopes: ["mail.send", "billing.read"] }] },
  },
  aws,
  "aws-lost": {
    ...aws,
    about: "aws, but the reply to CreateAccessKey is lost after AWS made the key",
    aws: { keys: aws.aws?.keys ?? [], loseCreated: true },
  },
  "aws-full": {
    ...aws,
    about: "aws, but IAM user billing-app already has a second access key",
    aws: {
      keys: [
        ...(aws.aws?.keys ?? []),
        {
          id: "AKIAOTHERVERIFY00001",
          secret: "aws_verify_other_secret_3d7a",
          user: "billing-app",
          created: "2026-03-04T05:06:07Z",
        },
      ],
    },
  },
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
  bitwarden,
  doppler,
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
  random,
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
  netlify: {
    ...ready,
    about: "ready, but STRIPE_KEY publishes to a Netlify project's production deploy context",
    files: { "keypin.toml": NETLIFY_MAP },
    env: { KEYPIN_NETLIFY_TOKEN: "verify-netlify-token-4e7a" },
  },
  "netlify-no-token": {
    ...ready,
    about: "netlify, but KEYPIN_NETLIFY_TOKEN isn't set",
    files: { "keypin.toml": NETLIFY_MAP },
    places: {
      "netlify-project:billing.netlify.app/production": {
        check: {
          reason:
            "keypin signs in to Netlify with KEYPIN_NETLIFY_TOKEN, which isn't set. Create a personal access token at https://app.netlify.com/user/applications#personal-access-tokens and set KEYPIN_NETLIFY_TOKEN; keypin doesn't read the netlify login",
          publisher: "unknown",
          destinationAccount: null,
        },
      },
    },
  },
  convex: {
    ...ready,
    about: "ready, but STRIPE_KEY publishes to a Convex deployment's environment variables",
    files: { "keypin.toml": CONVEX_MAP },
    env: { KEYPIN_CONVEX_DEPLOY_KEY: "prod:happy-animal-123|verify-convex-key-61c2" },
  },
  "convex-no-key": {
    ...ready,
    about: "convex, but KEYPIN_CONVEX_DEPLOY_KEY isn't set",
    files: { "keypin.toml": CONVEX_MAP },
    places: {
      "convex-deployment:happy-animal-123.convex.cloud": {
        check: {
          reason:
            "keypin signs in to Convex with KEYPIN_CONVEX_DEPLOY_KEY, which isn't set. Generate a deploy key with deployment:env:write in the deployment's settings (https://dashboard.convex.dev/deployment/settings) and set KEYPIN_CONVEX_DEPLOY_KEY; keypin doesn't read the npx convex login",
          publisher: "unknown",
          destinationAccount: null,
        },
      },
    },
  },
  fly: {
    ...ready,
    about: "ready, but STRIPE_KEY publishes to a Fly.io app's secrets",
    files: { "keypin.toml": FLY_MAP },
    env: { KEYPIN_FLY_API_TOKEN: "FlyV1 fm2_verify-fly-token-4e2a" },
  },
  "fly-no-token": {
    ...ready,
    about: "fly, but KEYPIN_FLY_API_TOKEN isn't set",
    files: { "keypin.toml": FLY_MAP },
    places: {
      "fly-app:billing-api": {
        check: {
          reason:
            "keypin signs in to Fly.io with KEYPIN_FLY_API_TOKEN, which isn't set. Create a deploy token for the app with fly tokens create deploy -a <app>, or an org token with fly tokens create org (https://fly.io/tokens), and set KEYPIN_FLY_API_TOKEN; keypin doesn't read the fly login",
          publisher: "unknown",
          destinationAccount: null,
        },
      },
    },
  },
  gitlab: {
    ...ready,
    about: "ready, but STRIPE_KEY publishes to a GitLab project's CI/CD variables",
    files: { "keypin.toml": GITLAB_MAP },
    env: { KEYPIN_GITLAB_TOKEN: "glpat-verify-gitlab-token-6d1e" },
  },
  "gitlab-no-login": {
    ...ready,
    about: "gitlab, but neither KEYPIN_GITLAB_TOKEN nor glab is there",
    files: { "keypin.toml": GITLAB_MAP },
    places: {
      "gitlab-project:acme/billing": {
        check: {
          reason:
            "keypin can't find glab, and KEYPIN_GITLAB_TOKEN isn't set. Run glab auth login --hostname gitlab.com, or create a personal, project or group access token with the api scope (https://gitlab.com/-/user_settings/personal_access_tokens) and set KEYPIN_GITLAB_TOKEN",
          publisher: "unknown",
          destinationAccount: null,
        },
      },
    },
  },
  railway: {
    ...ready,
    about: "ready, but STRIPE_KEY publishes to a Railway service's production environment",
    files: { "keypin.toml": RAILWAY_MAP },
    env: { KEYPIN_RAILWAY_TOKEN: "verify-railway-token-8b3d" },
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
  google,
  "google-iam": googleIam,
  "google-iam-policy": {
    ...googleIam,
    about:
      "google-iam, but the organization policy iam.disableServiceAccountKeyCreation blocks new keys",
    googleIam: {
      ...googleIam.googleIam,
      accounts: googleIam.googleIam?.accounts ?? [],
      policy: "iam.disableServiceAccountKeyCreation",
    },
  },
  "google-iam-lost": {
    ...googleIam,
    about: "google-iam, but the reply to the create is lost after Google makes the key",
    googleIam: { accounts: googleIam.googleIam?.accounts ?? [], loseCreated: true },
  },
  "google-user-login": {
    ...google,
    about: "google, but the admin item holds a gcloud user login, not a service account key",
    onePassword: {
      accounts: {
        "my.1password.com": {
          Private: [
            { title: "maps api key", value: GOOGLE_OLD, rotated: day(-95) },
            {
              title: "google key maker",
              value: JSON.stringify({ type: "authorized_user", client_id: "verify-client-id" }),
            },
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
  openrouter,
  "openrouter-disabled": {
    ...openrouter,
    about: "openrouter, but the vault's key is disabled at OpenRouter",
    openrouter: {
      keys: [{ hash: "hash_old", name: "chat", value: OPENROUTER_OLD, limit: 25, disabled: true }],
    },
  },
  xai,
  "xai-api-key-as-admin": {
    ...xai,
    about: "xai, but the admin item holds a second xAI API key instead of a management key",
    onePassword: {
      accounts: {
        "my.1password.com": {
          Private: [
            { title: "chat xai key", value: XAI_OLD, rotated: day(-95) },
            { title: "xai management key", value: XAI_API_KEY_AS_ADMIN },
          ],
        },
      },
    },
    xai: { keys: [XAI_KEY, { id: "key_ops", name: "ops", value: XAI_API_KEY_AS_ADMIN }] },
  },
  "xai-reply-lost": {
    ...xai,
    about: "xai, but the network drops xAI's reply after it creates the new key",
    xai: { keys: [XAI_KEY], loseCreated: true },
  },
  elevenlabs,
  "elevenlabs-disabled": {
    ...elevenlabs,
    about: "elevenlabs, but ElevenLabs disabled the vault's key after it leaked",
    elevenlabs: { keys: [{ ...ELEVENLABS_KEY, disabled: true }] },
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
  const items = Object.values(scenario.onePassword.accounts)
    .flatMap((vaults) => Object.values(vaults).flat())
    .filter((item) => !item.public);
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
  const bitwarden = Object.values(scenario.bitwarden?.projects ?? {}).flatMap((p) => p.secrets);
  if (bitwarden.some((secret) => secret.value.length < SHORTEST_VALUE))
    throw new Error(`Bitwarden values need ${SHORTEST_VALUE} characters or more`);
  const doppler = Object.values(scenario.doppler?.projects ?? {})
    .flatMap((configs) => Object.values(configs))
    .flatMap((secrets) => Object.values(secrets));
  if (doppler.some((secret) => secret.value.length < SHORTEST_VALUE))
    throw new Error(`Doppler values need ${SHORTEST_VALUE} characters or more`);
  const tokens = [
    scenario.env?.OP_SERVICE_ACCOUNT_TOKEN,
    scenario.env?.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET,
    scenario.env?.INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN,
    scenario.env?.INFISICAL_TOKEN,
    scenario.env?.BWS_ACCESS_TOKEN,
    scenario.env?.DOPPLER_TOKEN,
  ].flatMap((token) => (token ? [token] : []));
  const issued = [
    ...(scenario.resend ? [ISSUED_PREFIX] : []),
    ...(scenario.neon ? [NEON_PREFIX, ...Object.values(scenario.neon.roles)] : []),
    ...(scenario.openai ? [OPENAI_PREFIX] : []),
    ...(scenario.cloudflareTokens ? [CLOUDFLARE_PREFIX] : []),
    ...(scenario.google ? [GOOGLE_PREFIX] : []),
    ...(scenario.openrouter ? [OPENROUTER_PREFIX] : []),
    ...(scenario.elevenlabs ? [ELEVENLABS_PREFIX] : []),
    ...(scenario.sendgrid ? [SENDGRID_PREFIX] : []),
    ...(scenario.twilio
      ? [TWILIO_PREFIX, TWILIO_TOKEN, ...scenario.twilio.keys.map((key) => key.secret)]
      : []),
    ...(scenario.xai ? [XAI_PREFIX] : []),
    ...(scenario.atlas ? scenario.atlas.users.map((user) => user.password) : []),
    ...(scenario.aws ? [AWS_PREFIX, ...scenario.aws.keys.map((key) => key.secret)] : []),
  ];
  return [
    ...items.map((item) => item.value),
    ...infisical.map((secret) => secret.value),
    ...bitwarden.map((secret) => secret.value),
    ...doppler.map((secret) => secret.value),
    ...env,
    ...tokens,
    ...issued,
  ];
}
