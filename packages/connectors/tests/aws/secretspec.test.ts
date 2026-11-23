import { describe, expect, test } from "vite-plus/test";
import type { SecretspecAt } from "@keypin/core";
import { locate } from "../../src/aws/secretspec";

const at = (uri: string, ref: SecretspecAt["ref"] = null): SecretspecAt => ({
  uri,
  project: "web",
  profile: "production",
  key: "STRIPE_KEY",
  ref,
});

describe("awssm:// providers", () => {
  test("without a ref, the secret is secretspec's own, [prefix/]secretspec/<project>/<profile>/<KEY>", () => {
    expect(locate(at("awssm://us-east-1"))).toEqual({
      kind: "awssm",
      region: "us-east-1",
      name: "secretspec/web/production/STRIPE_KEY",
      field: null,
    });
    expect(
      locate(at("awssm://us-east-1?prefix=acme/&kms_key_id=alias/x&tag.team=web")),
    ).toMatchObject({ name: "acme/secretspec/web/production/STRIPE_KEY" });
    expect(locate(at("awssm://us-east-1/?prefix=/"))).toMatchObject({
      name: "/secretspec/web/production/STRIPE_KEY",
    });
  });

  test("an empty prefix is no prefix, as secretspec reads it", () => {
    expect(locate(at("awssm://us-east-1?prefix="))).toMatchObject({
      name: "secretspec/web/production/STRIPE_KEY",
    });
  });

  test("a ref names the secret, and its field one key of a JSON secret", () => {
    expect(locate(at("awssm://eu-west-1", { item: "prod/db", field: "password" }))).toEqual({
      kind: "awssm",
      region: "eu-west-1",
      name: "prod/db",
      field: "password",
    });
    expect(locate(at("awssm://eu-west-1", { item: "prod/db" }))).toMatchObject({ field: null });
  });

  test.each([
    ["awssm://", "doesn't name a region, so CI and the console can't find the secret"],
    ["awssm://?prefix=acme", "doesn't name a region"],
    ["awssm://Mars", "doesn't name a region"],
    ["awssm://work@us-east-1", "names an AWS profile; keypin signs in only with the credentials"],
    ["awssm://us-east-1/prod/stripe", "takes no path"],
    ["awssm://us-east-1#x", "takes no path"],
    ["awssm+sso://us-east-1", "doesn't read awssm+sso:// providers"],
  ])("%s is refused", (uri, problem) => {
    expect(locate(at(uri))).toContain(problem);
  });

  test.each([
    [{ item: "arn:aws:secretsmanager:us-east-1:123456789012:secret:db-AbCdEf" }, "by ARN"],
    [{ item: "db", version: "AWSPREVIOUS" }, `has the field "version"`],
    [{ item: "db", field: 3 }, "has a field keypin can't read"],
    [{ item: "db secret" }, `has item "db secret", which isn't an AWS secret name`],
    [{ field: "password" }, "needs item"],
  ])("the ref %j is refused", (ref, problem) => {
    expect(locate(at("awssm://us-east-1", ref))).toContain(problem);
  });

  test("a secretspec name past AWS's 512 characters is refused", () => {
    expect(locate({ ...at("awssm://us-east-1"), key: "K".repeat(512) })).toContain(
      "isn't an AWS secret name keypin reads",
    );
  });
});
