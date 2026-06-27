#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { validateHtml } from "../html-policy.js";

const VERSION = "0.1.2";
const DEFAULT_API_URL = "https://planlink.spiritdevs.com";
const PLANLINK_DIR = path.join(os.homedir(), ".planlink");
const CONFIG_PATH = path.join(PLANLINK_DIR, "config.json");
const CREDENTIALS_PATH = path.join(PLANLINK_DIR, "credentials.json");
const DRAFTS_PATH = path.join(PLANLINK_DIR, "drafts.json");

class CliError extends Error {}

interface CliConfig {
  apiUrl?: string;
}

interface Credentials {
  apiKey?: string;
  updatedAt?: string;
}

interface DraftRecord {
  draftId: string;
  publicUrl: string;
  latestVersionNumber: number;
  updatedAt: string;
}

interface DraftsState {
  files: Record<string, DraftRecord>;
}

interface AuthState {
  apiUrl: string;
  apiKey?: string;
}

interface GitMetadata {
  repoOrg: string | null;
  repoName: string | null;
  gitBranch: string | null;
  gitCommitSha: string | null;
}

interface UploadResponse {
  ok?: boolean;
  draftId?: unknown;
  publicUrl?: unknown;
  versionNumber?: unknown;
  warnings?: unknown;
  error?: unknown;
  errors?: unknown;
}

const program = new Command();

program
  .name("planlink")
  .description("Upload static HTML drafts to PlanLink.")
  .version(VERSION);

const authCommand = program
  .command("auth")
  .description("Manage CLI authentication.");

authCommand
  .command("set")
  .argument("<api-key>", "PlanLink API key")
  .option("--api-url <url>", "Override the default PlanLink API base URL")
  .action((apiKey: string, options: { apiUrl?: string }) => {
    ensureStateDir();

    if (options.apiUrl) {
      writeJson<CliConfig>(CONFIG_PATH, {
        ...readJson<CliConfig>(CONFIG_PATH, {}),
        apiUrl: options.apiUrl.replace(/\/+$/, "")
      });
    }

    writeJson<Credentials>(
      CREDENTIALS_PATH,
      {
        apiKey,
        updatedAt: new Date().toISOString()
      },
      0o600
    );

    console.log("PlanLink credentials saved.");
  });

program
  .command("whoami")
  .description("Check the configured PlanLink credentials.")
  .action(async () => {
    const { apiUrl, apiKey } = readAuth();
    const response = await fetch(`${apiUrl}/api/me`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new CliError(asString(body.error) || "Authentication failed.");
    }
    console.log(`Account: ${body.accountName} (${body.accountId})`);
    console.log(`API key: ${body.apiKeyName} (${body.apiKeyId})`);
  });

program
  .command("upload")
  .argument("<file>", "HTML file path")
  .option("--draft <draft-id>", "Update a specific draft")
  .option("--new", "Always create a new draft")
  .option("--api-url <url>", "Override the default PlanLink API base URL")
  .description("Upload or update an HTML draft.")
  .action(async (file: string, options: { draft?: string; new?: boolean; apiUrl?: string }) => {
    const resolvedFile = path.resolve(file);
    const { apiUrl, apiKey } = readAuth(options.apiUrl, { requireApiKey: false });

    if (!fs.existsSync(resolvedFile)) {
      throw new CliError(`File does not exist: ${resolvedFile}`);
    }

    const html = fs.readFileSync(resolvedFile, "utf8");
    const validation = validateHtml(html);

    if (!validation.ok) {
      throw new CliError(`HTML failed PlanLink validation:\n- ${validation.errors.join("\n- ")}`);
    }

    const drafts = readDrafts();
    const knownDraft = drafts.files?.[resolvedFile];
    const draftId = options.new ? null : options.draft || knownDraft?.draftId || null;

    const payload = {
      html,
      filename: path.basename(resolvedFile),
      draftId,
      metadata: {
        ...collectGitMetadata(path.dirname(resolvedFile)),
        cliVersion: VERSION,
        fileSha256: sha256(html)
      }
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": `planlink/${VERSION}`
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${apiUrl}/api/uploads`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const body = (await response.json()) as UploadResponse;
    if (!response.ok) {
      const errors = Array.isArray(body.errors)
        ? body.errors.filter((error): error is string => typeof error === "string")
        : [];
      const details = errors.length ? `\n- ${errors.join("\n- ")}` : "";
      throw new CliError(`${asString(body.error) || "Upload failed."}${details}`);
    }

    const responseDraftId = requireString(body.draftId, "Upload response did not include draftId.");
    const publicUrl = requireString(body.publicUrl, "Upload response did not include publicUrl.");
    const versionNumber = requireNumber(
      body.versionNumber,
      "Upload response did not include versionNumber."
    );

    drafts.files ||= {};
    drafts.files[resolvedFile] = {
      draftId: responseDraftId,
      publicUrl,
      latestVersionNumber: versionNumber,
      updatedAt: new Date().toISOString()
    };
    writeJson<DraftsState>(DRAFTS_PATH, drafts, 0o600);

    console.log(draftId ? "Updated draft" : "Uploaded draft");
    console.log(`URL: ${publicUrl}`);
    console.log(`Draft ID: ${responseDraftId}`);
    console.log(`Version: ${versionNumber}`);
    if (Array.isArray(body.warnings)) {
      for (const warning of body.warnings) {
        if (typeof warning === "string") {
          console.warn(`Warning: ${warning}`);
        }
      }
    }
  });

program.exitOverride();

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(1);
  }

  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "commander.helpDisplayed" || error.code === "commander.version")
  ) {
    process.exit(0);
  }

  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

function readAuth(apiUrlOverride?: string, { requireApiKey = true } = {}): AuthState {
  const config = readJson<CliConfig>(CONFIG_PATH, {});
  const credentials = readJson<Credentials>(CREDENTIALS_PATH, {});
  const apiUrl = (
    apiUrlOverride ||
    process.env.PLANLINK_API_URL ||
    config.apiUrl ||
    DEFAULT_API_URL
  ).replace(/\/+$/, "");
  const apiKey = process.env.PLANLINK_API_KEY || credentials.apiKey;

  if (requireApiKey && !apiKey) {
    throw new CliError("Missing API key. Run: planlink auth set <api-key>");
  }

  return { apiUrl, apiKey };
}

function ensureStateDir(): void {
  fs.mkdirSync(PLANLINK_DIR, { recursive: true, mode: 0o700 });
}

function readDrafts(): DraftsState {
  return readJson<DraftsState>(DRAFTS_PATH, { files: {} });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(file: string, value: T, mode = 0o600): void {
  ensureStateDir();
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(file, mode);
}

function collectGitMetadata(cwd: string): GitMetadata {
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  const remote = git(["config", "--get", "remote.origin.url"], cwd);
  const parsedRemote = parseRemote(remote);

  return {
    repoOrg: parsedRemote.org || inferOrgFromRoot(repoRoot),
    repoName: parsedRemote.name || (repoRoot ? path.basename(repoRoot) : null),
    gitBranch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    gitCommitSha: git(["rev-parse", "HEAD"], cwd)
  };
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function parseRemote(remote: string | null): { org?: string; name?: string } {
  if (!remote) return {};

  const cleaned = remote.replace(/\.git$/, "");
  const sshMatch = cleaned.match(/^[^@]+@[^:]+:([^/]+)\/(.+)$/);
  if (sshMatch) {
    return { org: sshMatch[1], name: path.basename(sshMatch[2]) };
  }

  try {
    const url = new URL(cleaned);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return { org: parts[0], name: parts.at(-1) };
    }
  } catch {
    // Fall through to path parsing.
  }

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return { org: parts.at(-2), name: parts.at(-1) };
  }

  return {};
}

function inferOrgFromRoot(repoRoot: string | null): string | null {
  if (!repoRoot) return null;
  return path.basename(path.dirname(repoRoot));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireString(value: unknown, message: string): string {
  const stringValue = asString(value);
  if (!stringValue) throw new CliError(message);
  return stringValue;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  throw new CliError(message);
}
