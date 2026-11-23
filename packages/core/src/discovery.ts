import type { Environment } from "./contracts";
import type { PublishTarget } from "./destination";

export interface ProjectEntry {
  readonly name: string;
  readonly kind: "file" | "folder" | "other";
}

export type FolderListing =
  | { readonly ok: true; readonly entries: readonly ProjectEntry[] }
  | { readonly ok: false; readonly missing: boolean; readonly reason: string };

export type StoreRead =
  | { ok: true; secrets: { name: string; updatedAt: string | null }[] }
  | { ok: false; reason: string };

export interface ProjectReader {
  readonly root: string;
  readonly found: readonly string[];
  read(path: string): Promise<string | null>;
  list(folder: string): Promise<FolderListing>;
  unknown(what: string, reason: string): void;
}

export interface OnlyFrom {
  readonly environments: readonly Environment[];
  readonly source: string;
  readonly thing: string;
}

export interface Slot {
  readonly name: string;
  readonly detail: string;
  of(target: PublishTarget): { name: string; detail: string } | undefined;
  twice(keyName: string, taken: string): string;
}

export interface Place {
  readonly id: string;
  readonly to: PublishTarget["to"];
  readonly label: string;
  readonly verb: string;
  readonly fields: readonly (readonly [string, string])[];
  readonly onlyFrom?: OnlyFrom;
  readonly slot?: Slot;
  aside?(name: string): string;
  matches(keyName: string, name: string): boolean;
  covers(target: PublishTarget): boolean;
  holds(name: string): boolean | null;
}

export interface FoundNeed {
  readonly name: string;
  readonly place: Place;
  readonly usedBy: string;
}

export interface MapView {
  readonly publishEnvironment: Environment;
  publishes(name: string, place: Place): boolean;
  ignores(name: string): boolean;
  declares(name: string, profile: Environment): boolean;
}

export interface Needs {
  readonly needs: readonly FoundNeed[];
  readonly notes: readonly string[];
  readonly problems?: readonly string[];
  readonly notesAfter?: (found: readonly { name: string; place: string }[]) => readonly string[];
}

export interface Discovered {
  readonly files: readonly string[];
  readonly used: boolean;
  readonly about: string | null;
  readonly report: Readonly<Record<string, unknown>>;
  needs(view: MapView): Needs;
}

export interface Scanned {
  finish(): Promise<Discovered>;
}

export interface ProjectFiles {
  readonly key: string;
  readonly noun: string;
  readonly names?: readonly string[];
  readonly skip?: readonly string[];
}

export interface Discovery<H = unknown> {
  readonly files: ProjectFiles;
  scan(project: ProjectReader, host: H): Promise<Scanned>;
}
