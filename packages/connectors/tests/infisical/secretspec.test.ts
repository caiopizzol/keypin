import { describe, expect, test } from "vite-plus/test";
import type { SecretspecAt } from "@keypin/core";
import { locate } from "../../src/infisical/secretspec";

const ID = "7e2f1a4c-0b1d-4c8e-9f00-1234567890ab";
const CLOUD = `infisical://app.infisical.com/${ID}`;

const at = (uri: string, ref: SecretspecAt["ref"] = null): SecretspecAt => ({
  uri,
  project: "web",
  profile: "production",
  key: "STRIPE_KEY",
  ref,
});

const place = { kind: "infisical", url: "https://app.infisical.com", project: ID };

describe("infisical:// providers", () => {
  test("without a ref, the secret is secretspec's own: <path>/<project>/<profile>/<KEY>", () => {
    expect(locate(at(CLOUD))).toEqual({
      ...place,
      environment: "production",
      path: "/secretspec/web/production",
      name: "STRIPE_KEY",
    });
  });

  test("env names the environment, and path the folder prefix, for any profile", () => {
    const uri = `infisical://eu.infisical.com:8443/${ID}/?env=prod&path=apps/`;
    expect(locate(at(uri))).toEqual({
      ...place,
      url: "https://eu.infisical.com:8443",
      environment: "prod",
      path: "/apps/web/production",
      name: "STRIPE_KEY",
    });
    expect(locate(at(`${CLOUD}?path=/&tls=true`))).toMatchObject({ path: "/web/production" });
  });

  test.each([
    ["RESEND", "/secretspec", "RESEND"],
    ["/RESEND", "/", "RESEND"],
    ["team/RESEND", "/secretspec/team", "RESEND"],
    ["/billing/shared/RESEND", "/billing/shared", "RESEND"],
    ["/billing//RESEND", "/billing", "RESEND"],
  ])("a ref item %s is the secret %s, %s", (item, path, name) => {
    expect(locate(at(CLOUD, { item }))).toEqual({
      ...place,
      environment: "production",
      path,
      name,
    });
  });

  test.each([
    [
      "infisical:///" + ID,
      "doesn't name the Infisical server, so CI and the console can't find it",
    ],
    ["infisical://app.infisical.com", "doesn't name a project ID"],
    ["infisical://app.infisical.com/billing", "doesn't name a project ID"],
    [`infisical://app.infisical.com/${ID}/apps`, "doesn't name a project ID"],
    [`infisical://me@app.infisical.com/${ID}`, "whose host keypin can't read"],
    [`${CLOUD}?tls=false`, "keypin signs in to Infisical only over https, so remove tls=false"],
    [`${CLOUD}?tls=0`, "so remove tls=0"],
    [`${CLOUD}#prod`, "which has a #"],
    [`infisical+token://app.infisical.com/${ID}`, "doesn't read infisical+token:// providers"],
  ])("%s is refused", (uri, problem) => {
    expect(locate(at(uri))).toContain(problem);
  });

  test("a project or profile that can't name a folder is refused without a ref, as secretspec does", () => {
    expect(locate({ ...at(CLOUD), project: "my.app" })).toBe(
      `"my.app" can't name an Infisical folder, which uses only letters, digits, - and _; rename it, or give the secret a ref = { item = "/<folder>/<NAME>" }`,
    );
    expect(locate({ ...at(CLOUD, { item: "/RESEND" }), project: "my.app" })).toMatchObject({
      name: "RESEND",
    });
  });

  test.each([
    [{ item: "/RESEND", version: 3 }, "names a version, which secretspec only reads"],
    [{ item: "/RESEND", field: "value" }, `has the field "field"; an Infisical ref has only item`],
    [{ item: "" }, "needs item"],
    [{}, "needs item"],
    [{ item: "/billing/" }, "names the folder /billing/; add the secret's name after it"],
  ])("the ref %j is refused", (ref, problem) => {
    expect(locate(at(CLOUD, ref))).toContain(problem);
  });
});
