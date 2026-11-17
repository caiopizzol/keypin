import { type Prerequisite, type SignInReason, sentence, type VaultKind } from "@keypin/core";
import {
  account,
  decode,
  format,
  type OnePasswordRef,
  type OnePasswordReference,
  parse,
  readPin,
  SCHEME,
  sameName,
} from "./reference";
import { isSharedAddress, pinKind, pinnedAddress } from "./service-account";

export type SignIn =
  | { mode: "desktop"; tokenIgnored: boolean }
  | { mode: "service-account"; address: string };

export interface OnePasswordHost {
  signIn: SignIn | null;
}

const MAP_FILE = "keypin.toml";
const INTEGRATION =
  "the 1Password desktop app, with Settings → Developer → Integrate with other apps selected";
const INSTALL_FIX = "install the 1Password desktop app";
const PACKAGE_FIX = "install the 1Password desktop app from the .deb or .rpm package";
const SERVICE_ACCOUNT_FIX =
  "on a server or in CI, use a 1Password service account instead (docs/service-account.md)";
const ACCOUNT_FIX = `set account under [1password] in ${MAP_FILE} to a sign-in address or account ID the 1Password app lists, under Settings → Accounts`;
const SIGN_IN = "Sign in to 1Password";

function failed(title: string, fixes: string[], body = fixes.map(sentence)): Prerequisite {
  return {
    name: "1Password",
    status: "sign-in failed",
    fix: fixes.join("; "),
    title,
    body,
    coversFailures: true,
  };
}

function tokenFixes(failures: readonly SignInReason[], address: string): string[] {
  const fixes: string[] = [];
  if (failures.some((reason) => reason.kind === "wrong-account"))
    fixes.push(
      `use a service account token for the account ${MAP_FILE} pins; OP_SERVICE_ACCOUNT_TOKEN signs in to ${address}`,
    );
  if (failures.some((reason) => reason.kind !== "wrong-account"))
    fixes.push(
      "check that OP_SERVICE_ACCOUNT_TOKEN holds a current service account token; a revoked or expired token can't sign in",
    );
  return fixes;
}

export const onePasswordVault: VaultKind<
  OnePasswordHost,
  OnePasswordRef,
  OnePasswordReference,
  string
> = {
  kind: "1password",
  name: "1Password",
  scheme: SCHEME,
  placeholder:
    "the field's secret reference (in 1Password, open the field's menu and select Copy Secret Reference)",
  needsPin: `needs your 1Password account: add [1password] with account = "..."`,
  readPin,
  parse,
  pinned: (reference, pinned) => ({ ...reference, account: pinned }),
  format,
  account,
  accounts: (refs) => [
    `1Password account ${[...new Set(refs.map((ref) => ref.account))].join(", ")}`,
  ],
  sameItem: (a, b) => sameName(a.vault, b.vault) && sameName(a.item, b.item),
  sameField: (a, b) => sameName(a.section, b.section) && sameName(a.field, b.field),
  stored: decode,
  signInVariables: ["OP_SERVICE_ACCOUNT_TOKEN", "KEYPIN_1PASSWORD"],
  newValueByHand: "Put a new value in the 1Password item and set rotated to today",
  addRotatedDate:
    "Add a rotated Date field to the 1Password item, with the day the value last changed.",
  newKeys: {
    reference: "<vault>/<item>/<field>",
    pin: { account: "<1Password sign-in address>" },
    options: "--vault <vault>",
  },
  signInNotes: ({ signIn }) =>
    signIn?.mode === "desktop" && signIn.tokenIgnored
      ? [
          "OP_SERVICE_ACCOUNT_TOKEN is set, but keypin signed in with the 1Password desktop app; set KEYPIN_1PASSWORD=service-account to use the service account",
        ]
      : [],
  itemNotes(refs, { signIn }) {
    if (signIn?.mode !== "service-account") return [];
    const limit = "the vaults granted to the service account are what limit it";
    const accounts = refs.flatMap((ref) => decode(ref)?.account ?? []);
    return [...new Set(accounts)].flatMap((account) => {
      const pinned = pinKind(account);
      if (pinned !== "address")
        return [
          `${MAP_FILE} pins the ${pinned} ${account}, which a service account token can't be checked against, so ${limit}`,
        ];
      if (isSharedAddress(pinnedAddress(account)) && isSharedAddress(signIn.address))
        return [
          `individual 1Password accounts share the sign-in address ${signIn.address}, so keypin can't prove the service account belongs to the account ${MAP_FILE} pins; ${limit}`,
        ];
      return [];
    });
  },
  prerequisites({ items, allItems, failures }, { signIn }) {
    if (signIn === null || (allItems && !items)) return [];
    if (signIn.mode === "service-account") {
      const fixes = tokenFixes(failures, signIn.address);
      return fixes.length ? [failed("Sign in to 1Password with the service account", fixes)] : [];
    }
    if (!items)
      return [
        {
          name: "1Password",
          status: "not checked",
          fix: `keypin needs ${INTEGRATION}`,
          title: "Set up 1Password",
          body: [`keypin needs ${INTEGRATION}.`],
          coversFailures: false,
        },
      ];
    if (failures.some((reason) => reason.kind === "unknown-account"))
      return [failed(SIGN_IN, [ACCOUNT_FIX])];
    if (failures.some((reason) => reason.kind === "sandboxed-desktop-app"))
      return [failed(SIGN_IN, [PACKAGE_FIX, SERVICE_ACCOUNT_FIX])];
    if (failures.some((reason) => reason.kind === "no-desktop-app"))
      return [failed(SIGN_IN, [INSTALL_FIX, SERVICE_ACCOUNT_FIX])];
    if (failures.length)
      return [
        failed(
          SIGN_IN,
          [`check ${INTEGRATION}, and that it's unlocked`],
          [`Check ${INTEGRATION}, and that it's unlocked.`],
        ),
      ];
    return [];
  },
};
