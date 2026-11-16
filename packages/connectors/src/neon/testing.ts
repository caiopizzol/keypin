import type { Fetch } from "@keypin/core";

export interface NeonRole {
  password: string;
  resets: number;
}

export interface NeonWorld {
  roles: Record<string, NeonRole>;
  operations: Record<string, { polls: number }>;
  made: number;
}

export interface FakeNeon {
  admin?: string;
  projectId: string;
  branchId: string;
  database: string;
  host: string;
  endpoints?: string[];
  passwordPrefix: string;
  pollsToFinish?: number;
  failReset?: "refuse" | "operation" | "role gone";
  locked?: number;
  permission?: "VIEWER" | "EDITOR" | "ADMIN";
  readOnly?: boolean;
  world: {
    load(): NeonWorld;
    save(world: NeonWorld): void;
  };
  effect(line: string): void;
}

export function neonFetch(fake: FakeNeon): Fetch {
  let locked = fake.locked ?? 0;
  return async (url, init) => {
    const world = fake.world.load();
    const { pathname } = new URL(url);
    const reply = (status: number, body: object) => new Response(JSON.stringify(body), { status });
    const missing = () => reply(404, { code: "NOT_FOUND", message: "not found" });
    if (fake.admin !== undefined && init.headers.Authorization !== `Bearer ${fake.admin}`)
      return reply(401, { code: "UNAUTHORIZED", message: "authentication required" });
    const project = `/api/v2/projects/${fake.projectId}`;
    if (!pathname.startsWith(project)) return missing();
    const rest = pathname.slice(project.length);
    const at = (role: NeonRole) => `2026-11-15T12:00:${String(role.resets).padStart(2, "0")}Z`;
    const described = (name: string, role: NeonRole) => ({
      branch_id: fake.branchId,
      name,
      protected: false,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: at(role),
    });

    if (init.method === "GET" && rest === "")
      return reply(200, {
        project: {
          id: fake.projectId,
          ...(fake.permission ? { effective_project_permission: fake.permission } : {}),
        },
      });
    if (init.method === "GET" && rest.startsWith("/operations/")) {
      const id = decodeURIComponent(rest.slice("/operations/".length));
      const operation = world.operations[id];
      if (!operation) return missing();
      operation.polls++;
      fake.world.save(world);
      const status =
        fake.failReset === "operation"
          ? "failed"
          : operation.polls >= (fake.pollsToFinish ?? 1)
            ? "finished"
            : "running";
      return reply(200, { operation: { id, action: "apply_config", status } });
    }

    const branch = `/branches/${fake.branchId}`;
    if (!rest.startsWith(branch)) return missing();
    const inBranch = rest.slice(branch.length);
    if (init.method === "GET" && inBranch === "/roles")
      return reply(200, {
        roles: Object.entries(world.roles).map(([name, role]) => described(name, role)),
      });
    if (init.method === "GET" && inBranch === "/endpoints") {
      const ids = fake.endpoints ?? [fake.host.split(".")[0] ?? ""];
      return reply(200, { endpoints: ids.map((id) => ({ id, branch_id: fake.branchId })) });
    }
    if (init.method === "GET" && inBranch === `/databases/${fake.database}`)
      return reply(200, { database: { name: fake.database } });
    const match = /^\/roles\/([^/]+)(\/reset_password)?$/.exec(inBranch);
    const name = decodeURIComponent(match?.[1] ?? "");
    const role = world.roles[name];
    if (!match || !role) return missing();
    if (init.method === "GET" && !match[2]) return reply(200, { role: described(name, role) });
    if (init.method !== "POST" || !match[2]) return missing();
    if (fake.readOnly) return reply(404, { code: "", message: "not found" });
    if (fake.failReset === "role gone") {
      delete world.roles[name];
      fake.world.save(world);
      return missing();
    }
    if (locked > 0) {
      locked--;
      return reply(423, { code: "LOCKED", message: "project already has running operations" });
    }
    if (fake.failReset === "refuse")
      return reply(500, {
        code: "INTERNAL_ERROR",
        message: `refused ${init.headers.Authorization}`,
      });
    world.made++;
    role.resets++;
    role.password = `${fake.passwordPrefix}${world.made}`;
    const id = `op-${world.made}`;
    world.operations[id] = { polls: 0 };
    fake.world.save(world);
    fake.effect(`neon reset ${name}`);
    return reply(200, {
      role: { ...described(name, role), password: role.password },
      operations: [{ id, action: "apply_config", status: "running" }],
    });
  };
}

export function memoryWorld(roles: Record<string, string>) {
  let world: NeonWorld = {
    roles: Object.fromEntries(
      Object.entries(roles).map(([name, password]) => [name, { password, resets: 0 }]),
    ),
    operations: {},
    made: 0,
  };
  return { load: () => world, save: (next: NeonWorld) => void (world = next) };
}
