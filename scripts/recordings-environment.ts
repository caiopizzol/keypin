import { appendFileSync } from "node:fs";
import { VitestSnapshotEnvironment } from "vite-plus/test/runtime";

const log = process.env.RECORDINGS_LOG;

class RecordingsEnvironment extends VitestSnapshotEnvironment {
  override async resolveRawPath(testPath: string, rawPath: string): Promise<string> {
    const path = await super.resolveRawPath(testPath, rawPath);
    if (log) appendFileSync(log, `${path}\0`);
    return path;
  }
}

export default new RecordingsEnvironment();
