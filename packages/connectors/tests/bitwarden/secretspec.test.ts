import { describe, expect, test } from "vite-plus/test";
import type { SecretspecAt } from "@keypin/core";
import { locate } from "../../src/bitwarden/secretspec";

const ID = "a9230ec4-5507-4870-b8b5-b3f500587e4c";

const at = (uri: string, ref: SecretspecAt["ref"] = null): SecretspecAt => ({
  uri,
  project: "web",
  profile: "production",
  key: "STRIPE_KEY",
  ref,
});

describe("bws:// providers", () => {
  test("without a ref, the secret is named after the key, in every profile", () => {
    const cloud = { kind: "bitwarden", url: "https://vault.bitwarden.com", project: ID };
    expect(locate(at(`bws://${ID}`))).toEqual({ ...cloud, name: "STRIPE_KEY" });
    expect(locate({ ...at(`bws://${ID}/`), profile: "dev" })).toEqual({
      ...cloud,
      name: "STRIPE_KEY",
    });
  });

  test("a server before @ is the Bitwarden server, and the project ID is lowercased", () => {
    expect(locate(at(`bws://vault.bitwarden.eu@${ID.toUpperCase()}`))).toEqual({
      kind: "bitwarden",
      url: "https://vault.bitwarden.eu",
      project: ID,
      name: "STRIPE_KEY",
    });
    expect(locate(at(`bws://bw.acme.dev:8443@${ID}`))).toMatchObject({
      url: "https://bw.acme.dev:8443",
    });
  });

  test("a ref item is the secret's name", () => {
    expect(locate(at(`bws://${ID}`, { item: "prod-db-connection" }))).toMatchObject({
      name: "prod-db-connection",
    });
  });

  test.each([
    ["bws://", "doesn't name a project ID"],
    ["bws://billing", "doesn't name a project ID"],
    [`bws://${ID}/STRIPE_KEY`, "names more than a project"],
    [`bws://${ID}?server=eu`, "names more than a project"],
    [`bws://bad\\server@${ID}`, "whose server keypin can't read"],
    [`bws+token://${ID}`, "doesn't read bws+token:// providers"],
  ])("%s is refused", (uri, problem) => {
    expect(locate(at(uri))).toContain(problem);
  });

  test.each([
    [
      { item: "A", field: "password" },
      `names field; a Bitwarden Secrets Manager ref has only item`,
    ],
    [{ item: "A", version: 2 }, "names version"],
    [{ item: "A", shelf: "x" }, `has the unknown field "shelf"`],
    [{ item: " " }, "needs item"],
  ])("the ref %j is refused", (ref, problem) => {
    expect(locate(at(`bws://${ID}`, ref))).toContain(problem);
  });
});
