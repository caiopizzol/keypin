import {
  type AccountCheck,
  type Destination,
  formatReference,
  type KeyRef,
  type ProviderToken,
  type PublishTarget,
  type RotateSpec,
  Secret,
  type StoreRead,
  type TokenProvider,
  type VaultBackend,
} from "@keypin/core";
import { fakeId, fakeValue, type Item, type StoredSecret, type Token, type World } from "./world";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const WORKER = /^[A-Za-z0-9_-]+$/;
const GITHUB_SECRET = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function githubPlace(repo: string): string {
  return `github-actions:${repo.toLowerCase()}`;
}

export function workerPlace(account: string, worker: string): string {
  return `cloudflare-worker:${account}/${worker}`;
}

export function fakeVault(world: World): VaultBackend {
  const where = (ref: KeyRef) => `${formatReference(ref)} (1Password account ${ref.account})`;
  const signedIn = (account: string) => {
    if (!same(account, world.onePassword.account))
      throw new Error(
        `1Password: the sandbox is signed in to ${world.onePassword.account}, not ${account}`,
      );
  };
  const find = (ref: KeyRef): Item | undefined => {
    signedIn(ref.account);
    return world.onePassword.items.find(
      (item) => same(item.vault, ref.vault) && same(item.title, ref.item),
    );
  };
  const fieldName = (item: Item, ref: KeyRef): string => {
    const name = Object.keys(item.fields).find((key) => same(key, fieldKey(ref)));
    if (name === undefined) throw new Error(`${where(ref)}: the item has no field "${ref.field}"`);
    return name;
  };
  return {
    capabilities: { read: true, write: true, list: true, metadata: true },
    async read(ref) {
      const item = find(ref);
      if (!item) throw new Error(`${where(ref)}: no such item`);
      return new Secret(item.fields[fieldName(item, ref)] ?? "");
    },
    async write(ref, secret, options = {}) {
      const item = find(ref);
      if (item && options.newItem)
        throw new Error(`${where(ref)}: the item already exists; keypin doesn't overwrite it`);
      if (!item) {
        if (ref.field !== "password" || ref.section !== null)
          throw new Error(`${where(ref)}: no such item; create it in 1Password first`);
        world.onePassword.items.push({
          vault: ref.vault,
          title: ref.item,
          fields: { password: secret.reveal() },
          rotated: options.rotated ?? null,
        });
        return;
      }
      item.fields[fieldName(item, ref)] = secret.reveal();
      if (options.rotated) item.rotated = options.rotated;
    },
    async list(scope) {
      signedIn(scope.account);
      return world.onePassword.items
        .filter((item) => same(item.vault, scope.vault))
        .map((item) => ({ id: item.title, title: item.title, tags: [], updatedAt: "" }));
    },
    async metadata(ref) {
      const item = find(ref);
      if (!item) throw new Error(`${where(ref)}: no such item`);
      return { rotated: item.rotated };
    },
  };
}

export function fieldKey(ref: Pick<KeyRef, "section" | "field">): string {
  return ref.section === null ? ref.field : `${ref.section}.${ref.field}`;
}

export function fakeDestination(world: World, target: PublishTarget, now: () => Date): Destination {
  let passed = false;
  const store = (list: StoredSecret[], place: string, name: string, secret: Secret) => {
    const updatedAt = now().toISOString();
    const found = list.find((s) => s.place === place && s.name === name);
    if (found) Object.assign(found, { value: secret.reveal(), updatedAt });
    else list.push({ place, name, value: secret.reveal(), updatedAt });
    return { destination: place, secret: name, at: updatedAt, sandbox: true };
  };
  if (target.to === "github-actions") {
    const place = githubPlace(target.repo);
    const login = world.github.login;
    return {
      capabilities: { write: true, accountCheck: true, evidence: true },
      describe: () => `github ${target.repo} (repo secret, sandbox)`,
      async checkAccount(): Promise<AccountCheck> {
        passed = false;
        const facts = { publisher: login, expected: target.account };
        const repo = world.github.repos.find((r) => same(r, target.repo));
        if (!repo)
          return {
            ...facts,
            destinationAccount: null,
            ok: false,
            reason: `${login} can't see ${target.repo}`,
          };
        const owner = repo.split("/")[0] ?? repo;
        if (!same(login, target.account))
          return {
            ...facts,
            destinationAccount: owner,
            ok: false,
            reason: `the token acts as ${login}, not ${target.account}`,
          };
        passed = true;
        return { ...facts, destinationAccount: owner, ok: true };
      },
      async write(name, secret) {
        if (!passed) throw new Error(`refusing to write to ${place}: checkAccount hasn't passed`);
        if (!GITHUB_SECRET.test(name) || /^GITHUB_/i.test(name))
          throw new Error(`"${name}" isn't a valid GitHub secret name`);
        return store(world.github.secrets, place, name.toUpperCase(), secret);
      },
    };
  }
  if (!WORKER.test(target.worker)) throw new Error(`"${target.worker}" isn't a Worker name`);
  const place = workerPlace(target.account, target.worker);
  return {
    capabilities: { write: true, accountCheck: true, evidence: true },
    describe: () =>
      `cloudflare worker ${target.worker} in account ${target.account} (worker secret, sandbox)`,
    async checkAccount(): Promise<AccountCheck> {
      passed = false;
      const facts = { publisher: world.cloudflare.email, expected: target.account };
      if (!world.cloudflare.accounts.includes(target.account)) {
        const reachable = world.cloudflare.accounts.join(", ") || "no account";
        return {
          ...facts,
          destinationAccount: null,
          ok: false,
          reason: `the login can reach ${reachable}, not ${target.account}`,
        };
      }
      if (!world.cloudflare.workers.includes(`${target.account}/${target.worker}`))
        return {
          ...facts,
          destinationAccount: null,
          ok: false,
          reason: `account ${target.account} has no Worker ${target.worker}`,
        };
      passed = true;
      return { ...facts, destinationAccount: target.account, ok: true };
    },
    async write(name, secret) {
      if (!passed) throw new Error(`refusing to write to ${place}: checkAccount hasn't passed`);
      return store(world.cloudflare.secrets, place, name, secret);
    },
  };
}

export function fakeGithubSecrets(world: World, repo: string, login: string): StoreRead {
  if (!same(login, world.github.login))
    return {
      ok: false,
      reason: `no gh login for ${login} (the sandbox is signed in as ${world.github.login})`,
    };
  if (!world.github.repos.some((r) => same(r, repo)))
    return { ok: false, reason: `${login} can't see ${repo}` };
  return names(world.github.secrets, githubPlace(repo));
}

export function fakeWorkerSecrets(world: World, account: string, worker: string): StoreRead {
  if (!WORKER.test(worker)) return { ok: false, reason: `"${worker}" isn't a Worker name` };
  if (!world.cloudflare.accounts.includes(account))
    return { ok: false, reason: `the wrangler login can't reach account ${account}` };
  if (!world.cloudflare.workers.includes(`${account}/${worker}`))
    return { ok: false, reason: `account ${account} has no Worker ${worker}` };
  return names(world.cloudflare.secrets, workerPlace(account, worker));
}

function names(list: StoredSecret[], place: string): StoreRead {
  return {
    ok: true,
    secrets: list
      .filter((secret) => secret.place === place)
      .map((secret) => ({ name: secret.name, updatedAt: secret.updatedAt })),
  };
}

export function fakeProvider(world: World, spec: RotateSpec, admin: Secret): TokenProvider {
  const base = `/accounts/${spec.account}/tokens`;
  const http = (method: string, path: string, status: number) =>
    new Error(`Cloudflare ${method} ${path} returned HTTP ${status} (sandbox)`);
  const inAccount = () => world.tokens.filter((token) => token.account === spec.account);
  const authorized = (method: string, path: string) => {
    const caller = inAccount().find(
      (t) => admin.equals(new Secret(t.value)) && t.status === "active",
    );
    if (!caller) throw http(method, path, 401);
    if (!caller.admin) throw http(method, path, 403);
  };
  return {
    describe: () => `cloudflare account ${spec.account} tokens (sandbox)`,
    async verify(secret) {
      const found = inAccount().find((t) => secret.equals(new Secret(t.value)));
      if (!found) throw http("GET", `${base}/verify`, 401);
      return { id: found.id, status: found.status, expiresOn: found.expiresOn };
    },
    async details(id) {
      authorized("GET", `${base}/${id}`);
      const found = inAccount().find((t) => t.id === id);
      return found ? providerToken(found) : null;
    },
    async issue(request) {
      authorized("POST", base);
      const token: Token = {
        id: fakeId(),
        account: spec.account,
        name: request.name,
        status: "active",
        expiresOn: request.expiresOn,
        lastUsedOn: null,
        permissions: request.like.policies.flatMap((p) => p.permissionGroups.map((g) => g.id)),
        admin: false,
        value: fakeValue("cloudflare-token"),
      };
      world.tokens.push(token);
      return { token: providerToken(token), value: new Secret(token.value) };
    },
    async revoke(id) {
      authorized("DELETE", `${base}/${id}`);
      const index = world.tokens.findIndex((t) => t.account === spec.account && t.id === id);
      if (index === -1) return "already gone";
      world.tokens.splice(index, 1);
      return "revoked";
    },
  };
}

function providerToken(token: Token): ProviderToken {
  return {
    id: token.id,
    name: token.name,
    status: token.status,
    expiresOn: token.expiresOn,
    lastUsedOn: token.lastUsedOn,
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${token.account}`]: "*" },
        permissionGroups: token.permissions.map((name) => ({ id: name, name })),
      },
    ],
    condition: null,
  };
}
