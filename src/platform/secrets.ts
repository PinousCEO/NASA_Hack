/**
 * Secret and configuration management. Secrets come only from the process environment
 * (optionally loaded from a local, git-ignored `.env` file); they are never written to
 * disk by the platform, never returned by an API, and never logged.
 */
import { existsSync } from "node:fs";
import path from "node:path";

interface SecretSpec {
  name: string;
  purpose: string;
  required: boolean;
}

export const SECRETS: SecretSpec[] = [
  { name: "ANTHROPIC_API_KEY", purpose: "Language-model request analysis, multi-tool planning and code generation", required: false },
  { name: "NASA_API_KEY", purpose: "Reserved for NASA Open API providers that require a key (none is required by the built-in providers)", required: false },
  { name: "GMAT_BIN", purpose: "Path to a GMAT console executable, enabling the gmat.run capability", required: false },
  { name: "TLS_CERT_FILE", purpose: "TLS certificate (PEM) — required for WebXR on devices other than localhost", required: false },
  { name: "TLS_KEY_FILE", purpose: "TLS private key (PEM)", required: false },
];

/** Load `.env` from the project root if present. Existing environment variables win. */
export function loadEnvFile(projectRoot: string): boolean {
  const file = path.join(projectRoot, ".env");
  if (!existsSync(file)) return false;
  const before = { ...process.env };
  process.loadEnvFile(file);
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
  return true;
}

/** Which secrets are configured — presence only, never values. */
export function describeSecrets(): { name: string; purpose: string; configured: boolean }[] {
  return SECRETS.map((s) => ({ name: s.name, purpose: s.purpose, configured: Boolean(process.env[s.name]) }));
}

/** Remove anything that looks like a credential from text bound for logs or clients. */
export function redact(text: string): string {
  let out = text;
  for (const s of SECRETS) {
    const value = process.env[s.name];
    if (value && value.length >= 8) out = out.split(value).join(`[${s.name}]`);
  }
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted-key]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [redacted]");
}
