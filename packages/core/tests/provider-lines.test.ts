import { describe, expect, test } from "vite-plus/test";
import { providerLines } from "../src/index";
import { VAULT_KINDS } from "./fixtures";
import { read } from "./secretspec";

const PROJECT = `[project]\nname = "web"\nrevision = "1.0"\n`;
const URI = JSON.stringify(
  VAULT_KINDS.find((vault) => vault.newKeys)?.newKeys?.provider ?? "missing",
);

describe("the [providers] and [defaults] lines check prints", () => {
  test("a secret with no provider gets an alias and [defaults]", () => {
    const text = `${PROJECT}\n[profiles.default]\nAPI_KEY = { description = "API" }\n`;
    expect(providerLines(text, [], VAULT_KINDS)).toEqual({
      toml: `[providers]\nonepassword = ${URI}\n\n[defaults]\nproviders = ["onepassword"]\n`,
      existing: [],
    });
  });

  test("an alias the file doesn't define gets its [providers] line", () => {
    const text = `${PROJECT}\n[profiles.production]\nAPI_KEY = { description = "API", providers = ["shared"] }\n`;
    expect(providerLines(text, [], VAULT_KINDS)).toEqual({
      toml: `[providers]\nshared = ${URI}\n`,
      existing: [],
    });
  });

  test("a defined alias goes into [defaults], which the file already has", () => {
    const text = `${PROJECT}\n[providers]\nacme = "onepassword://Acme"\n\n[defaults]\nrequired = true\n\n[profiles.default]\n`;
    expect(providerLines(text, ["default"], VAULT_KINDS)).toEqual({
      toml: `[defaults]\nproviders = ["acme"]\n`,
      existing: ["[defaults]"],
    });
  });

  test("a file whose secrets and profiles all name a provider needs nothing", () => {
    const text = `${PROJECT}\n[providers]\nacme = "onepassword://Acme"\n\n[defaults]\nproviders = ["acme"]\n\n[profiles.default]\nAPI_KEY = { description = "API" }\n`;
    expect(providerLines(text, ["default", "production"], VAULT_KINDS)).toBeNull();
  });

  test("a profile with inherit = false doesn't take default's provider, and the repair makes it parse", () => {
    const text = `${PROJECT}\n[providers]\nacme = "onepassword://my.1password.com@Acme"\n\n[profiles.default]\nAPI_KEY = { description = "API", providers = ["acme"] }\n\n[profiles.production.defaults]\ninherit = false\n\n[profiles.production]\nAPI_KEY = { description = "API" }\n`;
    const lines = providerLines(text, [], VAULT_KINDS);
    expect(lines).toEqual({ toml: `[defaults]\nproviders = ["acme"]\n`, existing: [] });
    expect(read(`${text}\n${lines?.toml}`).ok).toBe(true);
  });
});
