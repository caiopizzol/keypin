import { expect, test } from "vite-plus/test";
import { type Fetch, NoIdToken } from "@keypin/core";
import { githubIdToken } from "../../src/github/index";

const REQUEST_URL = "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0";
const REQUEST_TOKEN = "request-token-sentinel-1e7b";
const JWT = "github-jwt-sentinel-5c2d";
const ENV = {
  ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
};

function github(status = 200, body: unknown = { value: JWT }) {
  const calls: { url: string; init: Parameters<Fetch>[1] }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

test("without both request variables there is no token, and GitHub isn't asked", async () => {
  const fake = github();
  for (const env of [
    {},
    { ACTIONS_ID_TOKEN_REQUEST_URL: REQUEST_URL },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN },
  ]) {
    const error = await githubIdToken(env, fake.fetch)(null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoIdToken);
    expect(String(error)).toContain(
      "this job can't ask GitHub Actions for an OIDC token (ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN aren't set); give it permissions: id-token: write",
    );
  }
  expect(fake.calls).toEqual([]);
});

test("asks GitHub with its request token, and adds the audience only when given", async () => {
  const fake = github();
  const token = githubIdToken(ENV, fake.fetch);
  expect(await token(null)).toBe(JWT);
  expect(await token("https://app.infisical.com/a b")).toBe(JWT);
  expect(fake.calls.map((call) => call.url)).toEqual([
    REQUEST_URL,
    `${REQUEST_URL}&audience=https%3A%2F%2Fapp.infisical.com%2Fa+b`,
  ]);
  expect(fake.calls[0]?.init).toMatchObject({
    method: "GET",
    headers: { Authorization: `bearer ${REQUEST_TOKEN}` },
    redirect: "error",
  });
});

test("a failing endpoint or a reply without a token is an error that shows neither token", async () => {
  const errors = await Promise.all(
    [github(500, { message: `bad ${REQUEST_TOKEN}`, value: JWT }), github(200, {})].map(
      async (fake) => githubIdToken(ENV, fake.fetch)(null).catch((error: unknown) => String(error)),
    ),
  );
  expect(errors).toEqual([
    "Error: GitHub's OIDC token endpoint returned HTTP 500",
    "Error: GitHub's OIDC token endpoint returned no token",
  ]);
});
