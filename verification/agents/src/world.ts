import { generationOf, isRecord, Secret } from "@keypin/core";

export const FAKE = "keypin-fake-";

export interface Item {
  vault: string;
  title: string;
  fields: Record<string, string>;
  rotated: string | null;
}

export interface StoredSecret {
  place: string;
  name: string;
  value: string;
  updatedAt: string;
}

export interface Token {
  id: string;
  account: string;
  name: string;
  status: string;
  expiresOn: string | null;
  lastUsedOn: string | null;
  permissions: string[];
  admin: boolean;
  value: string;
}

export interface World {
  version: 1;
  onePassword: { account: string; items: Item[] };
  github: { login: string; repos: string[]; secrets: StoredSecret[] };
  cloudflare: { email: string; accounts: string[]; workers: string[]; secrets: StoredSecret[] };
  tokens: Token[];
  planted: string[];
}

export interface WorldStore {
  view<T>(use: (world: World) => T): T;
  change<T>(use: (world: World) => T): T;
}

export function memoryStore(world: World): WorldStore {
  return { view: (use) => use(world), change: (use) => use(world) };
}

export function emptyWorld(): World {
  return {
    version: 1,
    onePassword: { account: "my.1password.com", items: [] },
    github: { login: "acme", repos: [], secrets: [] },
    cloudflare: { email: "me@example.com", accounts: [], workers: [], secrets: [] },
    tokens: [],
    planted: [],
  };
}

export function fakeValue(label: string): string {
  const random = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${FAKE}${label}-${hex}`;
}

export function fakeId(): string {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fingerprint(value: string): Promise<string> {
  return generationOf(new Secret(value));
}

export function parseWorld(text: string, where: string): World {
  const data: unknown = JSON.parse(text);
  const fail = (what: string): never => {
    throw new Error(`${where}: ${what}`);
  };
  if (!isRecord(data) || data.version !== 1) return fail("not a version 1 sandbox world");
  const op = record(data.onePassword, "onePassword", fail);
  const github = record(data.github, "github", fail);
  const cloudflare = record(data.cloudflare, "cloudflare", fail);
  return {
    version: 1,
    onePassword: {
      account: text_(op.account, "onePassword.account", fail),
      items: list(op.items, "onePassword.items", fail).map((raw, i) => {
        const item = record(raw, `onePassword.items[${i}]`, fail);
        return {
          vault: text_(item.vault, "vault", fail),
          title: text_(item.title, "title", fail),
          fields: textRecord(item.fields, "fields", fail),
          rotated: textOrNull(item.rotated, "rotated", fail),
        };
      }),
    },
    github: {
      login: text_(github.login, "github.login", fail),
      repos: texts(github.repos, "github.repos", fail),
      secrets: secrets(github.secrets, "github.secrets", fail),
    },
    cloudflare: {
      email: text_(cloudflare.email, "cloudflare.email", fail),
      accounts: texts(cloudflare.accounts, "cloudflare.accounts", fail),
      workers: texts(cloudflare.workers, "cloudflare.workers", fail),
      secrets: secrets(cloudflare.secrets, "cloudflare.secrets", fail),
    },
    tokens: list(data.tokens, "tokens", fail).map((raw, i) => {
      const token = record(raw, `tokens[${i}]`, fail);
      return {
        id: text_(token.id, "id", fail),
        account: text_(token.account, "account", fail),
        name: text_(token.name, "name", fail),
        status: text_(token.status, "status", fail),
        expiresOn: textOrNull(token.expiresOn, "expiresOn", fail),
        lastUsedOn: textOrNull(token.lastUsedOn, "lastUsedOn", fail),
        permissions: texts(token.permissions, "permissions", fail),
        admin: flag(token.admin, "admin", fail),
        value: text_(token.value, "value", fail),
      };
    }),
    planted: texts(data.planted, "planted", fail),
  };
}

type Fail = (what: string) => never;

function record(value: unknown, name: string, fail: Fail): Record<string, unknown> {
  return isRecord(value) ? value : fail(`${name} isn't an object`);
}

function list(value: unknown, name: string, fail: Fail): unknown[] {
  return Array.isArray(value) ? value : fail(`${name} isn't a list`);
}

function text_(value: unknown, name: string, fail: Fail): string {
  return typeof value === "string" ? value : fail(`${name} isn't a string`);
}

function flag(value: unknown, name: string, fail: Fail): boolean {
  return typeof value === "boolean" ? value : fail(`${name} isn't true or false`);
}

function textOrNull(value: unknown, name: string, fail: Fail): string | null {
  return value === null || value === undefined ? null : text_(value, name, fail);
}

function texts(value: unknown, name: string, fail: Fail): string[] {
  return list(value, name, fail).map((item) => text_(item, name, fail));
}

function textRecord(value: unknown, name: string, fail: Fail): Record<string, string> {
  const raw = record(value, name, fail);
  return Object.fromEntries(Object.entries(raw).map(([key, v]) => [key, text_(v, name, fail)]));
}

function secrets(value: unknown, name: string, fail: Fail): StoredSecret[] {
  return list(value, name, fail).map((raw) => {
    const secret = record(raw, name, fail);
    return {
      place: text_(secret.place, "place", fail),
      name: text_(secret.name, "name", fail),
      value: text_(secret.value, "value", fail),
      updatedAt: text_(secret.updatedAt, "updatedAt", fail),
    };
  });
}
