import { type Fetch, type IdToken, NoIdToken, parseObject } from "@keypin/core";

const REQUEST_URL = "ACTIONS_ID_TOKEN_REQUEST_URL";
const REQUEST_TOKEN = "ACTIONS_ID_TOKEN_REQUEST_TOKEN";

export function githubIdToken(
  env: Readonly<Record<string, string | undefined>>,
  fetch: Fetch,
): IdToken {
  const url = env[REQUEST_URL];
  const bearer = env[REQUEST_TOKEN];
  return async (audience) => {
    if (!url || !bearer)
      throw new NoIdToken(
        `this job can't ask GitHub Actions for an OIDC token (${REQUEST_URL} and ${REQUEST_TOKEN} aren't set); give it permissions: id-token: write`,
      );
    const asked = new URL(url);
    if (audience !== null) asked.searchParams.set("audience", audience);
    const response = await fetch(asked.href, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `bearer ${bearer}` },
      redirect: "error",
    });
    const value = parseObject(await response.text()).value;
    if (response.status !== 200)
      throw new Error(`GitHub's OIDC token endpoint returned HTTP ${response.status}`);
    if (typeof value !== "string" || !value)
      throw new Error("GitHub's OIDC token endpoint returned no token");
    return value;
  };
}
