import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/**
 * In-process mutex that serializes async read-modify-write on a JSON file.
 * Concurrent callers queue; the on-disk format is unchanged.
 */
export function createMutex(): <T>(fn: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = tail.then(() => fn(), () => fn());
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

/** Write via temp file + rename so readers never see a partial JSON document. */
export function atomicWriteFileSync(path: string, data: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tempPath = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tempPath, data);
    renameSync(tempPath, path);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFileSync(path, JSON.stringify(value, null, 2));
}
