import type { KeyId } from "./contracts";
import { type Files, readVersionedJson, writeJsonAtomic } from "./files";

const REGISTRY_VERSION = 1;

export interface SharedKey {
  id: KeyId;
  description?: string;
}

export interface Registry {
  version: typeof REGISTRY_VERSION;
  projects: string[];
  shared: SharedKey[];
}

const emptyRegistry = (): Registry => ({
  version: REGISTRY_VERSION,
  projects: [],
  shared: [],
});

export async function loadRegistry(files: Files, path: string): Promise<Registry> {
  const data = await readVersionedJson(files, path, [REGISTRY_VERSION], "registry");
  if (!data) return emptyRegistry();
  const { projects, shared } = data;
  if (!Array.isArray(projects) || !projects.every((p) => typeof p === "string")) {
    throw new Error(`${path}: the registry's "projects" must be a list of paths`);
  }
  if (!Array.isArray(shared) || !shared.every((s) => typeof s?.id === "string")) {
    throw new Error(`${path}: the registry's "shared" must be a list of { id }`);
  }
  return { version: REGISTRY_VERSION, projects, shared };
}

export async function register(files: Files, path: string, project: string): Promise<Registry> {
  const folder = projectPath(project);
  const registry = await loadRegistry(files, path);
  if (registry.projects.includes(folder)) return registry;
  const next = { ...registry, projects: [...registry.projects, folder].sort() };
  await writeJsonAtomic(files, path, next);
  return next;
}

export async function unregister(files: Files, path: string, project: string): Promise<Registry> {
  const folder = projectPath(project);
  const registry = await loadRegistry(files, path);
  if (!registry.projects.includes(folder)) return registry;
  const next = { ...registry, projects: registry.projects.filter((p) => p !== folder) };
  await writeJsonAtomic(files, path, next);
  return next;
}

function projectPath(project: string): string {
  if (!project.startsWith("/"))
    throw new Error(`a project path must be absolute, got "${project}"`);
  return project.replace(/(.)\/+$/, "$1");
}
