import { createHash } from "node:crypto";
import { type Fetch, isRecord } from "@keypin/core";
import { accessTokenKey, decrypt, encrypt, encryptBytes, keyBytes, keyFrom } from "./crypto";

const TOKEN_ID = "6c1a2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TOKEN_SECRET = "fake-machine-account-secret-7d2e";
const TOKEN_SEED = Buffer.from("keypin-fake-seed").toString("base64");
const BEARER_SIGNATURE = "fake-signature";

export const FAKE_ACCESS_TOKEN = `0.${TOKEN_ID}.${TOKEN_SECRET}:${TOKEN_SEED}`;

export interface FakeSecret {
  name: string;
  value: string;
  note?: string;
  id?: string;
}

export interface FakeProject {
  id?: string;
  name?: string;
  secrets: FakeSecret[];
  readOnly?: boolean;
}

export interface FakeBitwarden {
  organization: string;
  projects: Record<string, FakeProject>;
  refuseLogin?: boolean;
  failWrites?: boolean;
  rateLimited?: { times: number; retryAfter?: number };
}

export interface Stored {
  id: string;
  project: string;
  name: string;
  value: string;
  note: string;
}

export interface Store {
  load(): Stored[];
  save(entry: Stored): void;
  effect(line: string): void;
}

const uuidOf = (text: string) => {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

export function bitwardenFetch(fake: FakeBitwarden, store: Store): Fetch {
  const organizationKey = keyFrom(createHash("sha512").update(fake.organization).digest());
  const tokenKey = accessTokenKey(Buffer.from(TOKEN_SEED, "base64"));
  if (!organizationKey || !tokenKey) throw new Error("the fake Bitwarden can't make its keys");
  const seal = (text: string) => encrypt(text, organizationKey);
  const reply = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  const claims = Buffer.from(JSON.stringify({ organization: fake.organization })).toString(
    "base64url",
  );
  const bearer = `e30.${claims}.${BEARER_SIGNATURE}`;
  const projects = () =>
    Object.entries(fake.projects).map(([key, project]) => ({
      key,
      name: project.name ?? key,
      id: project.id ?? uuidOf(`project ${key}`),
      project,
    }));
  const secrets = () =>
    projects().flatMap(({ key, id, project }) =>
      project.secrets.map((secret, index): Stored & { readOnly: boolean } => {
        const own = secret.id ?? uuidOf(`secret ${key}/${index}`);
        const saved = store.load().find((entry) => entry.id === own);
        return {
          id: own,
          project: id,
          name: saved?.name ?? secret.name,
          value: saved?.value ?? secret.value,
          note: saved?.note ?? secret.note ?? "",
          readOnly: project.readOnly === true,
        };
      }),
    );
  const projectName = (id: string) => projects().find((p) => p.id === id)?.name ?? id;
  const shape = (secret: Stored & { readOnly: boolean }, full: boolean) => ({
    id: secret.id,
    organizationId: fake.organization,
    key: seal(secret.name),
    ...(full
      ? {
          value: seal(secret.value),
          note: seal(secret.note),
          projects: [{ id: secret.project, name: projectName(secret.project) }],
        }
      : {}),
    revisionDate: "2026-01-01T00:00:00Z",
    read: true,
    write: !secret.readOnly,
  });

  return async (url, init) => {
    const { pathname } = new URL(url);
    if (fake.rateLimited && fake.rateLimited.times > 0) {
      fake.rateLimited.times--;
      const wait = fake.rateLimited.retryAfter;
      return new Response("", {
        status: 429,
        headers: wait === undefined ? {} : { "Retry-After": String(wait) },
      });
    }
    if (pathname.endsWith("/connect/token")) {
      const form = new URLSearchParams(init.body ?? "");
      if (
        fake.refuseLogin ||
        form.get("client_id") !== TOKEN_ID ||
        form.get("client_secret") !== TOKEN_SECRET
      )
        return reply(400, { error: "invalid_client" });
      const payload = JSON.stringify({
        encryptionKey: keyBytes(organizationKey).toString("base64"),
      });
      return reply(200, {
        access_token: bearer,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "api.secrets",
        encrypted_payload: encryptBytes(Buffer.from(payload), tokenKey),
      });
    }
    if (init.headers.Authorization !== `Bearer ${bearer}`) return reply(401, {});
    const route = pathname.replace(/^\/api(?=\/)/, "");
    if (route === `/organizations/${fake.organization}/projects`)
      return reply(200, {
        data: projects().map(({ name, id }) => ({
          id,
          organizationId: fake.organization,
          name: seal(name),
        })),
      });
    const listed = /^\/projects\/([^/]+)\/secrets$/.exec(route)?.[1];
    if (listed !== undefined) {
      if (!projects().some((project) => project.id === listed)) return reply(404, {});
      return reply(200, {
        secrets: secrets()
          .filter((secret) => secret.project === listed)
          .map((secret) => shape(secret, false)),
      });
    }
    const id = /^\/secrets\/([^/]+)$/.exec(route)?.[1];
    const found = secrets().find((secret) => secret.id === id);
    if (!found) return reply(404, { message: "Resource not found." });
    if (init.method === "GET") return reply(200, shape(found, true));
    if (found.readOnly) return reply(404, { message: "Resource not found." });
    if (fake.failWrites) return reply(500, { message: "internal error" });
    const sent: unknown = JSON.parse(init.body ?? "{}");
    const body = isRecord(sent) ? sent : {};
    const open = (field: string) => {
      const sealed = body[field];
      return typeof sealed === "string" ? decrypt(sealed, organizationKey) : null;
    };
    const [name, value, note] = [open("key"), open("value"), open("note")];
    if (name === null || value === null || note === null)
      return reply(400, { message: "The field could not be decrypted." });
    const saved = { id: found.id, project: found.project, name, value, note };
    store.save(saved);
    store.effect(`bitwarden update ${found.name}`);
    return reply(200, shape({ ...saved, readOnly: false }, true));
  };
}

export function memoryStore() {
  const saved: Stored[] = [];
  const effects: string[] = [];
  return {
    load: () => saved,
    save: (entry: Stored) => {
      const at = saved.findIndex((s) => s.id === entry.id);
      if (at === -1) saved.push(entry);
      else saved[at] = entry;
    },
    effect: (line: string) => void effects.push(line),
    effects,
  };
}

export function fileStore(
  read: () => string | null,
  write: (text: string) => void,
  effect: (line: string) => void,
): Store {
  const load = (): Stored[] => {
    try {
      const parsed: unknown = JSON.parse(read() ?? "[]");
      return Array.isArray(parsed) ? parsed.filter(isStored) : [];
    } catch {
      return [];
    }
  };
  return {
    load,
    save: (entry) => write(JSON.stringify([...load().filter((s) => s.id !== entry.id), entry])),
    effect,
  };
}

function isStored(entry: unknown): entry is Stored {
  return (
    isRecord(entry) &&
    typeof entry.id === "string" &&
    typeof entry.project === "string" &&
    typeof entry.name === "string" &&
    typeof entry.value === "string" &&
    typeof entry.note === "string"
  );
}
