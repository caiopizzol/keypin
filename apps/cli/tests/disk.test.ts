import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, assert, beforeEach, describe, expect, test } from "vite-plus/test";
import { emptyState, register, saveState } from "@keypin/core";
import { createFile, diskFiles, diskLock, replaceFile } from "../src/disk";

const HOLDER = fileURLToPath(new URL("lock-holder.ts", import.meta.url));

let folder = "";
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "keypin-lock-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

async function leftLock(text: string): Promise<string> {
  const path = join(folder, "state", "state.json.lock");
  await mkdir(join(folder, "state"), { recursive: true });
  await writeFile(path, text);
  return path;
}

describe("diskLock", () => {
  test("only one holder at a time, and releasing frees it", async () => {
    const path = join(folder, "state", "state.json.lock");
    const first = await diskLock(path);
    assert(first.held);
    expect(await readFile(path, "utf8")).toBe(`${process.pid}\n`);
    expect(await diskLock(path)).toEqual({
      held: false,
      holder: { pid: process.pid, running: true },
    });
    await first.lock.release();
    expect(await readdir(join(folder, "state"))).toEqual([]);
    const again = await diskLock(path);
    assert(again.held);
    await again.lock.release();
  });

  test("a lock left by a process that no longer runs is reported, and left in place", async () => {
    const pid = await deadPid();
    const path = await leftLock(`${pid}\n`);
    expect(await diskLock(path)).toEqual({ held: false, holder: { pid, running: false } });
    expect(await readFile(path, "utf8")).toBe(`${pid}\n`);
  });

  test("a lock without a process ID is reported as such", async () => {
    const path = await leftLock("locked\n");
    expect(await diskLock(path)).toEqual({ held: false, holder: { pid: null, running: null } });
  });

  test("Ctrl-C while holding the lock removes it, and the process still ends by SIGINT", async () => {
    const path = join(folder, "state", "state.json.lock");
    const child = Bun.spawn([process.execPath, HOLDER, path], {
      stdout: "pipe",
    });
    const first = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(first.value)).toBe("holding\n");
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    expect(child.signalCode).toBe("SIGINT");
    expect(await readdir(join(folder, "state"))).toEqual([]);
    const next = await diskLock(path);
    assert(next.held);
    await next.lock.release();
  });

  test("SIGTERM while holding the lock removes it too", async () => {
    const path = join(folder, "state", "state.json.lock");
    const child = Bun.spawn([process.execPath, HOLDER, path], {
      stdout: "pipe",
    });
    await child.stdout.getReader().read();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await readdir(join(folder, "state"))).toEqual([]);
  });
});

describe("diskFiles", () => {
  const mode = async (path: string) => (await stat(path)).mode & 0o777;

  test("the registry, state and lock are private to the user, and so are their folders", async () => {
    const state = join(folder, "state", "keypin", "state.json");
    const registry = join(folder, "config", "keypin", "registry.json");
    await saveState(diskFiles, state, emptyState());
    await register(diskFiles, registry, "/work/billing");
    const taken = await diskLock(`${state}.lock`);
    assert(taken.held);
    expect(await mode(state)).toBe(0o600);
    expect(await mode(registry)).toBe(0o600);
    expect(await mode(`${state}.lock`)).toBe(0o600);
    expect(await mode(join(folder, "state", "keypin"))).toBe(0o700);
    expect(await mode(join(folder, "config", "keypin"))).toBe(0o700);
    await taken.lock.release();
  });

  test("a write tightens a file and folder that were readable by others", async () => {
    const state = join(folder, "keys", "state.json");
    await mkdir(join(folder, "keys"), { mode: 0o755 });
    await writeFile(state, JSON.stringify(emptyState()), { mode: 0o644 });
    await saveState(diskFiles, state, emptyState());
    expect(await mode(state)).toBe(0o600);
    expect(await mode(join(folder, "keys"))).toBe(0o700);
  });

  test("a write never follows a symbolic link", async () => {
    const target = join(folder, "elsewhere");
    await symlink(target, join(folder, "state.json"));
    await expect(diskFiles.write(join(folder, "state.json"), "{}")).rejects.toThrow();
    expect(await readdir(folder)).toEqual(["state.json"]);
  });
});

describe("createFile", () => {
  test("creates a missing file, and leaves an existing one", async () => {
    const path = join(folder, "keypin.toml");
    expect(await createFile(path, "first")).toBe("created");
    expect(await createFile(path, "second")).toBe("exists");
    expect(await readFile(path, "utf8")).toBe("first");
  });

  test("reports a symbolic link, dangling or not, and writes nothing through it", async () => {
    const outside = join(folder, "outside");
    await symlink(outside, join(folder, "keypin.toml"));
    expect(await createFile(join(folder, "keypin.toml"), "template")).toBe("link");
    expect(await readdir(folder)).toEqual(["keypin.toml"]);
    await writeFile(outside, "theirs");
    expect(await createFile(join(folder, "keypin.toml"), "template")).toBe("link");
    expect(await readFile(outside, "utf8")).toBe("theirs");
  });
});

describe("replaceFile", () => {
  test("replaces a file only while it holds the expected text, and keeps its mode", async () => {
    const path = join(folder, "keypin.toml");
    await writeFile(path, "template");
    await chmod(path, 0o640);
    expect(await replaceFile(path, "other", "draft")).toBe("changed");
    expect(await readFile(path, "utf8")).toBe("template");
    expect(await replaceFile(path, "template", "the draft")).toBe("replaced");
    expect(await readFile(path, "utf8")).toBe("the draft");
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await readdir(folder)).toEqual(["keypin.toml"]);
  });

  test("replaces the file by renaming a new one over it, so a reader never sees it half written", async () => {
    const path = join(folder, "keypin.toml");
    await writeFile(path, "template");
    const before = (await stat(path)).ino;
    expect(await replaceFile(path, "template", "the draft")).toBe("replaced");
    expect((await stat(path)).ino).not.toBe(before);
  });

  test("reports a symbolic link and writes nothing through it", async () => {
    const outside = join(folder, "outside");
    await writeFile(outside, "template");
    await symlink(outside, join(folder, "keypin.toml"));
    expect(await replaceFile(join(folder, "keypin.toml"), "template", "draft")).toBe("link");
    expect(await readFile(outside, "utf8")).toBe("template");
  });

  test("a missing file is changed, not created", async () => {
    expect(await replaceFile(join(folder, "keypin.toml"), "template", "draft")).toBe("changed");
    expect(await readdir(folder)).toEqual([]);
  });
});
