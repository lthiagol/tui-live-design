import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TuiSpec } from "../shared/spec.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESIGNS_DIR = path.join(__dirname, "../../designs");

export interface SavedDesign {
  savedAt: string;
  rev: number;
  spec: TuiSpec;
}

function safeName(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`invalid design name "${name}" (use letters, digits, - and _)`);
  }
  return `${name}.json`;
}

export async function saveDesign(
  spec: TuiSpec,
  rev: number,
  name: string,
): Promise<string> {
  await mkdir(DESIGNS_DIR, { recursive: true });
  const file = path.join(DESIGNS_DIR, safeName(name));
  const body: SavedDesign = { savedAt: new Date().toISOString(), rev, spec };
  // L4/R2-L10: atomic write + fsync — a crash can't corrupt, and rename
  // won't outpace the data on disk
  const tmp = `${file}.tmp-${randomBytes(4).toString("hex")}`;
  const fh = await open(tmp, "w");
  try {
    await fh.write(JSON.stringify(body, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  return file;
}

export async function loadDesign(name: string): Promise<SavedDesign> {
  const file = path.join(DESIGNS_DIR, safeName(name));
  const raw = JSON.parse(await readFile(file, "utf8")) as SavedDesign;
  if (raw.spec?.version !== 1 || !raw.spec.root) {
    throw new Error(`${file} is not a valid saved design`);
  }
  return raw;
}

export async function listDesigns(): Promise<Array<{ name: string; savedAt: string; rev: number }>> {
  try {
    const files = await readdir(DESIGNS_DIR);
    const out = [];
    for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
      const name = f.replace(/\.json$/, "");
      try {
        // L4: savedAt/rev are the first fields we write — read only the file
        // head instead of parsing every full design
        const fh = await open(path.join(DESIGNS_DIR, f), "r");
        try {
          const buf = Buffer.alloc(256);
          const { bytesRead } = await fh.read(buf, 0, 256, 0);
          const head = buf.slice(0, bytesRead).toString("utf8");
          const rev = /"rev":\s*(-?\d+)/.exec(head)?.[1];
          const savedAt = /"savedAt":\s*"([^"]*)"/.exec(head)?.[1];
          if (rev !== undefined && savedAt !== undefined) {
            out.push({ name, savedAt, rev: Number(rev) });
            continue;
          }
          // fallback: unusual formatting — full parse
          const d = JSON.parse(await readFile(path.join(DESIGNS_DIR, f), "utf8")) as SavedDesign;
          out.push({ name, savedAt: d.savedAt, rev: d.rev });
        } finally {
          await fh.close();
        }
      } catch {
        out.push({ name, savedAt: "(unreadable)", rev: -1 });
      }
    }
    return out;
  } catch {
    return [];
  }
}
