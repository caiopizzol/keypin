import type {
  ItemIds,
  KeyRef,
  VaultBackend,
  VaultItem,
  VaultMetadata,
  VaultScope,
} from "@keypin/core";
import { formatReference, isDay, Secret } from "@keypin/core";
import type { Connect, Field, FullItem, SdkClient } from "./sdk";
import { desktopConnect } from "./desktop";

const VALUE_FIELD = "password";
const ROTATED = "rotated";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UNIX_SECONDS = /^\d+$/;

const BUILT_IN = ["private", "personal", "employee"];

export type SignInMode = "desktop" | "service-account";

export function onePasswordBackend(
  connect: Connect = desktopConnect,
  mode: SignInMode = "desktop",
): VaultBackend {
  const clients = new Map<string, Promise<SdkClient>>();

  function client(account: string): Promise<SdkClient> {
    let pending = clients.get(account);
    if (!pending) {
      pending = connect(account).catch((error: unknown) => {
        throw new Error(
          `1Password account "${account}": sign-in failed: ${signInMessage(error, mode)}`,
        );
      });
      clients.set(account, pending);
    }
    return pending;
  }

  async function vaultId(sdk: SdkClient, scope: VaultScope): Promise<string> {
    const matches = named(await sdk.vaults.list(), scope.vault);
    const [match] = matches;
    if (!match) throw new Error(noVault(scope, mode));
    if (matches.length > 1) {
      throw new Error(
        `1Password account "${scope.account}" has ${matches.length} vaults named "${scope.vault}"`,
      );
    }
    return match.id;
  }

  async function find(sdk: SdkClient, id: string, ref: KeyRef): Promise<{ id: string } | null> {
    const matches = named(await sdk.items.list(id), ref.item);
    if (matches.length > 1)
      throw new Error(`${where(ref)}: ${matches.length} items have this name`);
    return matches[0] ?? null;
  }

  async function locate(sdk: SdkClient, ref: KeyRef): Promise<ItemIds> {
    const vault = await vaultId(sdk, ref);
    const found = await find(sdk, vault, ref);
    if (!found) throw new Error(`${where(ref)}: no such item`);
    return { vault, item: found.id };
  }

  async function get(ref: KeyRef): Promise<FullItem> {
    const sdk = await client(ref.account);
    const { vault, item } = await locate(sdk, ref);
    return sdk.items.get(vault, item);
  }

  return {
    capabilities: { read: true, write: mode === "desktop", list: true, metadata: true },

    async read(ref) {
      const item = await get(ref);
      return new Secret(valueField(item, ref).value);
    },

    async readItem(ref) {
      const item = await get(ref);
      return {
        secret: new Secret(valueField(item, ref).value),
        ids: { vault: item.vaultId, item: item.id },
      };
    },

    async itemIds(ref) {
      return locate(await client(ref.account), ref);
    },

    async write(ref, secret, options = {}) {
      const rotated = options.rotated;
      if (rotated !== undefined && !isDay(rotated)) {
        throw new Error(
          `${where(ref)}: rotated must be a real day as YYYY-MM-DD, got "${rotated}"`,
        );
      }
      if (mode === "service-account")
        throw new Error(`${where(ref)}: writing to 1Password needs the desktop app`);
      const sdk = await client(ref.account);
      const id = await vaultId(sdk, ref);
      const found = await find(sdk, id, ref);
      if (found && options.newItem) {
        throw new Error(`${where(ref)}: the item already exists; keypin doesn't overwrite it`);
      }

      if (!found) {
        if (ref.field !== VALUE_FIELD || ref.section !== null) {
          throw new Error(`${where(ref)}: no such item; create it in 1Password first`);
        }
        const fields = [passwordField(secret)];
        if (rotated) fields.push(rotatedField(rotated));
        await sdk.items.create({
          category: "Password",
          vaultId: id,
          title: ref.item,
          fields,
        });
        return;
      }

      const item = await sdk.items.get(id, found.id);
      await sdk.items.put(withValue(item, ref, secret, rotated));
    },

    async list(scope) {
      const sdk = await client(scope.account);
      const items = await sdk.items.list(await vaultId(sdk, scope));
      return items.map((item): VaultItem => ({
        id: item.id,
        title: item.title,
        tags: [...item.tags],
        updatedAt: new Date(item.updatedAt).toISOString(),
      }));
    },

    async metadata(ref): Promise<VaultMetadata> {
      const item = await get(ref);
      const rotated = plainField(item.fields, ROTATED, ref);
      return { rotated: rotated === null ? null : toDay(rotated, ref) };
    },
  };
}

function noVault(scope: VaultScope, mode: SignInMode): string {
  const account = `1Password account "${scope.account}"`;
  if (mode === "desktop") return `${account} has no vault "${scope.vault}"`;
  if (BUILT_IN.includes(scope.vault.toLowerCase()))
    return `${account}: service accounts can't open the built-in vault "${scope.vault}"; move the item to a vault you create, update its reference in keypin.toml, and grant the service account read access to that vault`;
  return `${account}: the vault "${scope.vault}" isn't visible to this service account (it may not exist, or wasn't granted)`;
}

function where(ref: KeyRef): string {
  return `${formatReference(ref)} (1Password account ${ref.account})`;
}

function named<T extends { id: string; title: string }>(candidates: T[], name: string): T[] {
  const wanted = name.toLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.id.toLowerCase() === wanted || candidate.title.toLowerCase() === wanted,
  );
}

function valueField(item: FullItem, ref: KeyRef): Field {
  const sections = ref.section === null ? [] : named(item.sections, ref.section);
  if (ref.section !== null && !sections.length) {
    throw new Error(`${where(ref)}: the item has no section "${ref.section}"`);
  }
  const [field, ...more] = named(
    item.fields.filter(
      (field) => ref.section === null || sections.some((section) => section.id === field.sectionId),
    ),
    ref.field,
  );
  if (!field) throw new Error(`${where(ref)}: the item has no field "${ref.field}"`);
  if (more.length) {
    throw new Error(
      `${where(ref)}: ${more.length + 1} fields are named "${ref.field}"; name a section`,
    );
  }
  if (field.title === ROTATED) {
    throw new Error(
      `${where(ref)}: "${ROTATED}" holds the day the value last changed; put the value in another field`,
    );
  }
  return field;
}

function withValue(
  item: FullItem,
  ref: KeyRef,
  secret: Secret,
  rotated: string | undefined,
): FullItem {
  const fields = [...item.fields];
  const value = valueField(item, ref);
  fields[fields.indexOf(value)] = { ...value, value: secret.reveal() };
  if (rotated) {
    const existing = fields.find((field) => field.title === ROTATED);
    if (existing)
      fields[fields.indexOf(existing)] = { ...existing, ...rotatedField(rotated), id: existing.id };
    else fields.push(rotatedField(rotated));
  }
  return { ...item, fields };
}

function passwordField(secret: Secret): Field {
  return {
    id: VALUE_FIELD,
    title: VALUE_FIELD,
    fieldType: "Concealed",
    value: secret.reveal(),
  };
}

function rotatedField(day: string): Field {
  return { id: ROTATED, title: ROTATED, fieldType: "Date", value: day };
}

function plainField(fields: Field[], title: string, ref: KeyRef): string | null {
  const field = fields.find((candidate) => candidate.title === title);
  if (!field) return null;
  if (field.fieldType !== "Text" && field.fieldType !== "Date") {
    throw new Error(`${where(ref)}: field "${title}" is ${field.fieldType}, expected Text or Date`);
  }
  return field.value === "" ? null : field.value;
}

function toDay(value: string, ref: KeyRef): string {
  if (DAY.test(value)) return value;
  if (UNIX_SECONDS.test(value)) {
    const date = new Date(Number(value) * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  throw new Error(`${where(ref)}: "${ROTATED}" isn't a date: "${value}"`);
}

const SDK_ERROR = /Error \{ msg: (.+?), inner: .*\}\s*$/s;

function signInMessage(error: unknown, mode: SignInMode): string {
  const message = messageOf(error);
  const inner = SDK_ERROR.exec(message)?.[1] ?? message;
  return mode === "desktop" && inner === "Account not found"
    ? "the 1Password app has no account with this sign-in address or ID"
    : inner;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
