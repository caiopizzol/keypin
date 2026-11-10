import { diskLock } from "../src/disk";

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("usage: lock-holder.ts <lock path>");
const taken = await diskLock(path);
process.stdout.write(taken.held ? "holding\n" : "refused\n");
try {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
} finally {
  if (taken.held) await taken.lock.release();
}
