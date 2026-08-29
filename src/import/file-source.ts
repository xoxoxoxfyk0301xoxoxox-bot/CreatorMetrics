import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface ImportFile { filename: string; path: string; bytes: Uint8Array }
export interface FileSource { listFiles(): Promise<ImportFile[]> }

export class LocalInboxFileSource implements FileSource {
  constructor(private readonly directories: string[]) {}
  async listFiles(): Promise<ImportFile[]> {
    const files: ImportFile[] = [];
    for (const directory of this.directories) {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".csv")) continue;
        const path = join(directory, entry.name);
        files.push({ filename: basename(path), path, bytes: await readFile(path) });
      }
    }
    return files;
  }
}
