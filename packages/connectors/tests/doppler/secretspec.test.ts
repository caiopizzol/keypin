import { describe, expect, test } from "vite-plus/test";
import type { SecretspecAt } from "@keypin/core";
import { locate } from "../../src/doppler/secretspec";

const at = (uri: string, ref: SecretspecAt["ref"] = null): SecretspecAt => ({
  uri,
  project: "billing",
  profile: "dev",
  key: "STRIPE_KEY",
  ref,
});

describe("doppler:// providers", () => {
  test("without a ref, the secret is the key in the config the profile names", () => {
    expect(locate(at("doppler://web"))).toEqual({
      kind: "doppler",
      project: "web",
      config: "dev",
      name: "STRIPE_KEY",
    });
  });

  test("a config in the provider wins over the profile", () => {
    expect(locate(at("doppler://web/prd/"))).toMatchObject({ config: "prd", name: "STRIPE_KEY" });
  });

  test.each([
    ["doppler://web", "SHARED_CA", "dev", "SHARED_CA"],
    ["doppler://web/prd", "SHARED_CA", "prd", "SHARED_CA"],
    ["doppler://web/prd", "shared/SHARED_CA", "shared", "SHARED_CA"],
  ])("%s with the ref item %s is %s/%s", (uri, item, config, name) => {
    expect(locate(at(uri, { item }))).toEqual({ kind: "doppler", project: "web", config, name });
  });

  test.each([
    ["doppler://", "whose project isn't a Doppler project name"],
    ["doppler://Web", "whose project isn't a Doppler project name"],
    ["doppler://web/prd/extra", "whose config isn't one Doppler config name"],
    ["doppler://web/Prd", "whose config isn't one Doppler config name"],
    ["doppler://web?config=prd", "takes only a project and a config"],
    ["doppler://web#prd", "takes only a project and a config"],
    ["doppler://me@web", "takes only a project and a config"],
    ["doppler://web:443", "takes only a project and a config"],
    ["doppler+token://web", "doesn't read doppler+token:// providers"],
  ])("%s is refused", (uri, problem) => {
    expect(locate(at(uri))).toContain(problem);
  });

  test("a profile that can't name a config is refused, unless the provider names one", () => {
    expect(locate({ ...at("doppler://web"), profile: "dev.eu" })).toBe(
      `the config "dev.eu" isn't a Doppler config name, which uses only lowercase letters, digits, - and _; name the config in the provider, such as doppler://web/<config>`,
    );
    expect(locate({ ...at("doppler://web/dev_eu"), profile: "dev.eu" })).toMatchObject({
      config: "dev_eu",
    });
  });

  test.each([
    [null, "stripe_key", `"stripe_key" isn't a Doppler secret name`],
    [null, "DOPPLER_CONFIG", "Doppler reserves the secret name DOPPLER_CONFIG"],
    [{ item: "prd/1KEY" }, "STRIPE_KEY", `"1KEY" isn't a Doppler secret name`],
    [{ item: "Prd/KEY" }, "STRIPE_KEY", `the config "Prd" isn't a Doppler config name`],
    [
      { item: "KEY", version: 1 },
      "STRIPE_KEY",
      `has the field "version"; a Doppler ref has only item`,
    ],
    [{ item: "" }, "STRIPE_KEY", "needs item"],
  ])("the ref %j for %s is refused", (ref, key, problem) => {
    expect(locate({ ...at("doppler://web", ref), key })).toContain(problem);
  });
});
