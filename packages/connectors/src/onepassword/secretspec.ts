import type { SecretspecAt } from "@keypin/core";
import type { OnePasswordRef } from "./reference";

const URI = /^onepassword(\+[^:]*)?:\/\/(.*)$/is;
const SHAPE = "onepassword://<sign-in address>@<vault>";
const REF_FIELDS = ["item", "field", "section", "vault"];

export const CONVENTION_FIELD = "value";
export const CREATED_FIELD = "password";

export function locate({ uri, project, profile, key, ref }: SecretspecAt): OnePasswordRef | string {
  const [, variant, rest = ""] = URI.exec(uri) ?? [];
  if (variant !== undefined)
    return `uses ${uri}; keypin doesn't read onepassword${variant}:// providers yet, so write ${SHAPE}. keypin signs in with the 1Password app, or with OP_SERVICE_ACCOUNT_TOKEN when KEYPIN_1PASSWORD=service-account`;
  const place = rest.replace(/\/$/, "");
  if (place.includes("/"))
    return `uses ${uri}, which names more than a vault; write ${SHAPE}, and name the item with ref = { item = "..." }`;
  const at = place.indexOf("@");
  const account = decoded(place.slice(0, at));
  const named = decoded(place.slice(at + 1));
  if (at === -1 || !account || !named)
    return `uses ${uri}, which doesn't name the 1Password account; write ${SHAPE}, with the sign-in address at the top left of the 1Password app (such as my.1password.com) or the account ID`;
  if (ref === null)
    return convention(named, `secretspec/${project}/${profile}/${key}`, null, account);
  const unknown = Object.keys(ref).find((field) => !REF_FIELDS.includes(field));
  if (unknown !== undefined)
    return `field "ref" has the unknown field "${unknown}"; a 1Password ref has item, field, section and vault`;
  const text = (field: string): string | null | undefined => {
    const value = ref[field];
    if (value === undefined) return null;
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const [item, field, section, vault] = REF_FIELDS.map(text);
  if (!item) return `field "ref" needs item, the 1Password item's title or ID`;
  if (field === undefined || section === undefined || vault === undefined)
    return `field "ref" holds item, field, section and vault as non-empty strings`;
  if (section !== null && field === null)
    return `field "ref" names a section, so it needs field too`;
  const store = vault ?? named;
  if (field === null) return convention(store, item, section, account);
  return { kind: "1password", vault: store, item, section, field, account };
}

function convention(
  vault: string,
  item: string,
  section: string | null,
  account: string,
): OnePasswordRef {
  const field = CONVENTION_FIELD;
  return { kind: "1password", vault, item, section, field, fallback: CREATED_FIELD, account };
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text).trim();
  } catch {
    return "";
  }
}
