import { describe, expect, test } from "vite-plus/test";
import { format } from "../../src/onepassword/reference";

const ref = (item: string, section: string | null = null) =>
  ({ kind: "1password", vault: "Acme", item, section, field: "value" }) as const;

describe("how keypin shows a 1Password field", () => {
  test("as a secret reference when 1Password can read every name in it", () => {
    expect(format(ref("resend admin key"))).toBe("op://Acme/resend admin key/value");
    expect(format(ref("api.key_2", "prod-keys"))).toBe("op://Acme/api.key_2/prod-keys/value");
  });

  test("as a path, not a reference, when a name has a character 1Password can't read", () => {
    expect(format(ref("secretspec/billing/production/STRIPE_API_KEY"))).toBe(
      "Acme › secretspec/billing/production/STRIPE_API_KEY › value",
    );
    expect(format(ref("Stripe (live)"))).toBe("Acme › Stripe (live) › value");
  });
});
