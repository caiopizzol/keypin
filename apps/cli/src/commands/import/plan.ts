import {
  type Environment,
  formatReference,
  type KeyRef,
  messageOf,
  type Secret,
  type VaultKinds,
  vaultAccounts,
} from "@keypin/core";
import { type Deps } from "../../deps";
import { count, type Output } from "../../output";
import { approval } from "../../sign-in";

export function draftItemName(project: string, environment: Environment, name: string): string {
  const folder = project.replace(/[^A-Za-z0-9 ._-]/g, "-");
  return `${folder} ${environment} ${name.toLowerCase().replaceAll("_", " ").trim()}`;
}

type OnePasswordRef = {
  kind: "1password";
  account: string;
  vault: string;
  item: string;
  section: null;
  field: string;
};

export interface Import {
  name: string;
  ref: OnePasswordRef;
  value: Secret;
  existing: boolean;
}

export type Entry = Pick<Import, "name" | "ref" | "existing">;

export interface Skip {
  name: string;
  reason: string;
  onlyInFile: boolean;
  exists?: boolean;
  mapped?: { ref: KeyRef; value: Secret };
  mappedEmpty?: boolean;
}

export function planRows(
  imports: readonly Import[],
  stored: readonly Import[],
  skips: readonly Skip[],
  today: string,
  out: Output,
  vaults: VaultKinds,
): string[] {
  const width = Math.max(0, ...[...imports, ...stored, ...skips].map((row) => row.name.length));
  const refs = [...imports, ...stored].map((entry) => formatReference(entry.ref, vaults));
  const refWidth = Math.max(0, ...refs.map((ref) => ref.length));
  const planned = (mark: string, entry: Import, why: string) =>
    `${mark} ${entry.name.padEnd(width)}  ${formatReference(entry.ref, vaults).padEnd(refWidth)}  ${why}`;
  return [
    ...imports.map((entry) => planned("+", entry, `create, rotated ${today}`)),
    ...(imports.length ? [] : [out.dim("nothing to create")]),
    ...stored.map((entry) => planned("=", entry, "exists with the same value; map it")),
    ...skips.map((skip) => {
      const text = `- ${skip.name.padEnd(width)}  skipped: ${skip.reason}`;
      return skip.exists ? text : out.dim(text);
    }),
  ];
}

export async function compareMapped(
  deps: Deps,
  out: Output,
  skips: readonly Skip[],
): Promise<Skip[]> {
  const refs = skips.flatMap((skip) => (skip.mapped ? [skip.mapped.ref] : []));
  if (!refs.length) return [...skips];
  const values = `${count(refs.length, "mapped value")} from ${vaultAccounts(refs, deps.vaults)}, to compare with the file`;
  const { compared } = await out.step(
    `Reading ${count(refs.length, "mapped value")}`,
    () => compareEach(deps, skips),
    ({ unread }) => ({
      ok: !unread,
      text: `Read ${values}  ${out.dim(refs.map((ref) => formatReference(ref, deps.vaults)).join(", "))}`,
    }),
    approval(deps, refs),
  );
  return compared;
}

async function compareEach(
  deps: Deps,
  skips: readonly Skip[],
): Promise<{ compared: Skip[]; unread: number }> {
  const compared: Skip[] = [];
  let unread = 0;
  for (const skip of skips) {
    if (!skip.mapped) {
      compared.push(skip);
      continue;
    }
    const { ref, value } = skip.mapped;
    try {
      const same = (await deps.vault().read(ref)).equals(value);
      compared.push({
        ...skip,
        reason: `${skip.reason}, and it ${same ? "matches" : "differs from"} the vault`,
        onlyInFile: !same,
      });
    } catch (error) {
      unread++;
      compared.push({
        ...skip,
        reason: `${skip.reason}, and ${formatReference(ref, deps.vaults)} couldn't be read to compare: ${messageOf(error)}`,
        onlyInFile: true,
      });
    }
  }
  return { compared, unread };
}

export function refFor(account: string, vault: string, item: string): OnePasswordRef {
  return { kind: "1password", account, vault, item, section: null, field: "password" };
}
