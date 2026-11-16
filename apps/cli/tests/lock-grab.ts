import { diskLock } from "../src/disk";

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("usage: lock-grab.ts <lock path>");
const taken = await diskLock(path);
if (taken.held) await taken.lock.release();
const { pid, running } = taken.held ? { pid: process.pid, running: true } : taken.holder;
process.stdout.write(taken.held ? "held\n" : pid !== null && running ? "busy\n" : `${pid}\n`);
