import type { KeyRef, VaultBackend, VaultItem, VaultMetadata, VaultScope } from "@keypin/core";
import { isDay, Secret } from "@keypin/core";
import type { Connect, Field, FullItem, SdkClient } from "./sdk";
import { desktopConnect } from "./sdk";

const VALUE_FIELD = "password";
const ROTATED = "rotated";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UNIX_SECONDS = /^\d+$/;

export function onePasswordBackend(connect: Connect = desktopConnect): VaultBackend {
  const clients = new Map<string, Promise<SdkClient>>();

  function client(account: string): Promise<SdkClient> {
    let pending = clients.get(account);
    if (!pending) {
      pending = connect(account).catch((error: unknown) => {
        clients.delete(account);
        throw new Error(`1Password account "${account}": sign-in failed: ${messageOf(error)}`);
      });
      clients.set(account, pending);
    }
    return pending;
  }

  async function vaultId(sdk: SdkClient, scope: VaultScope): Promise<string> {
    const matches = (await sdk.vaults.list()).filter((vault) => vault.title === scope.vault);
    const [match] = matches;
    if (!match) {
      throw new Error(`1Password account "${scope.account}" has no vault "${scope.vault}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `1Password account "${scope.account}" has ${matches.length} vaults named "${scope.vault}"`,
      );
    }
    return match.id;
  }

  async function find(sdk: SdkClient, id: string, ref: KeyRef): Promise<{ id: string } | null> {
    const matches = (await sdk.items.list(id)).filter((item) => item.title === ref.item);
    if (matches.length > 1)
      throw new Error(`${where(ref)}: ${matches.length} items have this name`);
    return matches[0] ?? null;
  }

  async function get(ref: KeyRef): Promise<FullItem> {
    const sdk = await client(ref.account);
    const id = await vaultId(sdk, ref);
    const found = await find(sdk, id, ref);
    if (!found) throw new Error(`${where(ref)}: no such item`);
    return sdk.items.get(id, found.id);
  }

  return {
    capabilities: { read: true, write: true, list: true, metadata: true },

    async read(ref) {
      const item = await get(ref);
      const field = valueField(item.fields);
      if (!field) throw new Error(`${where(ref)}: no "${VALUE_FIELD}" field`);
      return new Secret(field.value);
    },

    async write(ref, secret, options = {}) {
      const rotated = options.rotated;
      if (rotated !== undefined && !isDay(rotated)) {
        throw new Error(
          `${where(ref)}: rotated must be a real day as YYYY-MM-DD, got "${rotated}"`,
        );
      }
      const sdk = await client(ref.account);
      const id = await vaultId(sdk, ref);
      const found = await find(sdk, id, ref);

      if (!found) {
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
      const fields = [...item.fields];
      const value = valueField(fields);
      if (value) fields[fields.indexOf(value)] = { ...value, value: secret.reveal() };
      else fields.push(passwordField(secret));
      if (rotated) {
        const existing = fields.find((field) => field.title === ROTATED);
        if (existing)
          fields[fields.indexOf(existing)] = {
            ...existing,
            ...rotatedField(rotated),
            id: existing.id,
          };
        else fields.push(rotatedField(rotated));
      }
      await sdk.items.put({ ...item, fields });
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

function where(ref: KeyRef): string {
  return `1Password ${ref.account} / ${ref.vault} / ${ref.item}`;
}

function valueField(fields: Field[]): Field | undefined {
  return (
    fields.find((field) => field.id === VALUE_FIELD) ??
    fields.find((field) => field.title === VALUE_FIELD)
  );
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
