import { assert } from "vite-plus/test";
import { type MapResult, readSecretspec, type VaultRules } from "../src/index";
import { ISSUERS, KINDS, MAP_FILE, PULLS, VAULT_KINDS } from "./fixtures";

export const HEAD = `[project]
name = "web"
revision = "1.0"

[providers]
acme = "onepassword://my.1password.com@Acme"

[defaults]
providers = ["acme"]
`;

export function read(text: string, vaults: readonly VaultRules[] = VAULT_KINDS): MapResult {
  return readSecretspec(text, MAP_FILE, KINDS, ISSUERS, vaults, PULLS);
}

export function errorsOf(text: string): string[] {
  const result = read(text);
  assert(!result.ok, "expected the file to be refused");
  return result.errors;
}
