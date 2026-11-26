import sodium from "libsodium-wrappers";
import { type Fetch, isRecord } from "@keypin/core";

export interface FakeRepo {
  owner: string;
  push: boolean;
  environments?: string[];
}

export interface FakeGitHub {
  login: string;
  scopes?: string | null;
  repos: Record<string, FakeRepo>;
  failPut?: boolean;
  tokenExpires?: string;
  revoked?: boolean;
  app?: boolean;
}

const SECRETS = /^\/repos\/([^/]+\/[^/]+)\/(?:actions|environments\/([^/]+))\/secrets(?:\/(.+))?$/;

export async function githubFetch(fake: FakeGitHub) {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  const key = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
  const stored = new Map<string, string>();
  const effects: string[] = [];
  const place = (repo: string, environment: string | undefined, name: string) =>
    `${repo}${environment === undefined ? "" : ` (${environment})`} ${name}`;
  const open = (sealed: string) =>
    sodium.crypto_box_seal_open(
      sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
      pair.publicKey,
      pair.privateKey,
      "text",
    );

  const fetch: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const reply = (status: number, body?: unknown, headers?: Record<string, string>) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
    const scopes = fake.scopes === undefined ? "repo" : fake.scopes;
    if (fake.revoked) return reply(401, { message: "Bad credentials" });
    if (path === "/user" && fake.app)
      return reply(403, { message: "Resource not accessible by integration" });
    if (path === "/user")
      return reply(
        200,
        { login: fake.login },
        {
          ...(scopes === null ? {} : { "x-oauth-scopes": scopes }),
          ...(fake.tokenExpires === undefined
            ? {}
            : { "github-authentication-token-expiration": fake.tokenExpires }),
        },
      );
    const repoName = /^\/repos\/([^/]+\/[^/]+)$/.exec(path)?.[1];
    if (repoName !== undefined) {
      const repo = fake.repos[repoName];
      return repo
        ? reply(200, {
            owner: { login: repo.owner },
            permissions: { push: !fake.app && repo.push },
          })
        : reply(404, { message: "Not Found" });
    }
    const [, repoOf = "", encoded, rest] = SECRETS.exec(path) ?? [];
    const repo = fake.repos[repoOf];
    const environment = encoded === undefined ? undefined : decodeURIComponent(encoded);
    if (!repo || (environment !== undefined && !repo.environments?.includes(environment)))
      return reply(404, { message: "Not Found" });
    if (rest === "public-key") return reply(200, { key_id: "fake-kid", key });
    if (rest === undefined) return reply(404, { message: "Not Found" });
    const where = place(repoOf, environment, rest);
    if (init.method === "PUT") {
      if (!fake.app && !repo.push)
        return reply(403, { message: "Resource not accessible by integration" });
      const sent: unknown = JSON.parse(init.body ?? "{}");
      const sealed = isRecord(sent) ? sent.encrypted_value : undefined;
      if (typeof sealed !== "string") return reply(422, { message: "encrypted_value missing" });
      const value = open(sealed);
      if (fake.failPut) return reply(500, { message: `could not store ${value}` });
      const created = !stored.has(where);
      stored.set(where, value);
      effects.push(`github put ${where}`);
      return reply(created ? 201 : 204);
    }
    if (stored.has(where))
      return reply(200, {
        name: rest,
        created_at: "2026-11-09T18:00:00Z",
        updated_at: "2026-11-09T18:00:00Z",
      });
    return reply(404, { message: "Not Found" });
  };

  return {
    fetch,
    effects,
    value: (repo: string, name: string, environment?: string) =>
      stored.get(place(repo, environment, name)),
  };
}
