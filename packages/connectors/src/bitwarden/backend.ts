import {
  type Day,
  type Fetch,
  isRecord,
  type KeyRef,
  parseDay,
  parseObject,
  Secret,
  SignInFailed,
  type VaultBackend,
  type VaultItem,
  type VaultScope,
  WriteRefused,
} from "@keypin/core";
import { ACCESS_TOKEN, type AccessToken, NO_CREDENTIALS } from "./access-token";
import { decrypt, decryptBytes, encrypt, type Key, keyFrom } from "./crypto";
import {
  account,
  type BitwardenPin as Place,
  type BitwardenRef,
  type BitwardenScope as Scope,
  decode,
  decodeScope,
  describe as describeRef,
  endpoints,
  UUID,
} from "./reference";

const ROTATED = /^rotated:[ \t]*(.*?)[ \t]*$/m;
const DEVICE_SDK = "21";
const LONGEST_WAIT_SECONDS = 60;

type Json = Record<string, unknown>;

interface Session {
  token: string;
  key: Key;
  projects: Promise<Map<string, string[]>> | null;
  secrets: Map<string, Promise<Found[]>>;
}

class SecretMoved extends Error {}

interface Found {
  id: string;
  project: string;
  name: string;
  revised: string;
}

interface Full extends Found {
  sealed: unknown;
  note: string;
  write: boolean;
}

export function bitwardenBackend(
  token: AccessToken | string | null,
  fetch: Fetch = globalThis.fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms)),
): VaultBackend {
  const sessions = new Map<string, Promise<Session>>();

  async function request(
    place: Place,
    method: string,
    url: string,
    options: { token?: string; body?: Json; form?: Record<string, string>; signIn?: boolean } = {},
  ): Promise<{ status: number; body: Json }> {
    const send = () =>
      fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "Device-Type": DEVICE_SDK,
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
          ...(options.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        ...(options.form ? { body: String(new URLSearchParams(options.form)) } : {}),
      });
    let response = await send();
    const wait = Number(response.headers.get("Retry-After"));
    if (response.status === 429 && wait > 0 && wait <= LONGEST_WAIT_SECONDS) {
      await response.text();
      await sleep(wait * 1000);
      response = await send();
    }
    const body = parseObject(await response.text());
    if (response.status === 429) {
      const why = `Bitwarden is limiting how often keypin can ask (HTTP 429); wait, then run the command again`;
      throw options.signIn
        ? new SignInFailed(`${account(place)}: sign-in failed: ${why}`, { kind: "other" })
        : new Error(`${account(place)}: ${why}`);
    }
    return { status: response.status, body };
  }

  async function signIn(place: Place): Promise<Session> {
    const where = account(place);
    const fail = (why: string, reason: { kind: "other" } | { kind: "no-credentials" }) =>
      new SignInFailed(`${where}: sign-in failed: ${why}`, reason);
    if (token === null) throw fail(NO_CREDENTIALS, { kind: "no-credentials" });
    if (typeof token === "string") throw fail(token, { kind: "other" });
    const login = await request(place, "POST", `${endpoints(place.url).identity}/connect/token`, {
      form: {
        scope: "api.secrets",
        client_id: token.id,
        client_secret: token.secret,
        grant_type: "client_credentials",
      },
      signIn: true,
    });
    if (login.status === 400 && login.body.error === "invalid_client")
      throw fail(
        `Bitwarden refused the access token in ${ACCESS_TOKEN}; it may be revoked or expired, or belong to another server than the url under [bitwarden] in keypin.toml`,
        { kind: "other" },
      );
    const { access_token: bearer, encrypted_payload: payload } = login.body;
    if (login.status !== 200 || typeof bearer !== "string" || typeof payload !== "string")
      throw fail(
        `${problem(login)}; check that the url under [bitwarden] in keypin.toml is your Bitwarden server`,
        { kind: "other" },
      );
    const key = organizationKey(payload, token.key);
    if (!key)
      throw fail(
        "keypin couldn't read the organization's encryption key from Bitwarden's answer; the access token may be from an older key, so make a new one",
        { kind: "other" },
      );
    const organization = claim(bearer, "organization");
    if (organization === null)
      throw fail("Bitwarden's answer names no organization; use a machine account's access token", {
        kind: "other",
      });
    if (organization.toLowerCase() !== place.organization)
      throw new SignInFailed(
        `${where}: sign-in failed: the machine account belongs to the organization ${organization}, but keypin.toml pins ${place.organization}`,
        { kind: "wrong-account", pinned: place.organization, actual: organization },
      );
    return { token: bearer, key, projects: null, secrets: new Map() };
  }

  function session(place: Place): Promise<Session> {
    const key = account(place);
    let pending = sessions.get(key);
    if (!pending) {
      pending = signIn(place);
      sessions.set(key, pending);
    }
    return pending;
  }

  async function projectsOf(place: Place, current: Session): Promise<Map<string, string[]>> {
    current.projects ??= request(
      place,
      "GET",
      `${endpoints(place.url).api}/organizations/${place.organization}/projects`,
      { token: current.token },
    ).then((found) => {
      if (found.status !== 200 || !Array.isArray(found.body.data))
        throw new Error(`${account(place)}: couldn't list the projects: ${problem(found)}`);
      const names = new Map<string, string[]>();
      for (const project of found.body.data.filter(isRecord)) {
        const { id, name } = project;
        if (typeof id !== "string") continue;
        const shown = typeof name === "string" ? decrypt(name, current.key) : null;
        if (shown === null) continue;
        names.set(shown, [...(names.get(shown) ?? []), id.toLowerCase()]);
      }
      return names;
    });
    return current.projects;
  }

  async function projectId(place: Scope, current: Session): Promise<string> {
    const projects = await projectsOf(place, current);
    const ids = [...projects.values()].flat();
    const given = place.project.toLowerCase();
    if (UUID.test(place.project) && ids.includes(given)) return given;
    const named = projects.get(place.project) ?? [];
    const [only] = named;
    if (named.length === 1 && only) return only;
    if (named.length > 1)
      throw new Error(
        `${account(place)}: ${named.length} projects are named "${place.project}"; use the project's ID instead (${named.join(", ")})`,
      );
    throw new Error(
      `${account(place)}: no project "${place.project}" that the machine account can read; add the machine account to the project, or check its name`,
    );
  }

  function secretsIn(place: Scope, current: Session, project: string): Promise<Found[]> {
    let pending = current.secrets.get(project);
    if (!pending) {
      pending = request(place, "GET", `${endpoints(place.url).api}/projects/${project}/secrets`, {
        token: current.token,
      }).then((found) => {
        if (found.status !== 200 || !Array.isArray(found.body.secrets))
          throw new Error(`${account(place)}: couldn't list ${place.project}: ${problem(found)}`);
        return found.body.secrets.filter(isRecord).flatMap((secret): Found[] => {
          const { id, key, revisionDate } = secret;
          const name = typeof key === "string" ? decrypt(key, current.key) : null;
          const revised = typeof revisionDate === "string" ? revisionDate : "";
          return typeof id === "string" && name !== null ? [{ id, project, name, revised }] : [];
        });
      });
      current.secrets.set(project, pending);
    }
    return pending;
  }

  async function located(ref: BitwardenRef): Promise<{ current: Session; secret: Found }> {
    const current = await session(ref);
    const project = await projectId(ref, current);
    const matches = (await secretsIn(ref, current, project)).filter((s) => s.name === ref.name);
    const [only] = matches;
    if (matches.length > 1)
      throw new Error(
        `${describeRef(ref)}: ${matches.length} secrets in the project are named ${ref.name}, so keypin can't tell which one to use; rename or delete the others`,
      );
    if (!only)
      throw new Error(
        `${describeRef(ref)}: no secret named ${ref.name} in the project, or the machine account can't read it`,
      );
    return { current, secret: only };
  }

  async function full(ref: BitwardenRef): Promise<{ current: Session; secret: Full }> {
    const { current, secret } = await located(ref);
    const found = await request(ref, "GET", `${endpoints(ref.url).api}/secrets/${secret.id}`, {
      token: current.token,
    });
    if (found.status !== 200) throw new Error(`${describeRef(ref)}: ${problem(found)}`);
    const { key, value: sealed, note, write, projects } = found.body;
    const name = typeof key === "string" ? decrypt(key, current.key) : null;
    const inProject =
      Array.isArray(projects) && projects.some((p) => isRecord(p) && p.id === secret.project);
    if (name !== secret.name || !inProject)
      throw new SecretMoved(
        `${describeRef(ref)}: the secret changed while keypin ran (it's now named ${name ?? "something keypin can't read"}${inProject ? "" : " in another project"}); run this again`,
      );
    const notes =
      note === null || note === undefined || note === ""
        ? ""
        : typeof note === "string"
          ? decrypt(note, current.key)
          : null;
    if (notes === null) throw new Error(undecryptable(ref));
    return { current, secret: { ...secret, sealed, note: notes, write: write === true } };
  }

  async function valueOf(ref: BitwardenRef) {
    const { current, secret } = await full(ref);
    const value = typeof secret.sealed === "string" ? decrypt(secret.sealed, current.key) : null;
    if (value === null) throw new Error(undecryptable(ref));
    if (value === "") throw new Error(`${describeRef(ref)}: the value is empty`);
    return { secret: new Secret(value), ids: idsOf(secret) };
  }

  return {
    async read(given) {
      return (await valueOf(own(given))).secret;
    },

    async readItem(given) {
      return valueOf(own(given));
    },

    async itemIds(given) {
      return idsOf((await located(own(given))).secret);
    },

    async write(given, value, options = {}) {
      const ref = own(given);
      if (options.newItem)
        throw new Error(`${describeRef(ref)}: keypin doesn't create Bitwarden secrets`);
      const { current, secret } = await full(ref).catch((error: unknown) => {
        throw error instanceof SecretMoved ? new WriteRefused(error.message) : error;
      });
      if (!secret.write) throw new WriteRefused(readOnly(ref));
      const note = withRotated(secret.note, options.rotated);
      const written = await request(ref, "PUT", `${endpoints(ref.url).api}/secrets/${secret.id}`, {
        token: current.token,
        body: {
          key: encrypt(secret.name, current.key),
          value: encrypt(value.reveal(), current.key),
          note: encrypt(note, current.key),
          projectIds: [secret.project],
          valueChanged: true,
        },
      });
      if (written.status === 200) return;
      if ([400, 401, 403, 404].includes(written.status))
        throw new WriteRefused(
          `${describeRef(ref)}: Bitwarden refused the change: ${problem(written)}`,
        );
      throw new Error(`${describeRef(ref)}: ${problem(written)}`);
    },

    async checkWrite(given) {
      const ref = own(given);
      if (!(await full(ref)).secret.write) throw new Error(readOnly(ref));
    },

    async list(given) {
      const scope = ownScope(given);
      const current = await session(scope);
      const project = await projectId(scope, current);
      return (await secretsIn(scope, current, project)).map((secret): VaultItem => ({
        id: secret.id,
        title: secret.name,
        tags: [],
        updatedAt: secret.revised,
      }));
    },

    async metadata(given) {
      const ref = own(given);
      const { secret } = await full(ref);
      const line = ROTATED.exec(secret.note);
      if (!line) return { rotated: null };
      const rotated = parseDay(line[1] ?? "");
      if (!rotated)
        throw new Error(
          `${describeRef(ref)}: the note's rotated line isn't a YYYY-MM-DD date: "${line[1] ?? ""}"`,
        );
      return { rotated };
    },
  };
}

function organizationKey(payload: string, tokenKey: Key): Key | null {
  const opened = decryptBytes(payload, tokenKey);
  if (!opened) return null;
  const { encryptionKey } = parseObject(opened.toString("utf8"));
  return typeof encryptionKey === "string" ? keyFrom(Buffer.from(encryptionKey, "base64")) : null;
}

function claim(jwt: string, name: string): string | null {
  const [, payload = ""] = jwt.split(".");
  const value = parseObject(Buffer.from(payload, "base64url").toString("utf8"))[name];
  return typeof value === "string" ? value : null;
}

function undecryptable(ref: BitwardenRef): string {
  return `${describeRef(ref)}: keypin couldn't decrypt the secret with the organization's key`;
}

function readOnly(ref: BitwardenRef): string {
  return `${describeRef(ref)}: the machine account can read this secret but not change it; give it Can read, write on the project`;
}

function withRotated(note: string, rotated: Day | undefined): string {
  if (rotated === undefined) return note;
  const line = `rotated: ${rotated}`;
  if (ROTATED.test(note)) return note.replace(ROTATED, line);
  return note.trim() === "" ? line : `${note.replace(/\s+$/, "")}\n${line}`;
}

function idsOf(secret: Found) {
  return { vault: secret.project, item: secret.id };
}

function own(ref: KeyRef): BitwardenRef {
  const mine = decode(ref);
  if (!mine)
    throw new Error(`keypin's Bitwarden vault can't read this reference, which is for ${ref.kind}`);
  return mine;
}

function ownScope(scope: VaultScope): Scope {
  const mine = decodeScope(scope);
  if (!mine) throw new Error(`keypin's Bitwarden vault can't list ${scope.kind} items`);
  return mine;
}

function problem(response: { status: number; body: Json }): string {
  const { message, error_description: description, error } = response.body;
  const text = [message, description, error].find((each) => typeof each === "string");
  return `Bitwarden returned HTTP ${response.status}${typeof text === "string" ? `: ${text}` : ""}`;
}
