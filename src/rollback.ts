import { readOrRefuse, writeFileAtomic } from "./fsutil.ts";

/** A file to save: where it is and what to call it in a refusal (for example "current key"). */
interface SavedFile {
  path: string;
  what: string;
}

/** The files a change can touch, as they were, so a failure can put them back. */
export interface Snapshot<K extends string> {
  /** What each file held. */
  text: Record<K, string>;
  /** Writes every file back, in the order they were saved. */
  putBack(): Promise<void>;
}

/** Reads every file, in order, refusing at the first one that can't be read. */
export async function snapshotFiles<K extends string>(
  files: Record<K, SavedFile>,
): Promise<Snapshot<K>> {
  const keys = Object.keys(files) as K[];
  const text = {} as Record<K, string>;
  for (const key of keys) text[key] = await readOrRefuse(files[key].path, files[key].what);
  return {
    text,
    async putBack() {
      for (const key of keys) await writeFileAtomic(files[key].path, text[key], 0o600);
    },
  };
}
