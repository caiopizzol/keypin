import { type Environment, type Gaps, type Prerequisite, type SignInReason } from "@keypin/core";
import { type ScanResult, type Unknown } from "../../scan";
import { type SignIn } from "../../sign-in";

interface ItemResult {
  reference: string;
  ok: boolean;
  problem: string | null;
}

export interface CheckedItem extends ItemResult {
  signIn: SignInReason | null;
}

export interface DestinationResult {
  destination: string;
  to: string;
  login: string;
  publisher: string | null;
  pinned: string;
  reached: string | null;
  ok: boolean;
  problem: string | null;
  fix: string | null;
}

interface KeyResult {
  key: string;
  environment: Environment;
  from: ItemResult;
  destinations: DestinationResult[];
}

export type Login = Pick<Prerequisite, "name" | "status" | "fix">;

export interface Report {
  folder: string;
  map: string | null;
  registered: boolean;
  read: ScanResult["files"] & { notScanned: string[] };
  [discovered: string]: unknown;
  onePassword: { signIn: SignIn["mode"]; address: string | null } | null;
  keys: KeyResult[];
  production: Gaps["production"];
  local: Gaps["local"];
  add: string | null;
  unknown: Unknown[];
  prerequisites: Login[];
  notes: string[];
  problems: string[];
  ok: boolean;
}

export const ITEM_NOTE =
  "items are looked up in each vault's item list, which holds no values, so no field is checked; keypin run and keypin publish --plan read the fields";
