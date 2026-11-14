import { localDay } from "../../src/deps";

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
  registered: boolean;
  git: { origin?: string; account?: string };
  onePassword: {
    accounts: Record<string, Record<string, FakeItem[]>>;
    slowMs?: number;
    signIn?: string;
  };
  gh: "ok" | "not installed" | "not logged in";
  wrangler: boolean;
  githubSecrets: string[] | null;
  places: Record<string, Place>;
}

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

const ready: Scenario = {
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

export const scenarios: Record<string, Scenario> = {
  ready,
  "env-file": {
    ...ready,
    about: "ready, plus a .env with a key keypin.toml doesn't map, to import",
    files: { ...ready.files, ".env": "RESEND_API_KEY=verify-resend-2f7c\nPORT=3000\n" },
  },
  "slow-1password": {
    ...ready,
    about: "ready, but 1Password takes 1.5s to answer, as when it asks to approve keypin",
    onePassword: { ...ready.onePassword, slowMs: 1500 },
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

export function placeOf(target: {
  to: string;
  repo?: string;
  worker?: string;
  environment?: string;
}): string {
  return target.to === "cloudflare-worker"
    ? `cloudflare-worker:${target.worker ?? ""}`
    : `github-actions:${target.repo ?? ""}${target.environment === undefined ? "" : `/environments/${target.environment}`}`;
}

export const SHORTEST_VALUE = 8;

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
    .flatMap(([, text]) =>
      text.split("\n").map((line) =>
        line
          .split("=")
          .slice(1)
          .join("=")
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2"),
      ),
    )
    .filter((value) => value.length >= SHORTEST_VALUE);
  return [...items.map((item) => item.value), ...env];
}
