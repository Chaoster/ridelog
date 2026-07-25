// Helper to load environment variables from multiple sources:
// 1. Deno.env.get() (production via supabase secrets set, or shell export)
// 2. .env files in common locations
// 3. ./local-env.ts fallback (for local dev when env vars / .env are not available)

const POSSIBLE_ENV_PATHS = [
  "./.env",
  "../.env",
  "../../.env",
  "../../../.env",
  "./supabase/.env",
  "../supabase/.env",
  "../../supabase/.env",
];

function parseEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  });
  return env;
}

let cachedFileEnv: Record<string, string> | null = null;
let cachedLocalEnv: Record<string, string> | null = null;

async function loadLocalEnv(): Promise<Record<string, string>> {
  if (cachedLocalEnv) return cachedLocalEnv;
  try {
    const mod = await import("./local-env.ts");
    cachedLocalEnv = mod.default || {};
    console.log("[env] loaded local-env.ts fallback");
  } catch (err) {
    console.log(`[env] local-env.ts not available: ${(err as Error).message}`);
    cachedLocalEnv = {};
  }
  return cachedLocalEnv;
}

export async function loadFileEnv(): Promise<Record<string, string>> {
  if (cachedFileEnv) return cachedFileEnv;

  for (const path of POSSIBLE_ENV_PATHS) {
    try {
      const content = await Deno.readTextFile(path);
      cachedFileEnv = parseEnv(content);
      console.log(`[env] loaded env from ${path}`);
      return cachedFileEnv;
    } catch {
      // ignore and try next path
    }
  }

  cachedFileEnv = {};
  return cachedFileEnv;
}

export async function getEnv(key: string): Promise<string | undefined> {
  const fromDeno = Deno.env.get(key);
  if (fromDeno) return fromDeno;

  const fromFile = await loadFileEnv();
  if (fromFile[key]) return fromFile[key];

  const fromLocal = await loadLocalEnv();
  return fromLocal[key];
}
