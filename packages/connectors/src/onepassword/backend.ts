import type {
  ItemIds,
  KeyRef,
  VaultBackend,
  VaultItem,
  VaultMetadata,
  VaultScope,
} from "@keypin/core";
import {
  type Day,
  localDay,
  messageOf,
  parseDay,
  Secret,
  SignInFailed,
  type SignInReason,
  WriteRefused,
} from "@keypin/core";
import {
  account,
  decode,
  decodeScope,
  format,
  type OnePasswordRef,
  type OnePasswordScope,
  sameName,
} from "./reference";
import { type Connect, type Field, type FullItem, RateLimited, type SdkClient } from "./sdk";
import { desktopConnect } from "./desktop";

const VALUE_FIELD = "password";
const ROTATED = "rotated";
const NOTES = "notesPlain";

const UNIX_SECONDS = /^\d+$/;

type Listed = { id: string; title: string };
type ItemOverview = Awaited<ReturnType<SdkClient["items"]["list"]>>[number];

const BUILT_IN = ["private", "personal", "employee"];
const DEFAULT_SHARED = "shared";

export type SignInMode = "desktop" | "service-account";

export function onePasswordBackend(
  connect: Connect = desktopConnect,
  mode: SignInMode = "desktop",
  { tokenIgnored = false } = {},
): VaultBackend {
  const clients = new Map<string, Promise<SdkClient>>();
  const vaultLists = new WeakMap<SdkClient, Promise<Listed[]>>();
  const itemLists = new WeakMap<SdkClient, Map<string, Promise<ItemOverview[]>>>();

  function sdkError(error: unknown): unknown {
    if (!(error instanceof RateLimited)) return error;
    const inner = SDK_ERROR.exec(error.message)?.[1] ?? error.message;
    const limits = mode === "service-account" ? `. ${SERVICE_ACCOUNT_LIMITS}` : "";
    return new Error(`1Password's rate limit was reached: ${inner}${limits}`);
  }

  function vaults(sdk: SdkClient): Promise<Listed[]> {
    let pending = vaultLists.get(sdk);
    if (!pending) {
      pending = sdk.vaults.list().catch((error: unknown) => {
        vaultLists.delete(sdk);
        throw sdkError(error);
      });
      vaultLists.set(sdk, pending);
    }
    return pending;
  }

  function itemsIn(sdk: SdkClient): Map<string, Promise<ItemOverview[]>> {
    let lists = itemLists.get(sdk);
    if (!lists) {
      lists = new Map<string, Promise<ItemOverview[]>>();
      itemLists.set(sdk, lists);
    }
    return lists;
  }

  function items(sdk: SdkClient, vault: string): Promise<ItemOverview[]> {
    const lists = itemsIn(sdk);
    let pending = lists.get(vault);
    if (!pending) {
      pending = sdk.items.list(vault).catch((error: unknown) => {
        lists.delete(vault);
        throw sdkError(error);
      });
      lists.set(vault, pending);
    }
    return pending;
  }

  function client(account: string): Promise<SdkClient> {
    let pending = clients.get(account);
    if (!pending) {
      pending = connect(account).catch((error: unknown) => {
        throw error instanceof RateLimited
          ? sdkError(error)
          : signInFailed(account, error, mode, tokenIgnored);
      });
      clients.set(account, pending);
    }
    return pending;
  }

  async function vaultId(sdk: SdkClient, scope: OnePasswordScope): Promise<string> {
    const matches = named(await vaults(sdk), scope.vault);
    const [match] = matches;
    if (!match) throw new Error(noVault(scope, mode));
    if (matches.length > 1) {
      throw new Error(
        `1Password account "${scope.account}" has ${matches.length} vaults named "${scope.vault}"`,
      );
    }
    return match.id;
  }

  async function find(
    sdk: SdkClient,
    id: string,
    ref: OnePasswordRef,
  ): Promise<{ id: string } | null> {
    const matches = named(await items(sdk, id), ref.item);
    if (matches.length > 1)
      throw new Error(`${where(ref)}: ${matches.length} items have this name`);
    return matches[0] ?? null;
  }

  async function locate(sdk: SdkClient, ref: OnePasswordRef): Promise<ItemIds> {
    const vault = await vaultId(sdk, ref);
    const found = await find(sdk, vault, ref);
    if (!found) throw new Error(`${where(ref)}: no such item`);
    return { vault, item: found.id };
  }

  async function saving(ref: OnePasswordRef, save: () => Promise<unknown>): Promise<void> {
    try {
      await save();
    } catch (error) {
      if (error instanceof RateLimited) throw sdkError(error);
      if (mode === "service-account" && NO_PERMISSION.test(messageOf(error)))
        throw new WriteRefused(
          `${where(ref)}: the service account can't write to the vault "${ref.vault}". Grant write access to it: 1Password can't change a service account's access, so create a new service account with read and write access to that vault, and use its token`,
        );
      throw error;
    }
  }

  async function get(ref: OnePasswordRef): Promise<FullItem> {
    const sdk = await client(ref.account);
    const { vault, item } = await locate(sdk, ref);
    return byId(sdk, vault, item);
  }

  function byId(sdk: SdkClient, vault: string, item: string): Promise<FullItem> {
    return sdk.items.get(vault, item).catch((error: unknown) => {
      throw sdkError(error);
    });
  }

  return {
    async read(given) {
      const ref = own(given);
      return valueOf(await get(ref), ref);
    },

    async readItem(given) {
      const ref = own(given);
      const item = await get(ref);
      return { secret: valueOf(item, ref), ids: { vault: item.vaultId, item: item.id } };
    },

    async itemIds(given) {
      const ref = own(given);
      return locate(await client(ref.account), ref);
    },

    async write(given, secret, options = {}) {
      const ref = own(given);
      if (secret.reveal() === "")
        throw new Error(`${where(ref)}: keypin won't save an empty value`);
      const rotated = options.rotated;
      const sdk = await client(ref.account);
      const id = await vaultId(sdk, ref);
      itemsIn(sdk).delete(id);
      const found = await find(sdk, id, ref);
      if (found && options.newItem) {
        throw new Error(`${where(ref)}: the item already exists; keypin doesn't overwrite it`);
      }

      if (!found) {
        if ((ref.field !== VALUE_FIELD && ref.fallback !== VALUE_FIELD) || ref.section !== null) {
          throw new Error(`${where(ref)}: no such item; create it in 1Password first`);
        }
        const fields = [passwordField(secret)];
        if (rotated) fields.push(rotatedField(rotated));
        await saving(ref, () =>
          sdk.items.create({ category: "Password", vaultId: id, title: ref.item, fields }),
        );
        itemsIn(sdk).delete(id);
        return;
      }

      const item = await byId(sdk, id, found.id);
      await saving(ref, () => sdk.items.put(withValue(item, ref, secret, rotated)));
      itemsIn(sdk).delete(id);
    },

    async list(given) {
      const scope = ownScope(given);
      const sdk = await client(scope.account);
      const found = await items(sdk, await vaultId(sdk, scope));
      return found.map((item): VaultItem => ({
        id: item.id,
        title: item.title,
        tags: [...item.tags],
        updatedAt: new Date(item.updatedAt).toISOString(),
      }));
    },

    async metadata(given): Promise<VaultMetadata> {
      const ref = own(given);
      const item = await get(ref);
      const rotated = plainField(item.fields, ROTATED, ref);
      return { rotated: rotated === null ? null : toDay(rotated, ref) };
    },
  };
}

function noVault(scope: OnePasswordScope, mode: SignInMode): string {
  const account = `1Password account "${scope.account}"`;
  if (mode === "desktop") return `${account} has no vault "${scope.vault}"`;
  const move =
    "move the item to a vault you create, update its vault in secretspec.toml, and grant the service account read access to that vault";
  if (BUILT_IN.includes(scope.vault.toLowerCase()))
    return `${account}: service accounts can't open the built-in vault "${scope.vault}"; ${move}`;
  if (scope.vault.toLowerCase() === DEFAULT_SHARED)
    return `${account}: the vault "${scope.vault}" isn't visible to this service account. If it's the default Shared vault, service accounts can't open it; ${move}. If you created it, the service account wasn't granted it`;
  return `${account}: the vault "${scope.vault}" isn't visible to this service account (it may not exist, or wasn't granted)`;
}

function own(ref: KeyRef): OnePasswordRef {
  const mine = decode(ref);
  if (!mine)
    throw new Error(`keypin's 1Password vault can't read this reference, which is for ${ref.kind}`);
  return mine;
}

function ownScope(scope: VaultScope): OnePasswordScope {
  const mine = decodeScope(scope);
  if (!mine) throw new Error(`keypin's 1Password vault can't list ${scope.kind} secrets`);
  return mine;
}

function where(ref: OnePasswordRef): string {
  return `${format(ref)} (${account(ref)})`;
}

function named<T extends { id: string; title: string }>(candidates: T[], name: string): T[] {
  const wanted = name.toLowerCase();
  return candidates.filter(
    (candidate) =>
      candidate.id.toLowerCase() === wanted || candidate.title.toLowerCase() === wanted,
  );
}

function isNotes(item: FullItem, ref: OnePasswordRef): boolean {
  return ref.section === null && sameName(ref.field, NOTES) && !named(item.fields, NOTES).length;
}

function valueOf(item: FullItem, ref: OnePasswordRef): Secret {
  const notes = isNotes(item, ref);
  const value = notes ? item.notes : valueField(item, ref).value;
  if (value === "") throw new Error(`${where(ref)}: the value is empty`);
  return new Secret(value);
}

function valueField(item: FullItem, ref: OnePasswordRef): Field {
  const sections = ref.section === null ? [] : named(item.sections, ref.section);
  if (ref.section !== null && !sections.length) {
    throw new Error(`${where(ref)}: the item has no section "${ref.section}"`);
  }
  const inSection = item.fields.filter(
    (field) => ref.section === null || sections.some((section) => section.id === field.sectionId),
  );
  const own = named(inSection, ref.field);
  const name = own.length || ref.fallback === undefined ? ref.field : ref.fallback;
  const [field, ...more] = name === ref.field ? own : named(inSection, name);
  if (!field) throw new Error(`${where(ref)}: ${missingField(item, ref)}`);
  if (more.length) {
    throw new Error(`${where(ref)}: ${more.length + 1} fields are named "${name}"; name a section`);
  }
  if (field.fieldType === "Totp") {
    throw new Error(
      `${where(ref)}: "${ref.field}" is a one-time password, which changes every 30 seconds; keypin reads only values that stay the same`,
    );
  }
  if (field.title === ROTATED) {
    throw new Error(
      `${where(ref)}: "${ROTATED}" holds the day the value last changed; put the value in another field`,
    );
  }
  return field;
}

function missingField(item: FullItem, ref: OnePasswordRef): string {
  const files = "keypin reads text fields and notes, not files";
  if (item.files.some((file) => sameName(file.attributes.name, ref.field)))
    return `"${ref.field}" is a file attached to the item; ${files}`;
  if (item.category === "Document") return `the item is a Document; ${files}`;
  const or = ref.fallback === undefined ? "" : ` or "${ref.fallback}"`;
  return `the item has no field "${ref.field}"${or}`;
}

function withValue(
  item: FullItem,
  ref: OnePasswordRef,
  secret: Secret,
  rotated: Day | undefined,
): FullItem {
  const fields = [...item.fields];
  const notes = isNotes(item, ref);
  if (!notes) {
    const value = valueField(item, ref);
    fields[fields.indexOf(value)] = { ...value, value: secret.reveal() };
  }
  if (rotated) {
    const existing = fields.find((field) => field.title === ROTATED);
    if (existing)
      fields[fields.indexOf(existing)] = { ...existing, ...rotatedField(rotated), id: existing.id };
    else fields.push(rotatedField(rotated));
  }
  return notes ? { ...item, notes: secret.reveal(), fields } : { ...item, fields };
}

function passwordField(secret: Secret): Field {
  return {
    id: VALUE_FIELD,
    title: VALUE_FIELD,
    fieldType: "Concealed",
    value: secret.reveal(),
  };
}

function rotatedField(day: Day): Field {
  return { id: ROTATED, title: ROTATED, fieldType: "Date", value: day };
}

function plainField(fields: Field[], title: string, ref: OnePasswordRef): string | null {
  const field = fields.find((candidate) => candidate.title === title);
  if (!field) return null;
  if (field.fieldType !== "Text" && field.fieldType !== "Date") {
    throw new Error(`${where(ref)}: field "${title}" is ${field.fieldType}, expected Text or Date`);
  }
  return field.value === "" ? null : field.value;
}

function toDay(value: string, ref: OnePasswordRef): Day {
  if (UNIX_SECONDS.test(value)) return localDay(new Date(Number(value) * 1000));
  const day = parseDay(value);
  if (day) return day;
  throw new Error(`${where(ref)}: "${ROTATED}" isn't a date: "${value}"`);
}

const SERVICE_ACCOUNT_LIMITS =
  "A service account token gets 1,000 reads and 100 writes an hour (10,000 and 1,000 on Business), and an account's service accounts together 1,000 requests a day (5,000 on Teams, 50,000 on Business)";
const SDK_ERROR = /Error \{ msg: (.+?), inner: .*\}\s*$/s;
const NO_PERMISSION = /do(?:n't| not) have the right permissions/;

function signInFailed(
  account: string,
  error: unknown,
  mode: SignInMode,
  tokenIgnored: boolean,
): SignInFailed {
  const message = messageOf(error);
  const inner = SDK_ERROR.exec(message)?.[1] ?? message;
  const unknown = mode === "desktop" && inner === "Account not found";
  const why = unknown ? "the 1Password app has no account with this sign-in address or ID" : inner;
  const reason: SignInReason =
    error instanceof SignInFailed ? error.reason : { kind: unknown ? "unknown-account" : "other" };
  const hint = tokenIgnored
    ? "; OP_SERVICE_ACCOUNT_TOKEN is set, so set KEYPIN_1PASSWORD=service-account to use the service account"
    : "";
  return new SignInFailed(`1Password account "${account}": sign-in failed: ${why}${hint}`, reason);
}
