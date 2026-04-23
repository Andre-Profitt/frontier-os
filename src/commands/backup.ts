import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { defaultCommandDbPath } from "./store.ts";

export interface CommandBackupOptions {
  destDir?: string;
}

export interface CommandBackupFile {
  source: string;
  destination: string;
  copied: boolean;
}

export interface CommandBackupResult {
  generatedAt: string;
  status: "created";
  backupDir: string;
  manifestPath: string;
  dbPath: string;
  files: CommandBackupFile[];
}

export function backupCommandDb(
  options: CommandBackupOptions = {},
): CommandBackupResult {
  const generatedAt = new Date().toISOString();
  const dbPath = defaultCommandDbPath();
  const root =
    options.destDir ?? resolve(homedir(), ".frontier", "commands", "backups");
  const backupDir = resolve(root, timestampForPath(generatedAt));
  mkdirSync(backupDir, { recursive: true });
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((source) => {
    const destination = resolve(backupDir, basename(source));
    if (!existsSync(source)) {
      return { source, destination, copied: false };
    }
    copyFileSync(source, destination);
    return { source, destination, copied: true };
  });
  const manifestPath = resolve(backupDir, "manifest.json");
  const result: CommandBackupResult = {
    generatedAt,
    status: "created",
    backupDir,
    manifestPath,
    dbPath,
    files,
  };
  writeFileSync(manifestPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  return result;
}

function timestampForPath(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}
