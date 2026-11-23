import {
  formatReference,
  type KeyRef,
  messageOf,
  type Prerequisite,
  type PublishTarget,
  SignInFailed,
} from "@keypin/core";
import { type Deps } from "../../deps";
import { MAP_FILE } from "../../project";
import { type ScanResult } from "../../scan";
import { type SignIn } from "../../sign-in";
import { type CheckedItem, type DestinationResult, type Login } from "./report";
import { type Step, ORDER } from "./steps";

export async function prerequisites(
  root: string,
  scanned: ScanResult,
  targets: readonly PublishTarget[],
  items: Map<string, CheckedItem>,
  kinds: Map<string, KeyRef["kind"]>,
  signIn: SignIn | null,
  deps: Deps,
): Promise<(Login & { step: Step })[]> {
  const list: (Login & { step: Step })[] = [];
  const add = (provider: string, found: readonly Prerequisite[]) => {
    for (const { name, status, fix, title, body, coversFailures } of found)
      list.push({
        name,
        status,
        fix,
        step: {
          order: ORDER.setup,
          title,
          body: [...body],
          covers: [],
          provider,
          coversFailures,
        },
      });
  };
  for (const kind of deps.destinations)
    if (kind.prerequisites)
      add(
        kind.kind,
        await kind.prerequisites(
          {
            folder: root,
            used: scanned.used.get(kind.kind) ?? false,
            targets: targets.filter((t) => t.to === kind.kind),
          },
          deps,
        ),
      );
  for (const vault of deps.vaults) {
    const own = [...items].filter(([key]) => kinds.get(key) === vault.kind);
    const failures = own.flatMap(([, item]) => (item.signIn ? [item.signIn] : []));
    const use = { items: own.length, allItems: items.size, failures };
    if (vault.prerequisites) add(vault.kind, vault.prerequisites(use, { signIn, env: deps.env }));
  }
  return list;
}

export function loginLine(result: DestinationResult): string {
  const signedIn = result.publisher === null ? "" : `, signed in as ${result.publisher}`;
  const reaches =
    result.reached === null || result.reached === result.pinned
      ? ""
      : `, and it reaches ${result.reached}`;
  return `${MAP_FILE} names ${result.pinned}; the login is ${result.login}${signedIn}${reaches}.`;
}

export async function checkItem(ref: KeyRef, deps: Deps): Promise<CheckedItem> {
  const reference = formatReference(ref, deps.vaults);
  try {
    await deps.vault().itemIds(ref);
    return { reference, ok: true, problem: null, signIn: null };
  } catch (error) {
    const signIn = error instanceof SignInFailed ? error.reason : null;
    return { reference, ok: false, problem: messageOf(error), signIn };
  }
}

export async function checkDestination(
  place: string,
  target: PublishTarget,
  login: string,
  publisher: Parameters<Deps["destination"]>[1],
  deps: Deps,
): Promise<DestinationResult> {
  const base = { destination: place, to: target.to, login, pinned: target.account };
  try {
    const result = await deps.destination(target, publisher).checkAccount();
    return {
      ...base,
      publisher: result.publisher,
      reached: result.destinationAccount,
      ok: result.ok,
      problem: result.ok ? null : result.reason,
      fix: result.ok ? null : (result.fix ?? null),
    };
  } catch (error) {
    return {
      ...base,
      publisher: null,
      reached: null,
      ok: false,
      problem: messageOf(error),
      fix: null,
    };
  }
}
