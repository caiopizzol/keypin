import {
  type Discovery,
  type Environment,
  type FoundNeed,
  isEnvironmentName,
  type MapView,
  messageOf,
  type Place,
  type ProjectReader,
  type StoreRead,
} from "@keypin/core";
import {
  calledAcross,
  configsWranglerUses,
  WRANGLER_FILES,
  type WorkerDeclaration,
  wranglerWorkers,
} from "./wrangler";

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
    const { used, ignored } = configsWranglerUses(project.found);
    const skipped = ignored.map(
      ({ config, used }) => `wrangler reads ${used}, not ${config}, so check ignores ${config}`,
    );
    const texts: { text: string; config: string }[] = [];
    for (const config of used) {
      const text = await project.read(config);
      if (text !== null) texts.push({ text, config });
    }
    const called = calledAcross(texts);
    for (const { text, config } of texts) {
      const parsed = wranglerWorkers(text, config, called);
      if (!parsed.ok) {
        project.unknown(`the Workers in ${config}`, "it couldn't be parsed");
        continue;
      }
      if (parsed.pages)
        skipped.push(
          `${config} is a Cloudflare Pages project, and keypin publishes only to Workers; set its secrets with wrangler pages secret put`,
        );
      for (const env of parsed.skipped)
        skipped.push(
          `${config} env ${env} has no routes, workers.dev URL, trigger or binding to it, so check skips it as a Worker only wrangler dev runs`,
        );
      for (const worker of parsed.workers) {
        const label = `the secrets of the Worker ${worker.worker ?? `in ${config}`}`;
        let read: StoreRead | null = null;
        if (needsSecrets(worker, project)) {
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
      files: used,
      used: workers.some((worker) => needsSecrets(worker, project)),
      about: null,
      report: {},
      needs: (view: MapView) => {
        const found = needsOf(workers, view);
        return { ...found, notes: [...skipped, ...found.notes] };
      },
    };
    return { finish: async () => discovered };
  },
};

function needsSecrets(worker: WorkerDeclaration, project: ProjectReader): boolean {
  return worker.required?.some((name) => !project.ignores(name)) ?? false;
}

function needsOf(workers: readonly Worker[], view: MapView) {
  const environment = view.publishEnvironment;
  const notes: string[] = [];
  const problems: string[] = [];
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
        `${worker.config} env ${worker.env} isn't a profile name keypin reads, so check proposes its Worker under ${environment}; publish it from the profile that holds its value`,
      );
    for (const name of worker.required ?? []) needs.push({ name, place, usedBy: worker.config });
    for (const name of worker.vars)
      if (view.publishes(name, base))
        problems.push(
          `${name}: secretspec.toml publishes it to ${base.label} as a secret, but ${worker.config}${worker.env ? ` env ${worker.env}` : ""} sets it in vars, so the next wrangler deploy replaces the secret with that var; remove it from vars`,
        );
  }
  for (const [id, envs] of declaredBy) {
    const label = needs.find((n) => n.place.id === id)?.place.label;
    if (envs.size < 2 || label === undefined) continue;
    notes.push(
      `${label} is declared by the wrangler envs ${[...envs].sort().join(" and ")}; it holds one value, so check accepts it from any of them. Give each env its own Worker name to check them apart`,
    );
  }
  return { needs, notes, problems };
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
              `secretspec.toml can't publish ${key} to two Workers named ${name} from one profile (accounts ${taken} and ${detail}); publish one of them from another profile in secretspec.toml`,
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
