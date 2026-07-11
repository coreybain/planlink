#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { validateHtml } from "../html-policy.js";

const VERSION = "0.1.5";
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
  addressedQuestionIds?: unknown;
  error?: unknown;
  errors?: unknown;
}

interface DraftSummary {
  draftId: string;
  title: string;
  publicUrl: string;
  versionNumber: number | null;
  fileSize: number | null;
  originalFilename: string | null;
  repoOrg: string | null;
  repoName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
}

interface DraftListResponse {
  ok?: boolean;
  drafts?: unknown;
  error?: unknown;
}

interface DeleteDraftResponse {
  ok?: boolean;
  draftId?: unknown;
  draftIds?: unknown;
  deletedCount?: unknown;
  error?: unknown;
}

interface FeedbackItem {
  questionId: string;
  questionText: string;
  reviewerName: string;
  anchor: {
    text: string;
    sectionId: string | null;
  } | null;
  resolvedAt: string | null;
  addressedVersionNumber: number | null;
  answerText: string | null;
}

interface FeedbackResponse {
  ok?: boolean;
  draft?: unknown;
  currentVersionNumber?: unknown;
  feedback?: unknown;
  summary?: unknown;
  error?: unknown;
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
  .option(
    "--address <feedback-id>",
    "Mark a feedback thread addressed in the uploaded version (repeatable)",
    collectOption,
    [] as string[]
  )
  .option("--api-url <url>", "Override the default PlanLink API base URL")
  .description("Upload or update an HTML draft.")
  .action(async (
    file: string,
    options: { draft?: string; new?: boolean; address?: string[]; apiUrl?: string }
  ) => {
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
    const addressedQuestionIds = [...new Set(options.address || [])];

    if (addressedQuestionIds.length && !draftId) {
      throw new CliError("--address requires an existing draft. Pass --draft or upload the mapped file.");
    }

    const payload = {
      html,
      filename: path.basename(resolvedFile),
      draftId,
      addressedQuestionIds,
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
    if (addressedQuestionIds.length) {
      console.log(`Addressed feedback: ${addressedQuestionIds.join(", ")}`);
    }
    if (Array.isArray(body.warnings)) {
      for (const warning of body.warnings) {
        if (typeof warning === "string") {
          console.warn(`Warning: ${warning}`);
        }
      }
    }
  });

program
  .command("feedback")
  .argument("<draft-id>", "Draft ID to retrieve feedback for")
  .description("Retrieve draft feedback for an agent revision workflow.")
  .option("--all", "Include resolved and addressed feedback")
  .option("--prompt", "Print one AI-ready prompt containing the feedback")
  .option("--json", "Print the machine-readable response")
  .option("--api-url <url>", "Override the default PlanLink API base URL")
  .action(async (
    draftId: string,
    options: { all?: boolean; prompt?: boolean; json?: boolean; apiUrl?: string }
  ) => {
    const { apiUrl, apiKey } = readAuth(options.apiUrl);
    const status = options.all ? "all" : "open";
    const { body } = await requestJson<FeedbackResponse>(
      `${apiUrl}/api/drafts/${encodeURIComponent(draftId)}/feedback?status=${status}`,
      { headers: authHeaders(apiKey) }
    );

    if (options.json) {
      console.log(JSON.stringify(body, null, 2));
      return;
    }

    const feedback = requireFeedbackItems(body.feedback);
    const draft = requireFeedbackDraft(body.draft);
    const currentVersionNumber = requireNumber(
      body.currentVersionNumber,
      "Feedback response did not include currentVersionNumber."
    );

    if (options.prompt) {
      console.log(buildCombinedFeedbackPrompt({
        draftId,
        draftTitle: draft.title,
        publicUrl: draft.publicUrl,
        currentVersionNumber,
        feedback
      }));
      return;
    }

    console.log(`${draft.title} · v${currentVersionNumber}`);
    console.log(draft.publicUrl);
    if (!feedback.length) {
      console.log(options.all ? "No feedback." : "No unresolved feedback.");
      return;
    }

    for (const item of feedback) {
      const state = item.addressedVersionNumber
        ? `addressed in v${item.addressedVersionNumber}`
        : item.resolvedAt
          ? "resolved"
          : "open";
      console.log(`\n${item.questionId} · ${state} · ${item.reviewerName}`);
      if (item.anchor) console.log(`  On: “${item.anchor.text}”`);
      console.log(`  ${item.questionText}`);
      if (item.answerText) console.log(`  Answer: ${item.answerText}`);
    }

    console.log(`\nAI prompt: planlink feedback ${draftId} --prompt`);
  });

const draftsCommand = program
  .command("drafts")
  .description("List and delete drafts owned by the configured API key.");

draftsCommand
  .command("list")
  .description("List drafts owned by the configured API key.")
  .option("--api-url <url>", "Override the default PlanLink API base URL")
  .action(async (options: { apiUrl?: string }) => {
    const { apiUrl, apiKey } = readAuth(options.apiUrl);
    const { body } = await requestJson<DraftListResponse>(`${apiUrl}/api/drafts`, {
      headers: authHeaders(apiKey)
    });

    const drafts = requireDraftSummaries(body.drafts);
    if (!drafts.length) {
      console.log("No drafts found.");
      return;
    }

    for (const draft of drafts) {
      const version = draft.versionNumber ? `v${draft.versionNumber}` : "v-";
      const updated = draft.updatedAt || "unknown-date";
      const status = draft.disabledAt ? " disabled" : "";
      const repo = [draft.repoOrg, draft.repoName].filter(Boolean).join("/");
      const suffix = repo ? ` (${repo})` : "";

      console.log(`${draft.draftId} ${version} ${updated}${status} ${draft.title}${suffix}`);
      console.log(`  ${draft.publicUrl}`);
      if (draft.originalFilename) {
        console.log(`  file: ${draft.originalFilename}`);
      }
      if (draft.disabledReason) {
        console.log(`  disabled: ${draft.disabledReason}`);
      }
    }
  });

draftsCommand
  .command("delete")
  .alias("rm")
  .argument("<draft-id>", "Draft ID to delete")
  .description("Delete one draft owned by the configured API key.")
  .option("--yes", "Confirm deletion")
  .option("--api-url <url>", "Override the default PlanLink API base URL")
  .action(async (draftId: string, options: { yes?: boolean; apiUrl?: string }) => {
    requireConfirmation(options.yes, `Refusing to delete ${draftId} without confirmation.`);

    const { apiUrl, apiKey } = readAuth(options.apiUrl);
    const { body } = await requestJson<DeleteDraftResponse>(
      `${apiUrl}/api/drafts/${encodeURIComponent(draftId)}`,
      {
        method: "DELETE",
        headers: authHeaders(apiKey)
      }
    );

    const deletedDraftId = requireString(body.draftId, "Delete response did not include draftId.");
    const removedMappings = removeLocalDraftMappings([deletedDraftId]);
    console.log(`Deleted draft ${deletedDraftId}.`);
    if (removedMappings) {
      console.log(`Removed ${removedMappings} local draft mapping${removedMappings === 1 ? "" : "s"}.`);
    }
  });

draftsCommand
  .command("delete-all")
  .alias("clear")
  .description("Delete all drafts owned by the configured API key.")
  .option("--yes", "Confirm deletion")
  .option("--api-url <url>", "Override the default PlanLink API base URL")
  .action(async (options: { yes?: boolean; apiUrl?: string }) => {
    requireConfirmation(options.yes, "Refusing to delete all drafts without confirmation.");

    const { apiUrl, apiKey } = readAuth(options.apiUrl);
    const { body } = await requestJson<DeleteDraftResponse>(`${apiUrl}/api/drafts`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ confirm: "delete-all" })
    });

    const draftIds = requireStringArray(body.draftIds, "Delete response did not include draftIds.");
    const deletedCount = requireNumber(
      body.deletedCount,
      "Delete response did not include deletedCount."
    );
    const removedMappings = removeLocalDraftMappings(draftIds);

    console.log(`Deleted ${deletedCount} draft${deletedCount === 1 ? "" : "s"}.`);
    if (removedMappings) {
      console.log(`Removed ${removedMappings} local draft mapping${removedMappings === 1 ? "" : "s"}.`);
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

function removeLocalDraftMappings(draftIds: string[]): number {
  const idSet = new Set(draftIds);
  const drafts = readDrafts();
  let removed = 0;

  for (const [file, draft] of Object.entries(drafts.files || {})) {
    if (idSet.has(draft.draftId)) {
      delete drafts.files[file];
      removed += 1;
    }
  }

  if (removed) {
    writeJson<DraftsState>(DRAFTS_PATH, drafts, 0o600);
  }

  return removed;
}

function requireConfirmation(confirmed: boolean | undefined, message: string): void {
  if (!confirmed) {
    throw new CliError(`${message} Re-run with --yes.`);
  }
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) {
    throw new CliError("Missing API key. Run: planlink auth set <api-key>");
  }

  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": `planlink/${VERSION}`
  };
}

async function requestJson<T>(
  url: string,
  init: RequestInit
): Promise<{ response: Response; body: T }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new CliError(`Unable to connect to ${url}.${detail}`);
  }

  const text = await response.text();
  const body = parseJson<T>(text);

  if (!response.ok) {
    const error = isRecord(body) ? asString(body.error) : null;
    throw new CliError(error || `Request failed with status ${response.status}.`);
  }

  return { response, body };
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError("PlanLink returned an invalid JSON response.");
  }
}

function requireDraftSummaries(value: unknown): DraftSummary[] {
  if (!Array.isArray(value)) {
    throw new CliError("Draft list response did not include drafts.");
  }

  return value.map((draft) => {
    if (!isRecord(draft)) {
      throw new CliError("Draft list response included an invalid draft.");
    }

    return {
      draftId: requireString(draft.draftId, "Draft response did not include draftId."),
      title: requireString(draft.title, "Draft response did not include title."),
      publicUrl: requireString(draft.publicUrl, "Draft response did not include publicUrl."),
      versionNumber: optionalNumber(draft.versionNumber),
      fileSize: optionalNumber(draft.fileSize),
      originalFilename: optionalString(draft.originalFilename),
      repoOrg: optionalString(draft.repoOrg),
      repoName: optionalString(draft.repoName),
      createdAt: optionalString(draft.createdAt),
      updatedAt: optionalString(draft.updatedAt),
      disabledAt: optionalString(draft.disabledAt),
      disabledReason: optionalString(draft.disabledReason)
    };
  });
}

function requireFeedbackItems(value: unknown): FeedbackItem[] {
  if (!Array.isArray(value)) {
    throw new CliError("Feedback response did not include feedback.");
  }

  return value.map((item) => {
    if (!isRecord(item)) throw new CliError("Feedback response included an invalid thread.");
    const anchor = isRecord(item.anchor) && typeof item.anchor.text === "string"
      ? {
          text: item.anchor.text,
          sectionId: optionalString(item.anchor.sectionId)
        }
      : null;
    const answer = isRecord(item.answer) ? item.answer : null;
    return {
      questionId: requireString(item.questionId, "Feedback thread did not include questionId."),
      questionText: requireString(item.questionText, "Feedback thread did not include questionText."),
      reviewerName: optionalString(item.reviewerName) || "Anonymous reviewer",
      anchor,
      resolvedAt: optionalString(item.resolvedAt),
      addressedVersionNumber: optionalNumber(item.addressedVersionNumber),
      answerText: answer ? optionalString(answer.answerText) : null
    };
  });
}

function requireFeedbackDraft(value: unknown): { title: string; publicUrl: string } {
  if (!isRecord(value)) throw new CliError("Feedback response did not include draft details.");
  return {
    title: requireString(value.title, "Feedback draft did not include title."),
    publicUrl: requireString(value.publicUrl, "Feedback draft did not include publicUrl.")
  };
}

function buildCombinedFeedbackPrompt({
  draftId,
  draftTitle,
  publicUrl,
  currentVersionNumber,
  feedback
}: {
  draftId: string;
  draftTitle: string;
  publicUrl: string;
  currentVersionNumber: number;
  feedback: FeedbackItem[];
}): string {
  const lines = [
    "Please update this plan based on the reviewer feedback below.",
    "",
    `Plan: ${draftTitle}`,
    `Draft URL: ${publicUrl}`,
    `Current version: v${currentVersionNumber}`,
    ""
  ];

  if (!feedback.length) {
    lines.push("There is no unresolved feedback.");
    return lines.join("\n");
  }

  lines.push("Unresolved feedback:");
  feedback.forEach((item, index) => {
    lines.push("", `${index + 1}. ${item.questionText}`, `   Feedback ID: ${item.questionId}`);
    lines.push(`   Reviewer: ${item.reviewerName}`);
    if (item.anchor) lines.push(`   Selected text: “${item.anchor.text}”`);
    if (item.answerText) lines.push(`   Current answer: ${item.answerText}`);
  });
  lines.push(
    "",
    "Update the source HTML, explain how each item was handled, then upload the revision and mark these feedback IDs addressed:",
    `planlink upload <file> --draft ${draftId} ${feedback.map((item) => `--address ${item.questionId}`).join(" ")}`
  );
  return lines.join("\n");
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
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

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function requireStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new CliError(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
