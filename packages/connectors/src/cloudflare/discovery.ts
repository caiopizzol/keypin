import {
  type Discovery,
  type Environment,
  type FoundNeed,
  isEnvironmentName,
  messageOf,
  type Place,
  type StoreRead,
} from "@keypin/core";
import { WRANGLER_FILES, type WorkerDeclaration, wranglerWorkers } from "./wrangler";

export interface WranglerHost {
  workerSecrets(folder: string, account: string, worker: string): Promise<StoreRead>;
}

type Worker = WorkerDeclaration & { read: StoreRead | null };

const ACCOUNT_PLACEHOLDER = "<Cloudflare account ID>";
const WORKER_PLACEHOLDER = "<Worker name>";

export const wranglerDiscovery: Discovery<WranglerHost> = {
  files: { key: "wrangler", noun: "wrangler config", names: WRANGLER_FILES, skip: [".wrangler"] },
  async scan(project, host) {
    const workers: Worker[] = [];
    for (const config of project.found) {
      const text = await project.read(config);
      if (text === null) continue;
      const parsed = wranglerWorkers(text, config);
      if (!parsed.ok) {
        project.unknown(`the Workers in ${config}`, "it couldn't be parsed");
        continue;
      }
      for (const worker of parsed.workers) {
        const label = `the secrets of the Worker ${worker.worker ?? `in ${config}`}`;
        let read: StoreRead | null = null;
        if (worker.required?.length) {
          if (!worker.worker) project.unknown(label, `${config} names no Worker`);
          else if (!worker.account)
            project.unknown(
              label,
              `${config} has no account_id, and check doesn't guess an account`,
            );
          else {
            read = await host
              .workerSecrets(project.root, worker.account, worker.worker)
              .catch((error: unknown) => ({ ok: false as const, reason: messageOf(error) }));
            if (!read.ok) project.unknown(label, read.reason);
          }
        }
        workers.push({ ...worker, read });
      }
    }
    const discovered = {
      files: project.found,
      used: project.found.length > 0,
      about: null,
      report: {},
      needs: ({ publishEnvironment }: { publishEnvironment: Environment }) =>
        needsOf(workers, publishEnvironment),
    };
    return { finish: async () => discovered };
  },
};

function needsOf(workers: readonly Worker[], environment: Environment) {
  const notes: string[] = [];
  const accounts = new Map<string, Set<string | null>>();
  for (const worker of workers)
    if (worker.worker !== null)
      accounts.set(worker.worker, (accounts.get(worker.worker) ?? new Set()).add(worker.account));
  const places = workers.map((worker) =>
    workerPlace(worker, (accounts.get(worker.worker ?? "")?.size ?? 0) > 1),
  );
  const declaredBy = new Map<string, Set<Environment>>();
  workers.forEach((worker, i) => {
    const id = places[i]?.id ?? "";
    if (!declaredBy.has(id)) declaredBy.set(id, new Set());
    if (worker.env !== null && isEnvironmentName(worker.env)) declaredBy.get(id)?.add(worker.env);
  });
  const needs: FoundNeed[] = [];
  for (const [i, worker] of workers.entries()) {
    const base = places[i];
    if (!base) continue;
    const environments = [...(declaredBy.get(base.id) ?? [])].sort();
    const place: Place = environments.length
      ? { ...base, onlyFrom: { environments, source: "wrangler env", thing: "Worker" } }
      : base;
    if (worker.env !== null && !isEnvironmentName(worker.env) && worker.required?.length)
      notes.push(
        `${worker.config} env ${worker.env} isn't a keypin environment name, so check proposes its Worker under ${environment}; publish it from the environment that holds its value`,
      );
    for (const name of worker.required ?? []) needs.push({ name, place, usedBy: worker.config });
  }
  for (const [id, envs] of declaredBy) {
    const label = needs.find((n) => n.place.id === id)?.place.label;
    if (envs.size < 2 || label === undefined) continue;
    notes.push(
      `${label} is declared by the wrangler envs ${[...envs].sort().join(" and ")}; it holds one value, so check accepts it from any of them. Give each env its own Worker name to check them apart`,
    );
  }
  return { needs, notes };
}

function workerPlace(worker: Worker, ambiguous: boolean): Place {
  const held = worker.read?.ok ? new Set(worker.read.secrets.map((s) => s.name)) : null;
  const name = worker.worker;
  const where = `${worker.config}${worker.env ? ` (env ${worker.env})` : ""}`;
  const account = ambiguous ? ` in account ${worker.account ?? `unknown (${worker.config})`}` : "";
  const detail = worker.account ?? ACCOUNT_PLACEHOLDER;
  return {
    id: `cloudflare-worker:${worker.account ?? (ambiguous ? where : "")}:${name ?? where}`,
    to: "cloudflare-worker",
    label: `the Worker ${name === null ? `in ${where}` : `${name}${account}`}`,
    verb: "requires",
    fields: [
      ["to", "cloudflare-worker"],
      ["account", detail],
      ["worker", name ?? WORKER_PLACEHOLDER],
    ],
    ...(name === null
      ? {}
      : {
          slot: {
            name,
            detail,
            of: (target) =>
              target.to === "cloudflare-worker" && target.worker !== undefined
                ? { name: target.worker, detail: target.account }
                : undefined,
            twice: (key, taken) =>
              `keypin.toml can't publish ${key} to two Workers named ${name} from one environment (accounts ${taken} and ${detail}); publish one of them from another environment, listed in environments`,
          },
        }),
    matches: (keyName, secret) => keyName === secret,
    covers: (target) =>
      target.to === "cloudflare-worker" &&
      name !== null &&
      target.worker === name &&
      (worker.account === null || target.account === worker.account),
    holds: (secret) => (held ? held.has(secret) : null),
  };
}
