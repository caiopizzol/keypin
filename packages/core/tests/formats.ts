import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyState,
  readSecretspec,
  recordIssued,
  recordReceipt,
  register,
  rotationFile,
  rotationRecord,
  saveState,
  statusFile,
  writeRotationFile,
  writeStatusFile,
} from "../src/index";
import { day } from "../src/testing/day";
import { fakeFiles, ISSUERS, KINDS, receipt, VAULT_KINDS } from "./fixtures";

export const FORMATS = ["state", "registry", "rotation", "status"] as const;
export type Format = (typeof FORMATS)[number];

export const formatPath = (format: Format) =>
  join(import.meta.dirname, "formats", `${format}.json`);

const FILE = "/work/mailer/secretspec.toml";
const KEY = "MAIL_KEY";
const MAP = `
[project]
name = "mailer"
revision = "1.0"

[providers]
vault = "onepassword://my.1password.com@Private"

[defaults]
providers = ["vault"]

[profiles.prod]
${KEY} = { description = "${KEY}", ref = { item = "mail key", field = "credential" } }

[tool.keypin.prod.${KEY}]
rotate_every = "90d"
publish = [{ to = "github-actions", repo = "acme/mailer" }]
issuer = { kind = "resend", admin = "op://Private/resend admin key/credential", permission = "sending_access" }
`;

export async function written(): Promise<Record<Format, string>> {
  const parsed = readSecretspec(MAP, FILE, KINDS, ISSUERS, VAULT_KINDS);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  const { map } = parsed;
  const ref = map.keys[0]?.environments.prod?.ref;
  if (!ref) throw new Error(`${KEY} has no prod ref`);
  const owner = { keyId: KEY, environment: "prod", mapFile: FILE };
  const generation = "aaaaaaaaaaaaaaaa";
  let state = recordIssued(emptyState(), {
    ...owner,
    issuer: "resend",
    id: "re-new-1",
    generation,
    at: "2026-11-09T12:00:00.000Z",
    old: { id: "re-old-1", generation: "bbbbbbbbbbbbbbbb", revoked: false },
    held: true,
    unsaved: true,
  });
  state = recordReceipt(
    state,
    receipt(`github-actions:acme/mailer:${KEY}`, generation, {
      ...owner,
      source: ref,
      sourceIds: { vault: "vault-id-1", item: "item-id-1" },
      account: { pinned: "acme", publisher: "me@example.com", destinationAccount: "acme" },
      at: "2026-11-09T12:00:01.000Z",
      evidence: {},
    }),
    KINDS,
  );
  const rotation = await rotationFile(state, map, KINDS, null);
  const status = statusFile(
    [
      {
        project: "/work/mailer",
        ...owner,
        ref,
        rotated: day("2026-11-09"),
        rotateEvery: "90d",
        due: day("2027-02-07"),
        issuer: "resend",
        destinations: [],
      },
    ],
    map.environments,
    day("2026-11-09"),
    (keyId, environment) => rotationRecord(rotation, map, KINDS, keyId, environment),
  );
  const disk = fakeFiles();
  await saveState(disk.files, "state", state);
  await register(disk.files, "registry", "/work/mailer");
  await writeRotationFile(disk.files, "rotation", rotation);
  await writeStatusFile(disk.files, "status", status);
  const text = (format: Format) => disk.contents.get(format) ?? "";
  return {
    state: text("state"),
    registry: text("registry"),
    rotation: text("rotation"),
    status: text("status"),
  };
}

if (import.meta.main) {
  const files = await written();
  for (const format of FORMATS) writeFileSync(formatPath(format), files[format]);
}
