import { describe, expect, test } from "vite-plus/test";
import type { Fetch } from "@keypin/core";
import { listRepoSecrets } from "../../src/github/index";

const TOKEN = "token-sentinel-41b2";

function fakeFetch(
  replies: { status: number; body?: unknown; headers?: Record<string, string> }[],
) {
  const requests: { method: string; url: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    requests.push({ method: init.method, url });
    const reply = replies.shift() ?? { status: 500 };
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: "headers" in reply ? reply.headers : undefined,
    });
  };
  return { fetch, requests };
}

const secret = (n: number) => ({ name: `KEY_${n}`, updated_at: "2026-11-01T00:00:00Z" });

describe("listRepoSecrets", () => {
  test("reads names and updated_at with GET only, page by page", async () => {
    const first = Array.from({ length: 100 }, (_, i) => secret(i));
    const fake = fakeFetch([
      { status: 200, body: { total_count: 101, secrets: first } },
      { status: 200, body: { total_count: 101, secrets: [secret(100)] } },
    ]);
    const read = await listRepoSecrets({
      repo: "acme/billing",
      token: async () => TOKEN,
      fetch: fake.fetch,
    });
    expect(read.ok && read.secrets.length).toBe(101);
    expect(read.ok && read.secrets[100]).toEqual({
      name: "KEY_100",
      updatedAt: "2026-11-01T00:00:00Z",
    });
    expect(fake.requests.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(fake.requests[1]?.url).toBe(
      "https://api.github.com/repos/acme/billing/actions/secrets?per_page=100&page=2",
    );
  });

  test("reads an environment's secrets, with its name escaped", async () => {
    const fake = fakeFetch([{ status: 200, body: { total_count: 1, secrets: [secret(1)] } }]);
    const read = await listRepoSecrets({
      repo: "acme/billing",
      environment: "prod/eu",
      token: async () => TOKEN,
      fetch: fake.fetch,
    });
    expect(read).toEqual({
      ok: true,
      secrets: [{ name: "KEY_1", updatedAt: "2026-11-01T00:00:00Z" }],
    });
    expect(fake.requests[0]?.url).toBe(
      "https://api.github.com/repos/acme/billing/environments/prod%2Feu/secrets?per_page=100&page=1",
    );
    const missing = await listRepoSecrets({
      repo: "acme/billing",
      environment: "staging",
      token: async () => TOKEN,
      fetch: fakeFetch([{ status: 404 }]).fetch,
    });
    expect(missing).toEqual({
      ok: false,
      reason: "HTTP 404: acme/billing has no environment named staging, or the login can't see it",
    });
  });

  test("a refusal is a reason, not an empty list, and doesn't hold the token", async () => {
    for (const [status, reason] of [
      [403, "HTTP 403"],
      [404, "HTTP 404"],
      [401, "HTTP 401"],
    ] as const) {
      const read = await listRepoSecrets({
        repo: "acme/billing",
        token: async () => TOKEN,
        fetch: fakeFetch([{ status, body: { message: TOKEN } }]).fetch,
      });
      expect(read.ok).toBe(false);
      expect(JSON.stringify(read)).toContain(reason);
      expect(JSON.stringify(read)).not.toContain(TOKEN);
    }
  });

  test("reads the organization secrets shared with a repo, and none for a personal repo", async () => {
    const fake = fakeFetch([
      { status: 200, body: { total_count: 1, secrets: [secret(1)] } },
      { status: 422, body: { message: "Validation Failed" } },
    ]);
    const read = () =>
      listRepoSecrets({
        repo: "acme/billing",
        organization: true,
        token: async () => TOKEN,
        fetch: fake.fetch,
      });
    expect(await read()).toEqual({
      ok: true,
      secrets: [{ name: "KEY_1", updatedAt: "2026-11-01T00:00:00Z" }],
    });
    expect(fake.requests[0]?.url).toBe(
      "https://api.github.com/repos/acme/billing/actions/organization-secrets?per_page=100&page=1",
    );
    expect(await read()).toEqual({ ok: true, secrets: [] });
  });

  test("a 422 after the first page of organization secrets is a reason, not an empty list", async () => {
    const read = await listRepoSecrets({
      repo: "acme/billing",
      organization: true,
      token: async () => TOKEN,
      fetch: fakeFetch([
        {
          status: 200,
          body: { total_count: 101, secrets: Array.from({ length: 100 }, (_, i) => secret(i)) },
        },
        { status: 422, body: { message: "Validation Failed" } },
      ]).fetch,
    });
    expect(read).toEqual({ ok: false, reason: "GitHub returned HTTP 422" });
  });

  test("a token that can't list organization secrets is a reason, not an empty list", async () => {
    const read = await listRepoSecrets({
      repo: "acme/billing",
      organization: true,
      token: async () => TOKEN,
      fetch: fakeFetch([{ status: 403, body: { message: TOKEN } }]).fetch,
    });
    expect(read).toEqual({
      ok: false,
      reason:
        "HTTP 403: the login isn't allowed to list the organization secrets shared with acme/billing",
    });
  });

  test("no login and a bad repo name are reasons too", async () => {
    const noLogin = await listRepoSecrets({
      repo: "acme/billing",
      token: async () => {
        throw new Error("gh has no token for acme");
      },
      fetch: fakeFetch([]).fetch,
    });
    expect(noLogin).toEqual({ ok: false, reason: "gh has no token for acme" });
    const badRepo = await listRepoSecrets({ repo: "nope", token: async () => TOKEN });
    expect(badRepo.ok).toBe(false);
  });

  test("a token not authorized for SAML SSO says to authorize it, with GitHub's link", async () => {
    const url = "https://github.com/orgs/acme/sso?authorization_request=abc123";
    const fake = fakeFetch([
      {
        status: 403,
        body: { message: "SAML" },
        headers: { "x-github-sso": `required; url=${url}` },
      },
    ]);
    const read = await listRepoSecrets({
      repo: "acme/billing",
      token: async () => TOKEN,
      fetch: fake.fetch,
    });
    expect(read).toEqual({
      ok: false,
      reason: `HTTP 403: the gh token isn't authorized for SAML SSO in acme; authorize the gh token for SSO in acme: ${url} (the link expires in an hour)`,
    });
  });
});
