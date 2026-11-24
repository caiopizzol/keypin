import {
  account,
  accountName,
  named,
  type OnePasswordRef,
  type OnePasswordScope,
} from "./reference";
import { type ListedVault } from "./sdk";

export type SignInMode = "desktop" | "service-account";

const BUILT_IN = ["private", "personal", "employee"];
const DEFAULT_SHARED = "shared";
const MOVE =
  "move the item to a vault you create, update its vault in secretspec.toml, and grant the service account read access to that vault";

export function noVault(scope: OnePasswordScope, mode: SignInMode): string {
  const where = accountName(scope.account);
  if (mode === "desktop") return `${where} has no vault "${scope.vault}"`;
  if (BUILT_IN.includes(scope.vault.toLowerCase()))
    return `${where}: service accounts can't open the built-in vault "${scope.vault}"; ${MOVE}`;
  if (scope.vault.toLowerCase() === DEFAULT_SHARED)
    return `${where}: the vault "${scope.vault}" isn't visible to this service account. If it's the default Shared vault, service accounts can't open it; ${MOVE}. If you created it, the service account wasn't granted it`;
  return `${where}: the vault "${scope.vault}" isn't visible to this service account (it may not exist, or wasn't granted)`;
}

export async function sharedVaultNotes(
  refs: readonly OnePasswordRef[],
  listed: (account: string) => Promise<ListedVault[] | null>,
): Promise<string[]> {
  const found = new Map<string, { vault: ListedVault; ref: OnePasswordRef }>();
  for (const ref of refs) {
    const [vault, ...more] = named((await listed(ref.account)) ?? [], ref.vault);
    if (!vault || more.length || vault.vaultType !== "everyone") continue;
    found.set(JSON.stringify([ref.account, vault.id]), { vault, ref });
  }
  return [...found.values()].map(
    ({ vault, ref }) =>
      `1Password vault "${vault.title}" (${account(ref)}) is the account's default Shared vault. A service account can't be granted it, so scheduled rotation can't read the keys there; move them to a vault you create (docs/guides/service-accounts.md)`,
  );
}
