import type { Environment } from "../contracts";
import type { PublishTarget } from "../destination";
import type { Discovered } from "../discovery";
import type { EnvFileKind } from "../dotenv";

export interface ProjectScan {
  envFiles: { path: string; kind: EnvFileKind; names: string[]; tracked: boolean | null }[];
  discovered: readonly Discovered[];
}

export interface Need {
  name: string;
  to: PublishTarget["to"];
  place: string;
  usedBy: string[];
  mapped: Environment | null;
  holds: boolean | null;
  ok: boolean;
}

export interface LocalFile {
  file: string;
  tracked: boolean | null;
  unmapped: string[];
  elsewhere: string[];
}

export type Fix =
  | { kind: "environments"; text: string; why: string; at: string; line: string }
  | { kind: "tracked"; text: string; file: string }
  | {
      kind: "import";
      text: string;
      why: string;
      vault: string;
      file: string;
      names: string[];
      options: string;
      caveat: string | null;
    }
  | { kind: "add"; text: string; why: string; key: string }
  | { kind: "edit"; text: string }
  | { kind: "publish"; text: string; key: string; why: string; command: string };

export interface Gaps {
  production: Need[];
  local: LocalFile[];
  add: string | null;
  addsPin: boolean;
  problems: string[];
  notes: string[];
  fixes: Fix[];
}
