import express, { type NextFunction, type Request, type Response } from "express";
import { contentHash, randomToken, sha256 } from "./crypto.js";
import { config } from "./config.js";
import {
  findApiKeyByToken,
  newEventId,
  pool,
  publicUploadAuth,
  type ApiKeyAuth,
  withTransaction
} from "./db.js";
import { newDraftId, newInternalId } from "./ids.js";
import { renderDraftWrapper, renderHome, renderNotFound } from "./render.js";
import { createRateLimiter } from "./rate-limit.js";
import { getHtmlObject, putHtmlObject } from "./storage.js";
import { validateHtml } from "./html-policy.js";
import {
  getDraftIdFromHost,
  getDraftPublicUrl,
  getHomeUrl,
  getRequestBaseUrl
} from "./public-url.js";

interface RequestWithAuth extends Request {
  auth: ApiKeyAuth;
}

interface DraftRow {
  id: string;
  account_id: string;
  title: string;
  current_version_id: string | null;
  repo_org: string | null;
  repo_name: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  disabled_at: Date | null;
  disabled_reason: string | null;
}

interface DraftVersionRow {
  id: string;
  draft_id: string;
  version_number: number;
  object_key: string;
  content_hash: string;
  file_size: number;
  created_at: Date;
  created_by_api_key_id: string;
  source_ip: string | null;
  user_agent: string | null;
  cli_version: string | null;
  git_branch: string | null;
  git_commit_sha: string | null;
  original_filename: string | null;
}

type JsonRecord = Record<string, unknown>;

export function createApp(): express.Express {
  const app = express();
  app.set("trust proxy", true);

  const uploadIpRateLimit = createRateLimiter({
    windowMs: Number(process.env.UPLOAD_IP_RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.UPLOAD_IP_RATE_LIMIT_MAX || 60),
    keyPrefix: "upload-ip",
    key: (req) => req.ip || "anonymous"
  });

  const uploadKeyRateLimit = createRateLimiter({
    windowMs: Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.UPLOAD_RATE_LIMIT_MAX || 30),
    keyPrefix: "upload-key",
    key: (req) => req.auth?.id || req.ip || "anonymous"
  });

  app.use(express.json({ limit: process.env.UPLOAD_BODY_LIMIT || "2mb" }));
  app.use(noStoreHeaders);

  app.get("/", async (req, res, next) => {
    try {
      const draftId = getDraftIdFromRequest(req);
      if (draftId) {
        await renderDraft(req, res, { draftId });
        return;
      }

      res.type("html").send(renderHome({ publicBaseUrl: getHomeUrlForRequest(req) }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/healthz", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true });
    } catch (error) {
      res.status(503).json({
        ok: false,
        error: error instanceof Error ? error.message : "Health check failed."
      });
    }
  });

  app.get("/api/me", requireAuth, (req, res) => {
    const auth = (req as RequestWithAuth).auth;
    res.json({
      accountId: auth.account_id,
      accountName: auth.account_name,
      apiKeyId: auth.id,
      apiKeyName: auth.name
    });
  });

  app.post("/api/api-keys", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const token = `pp_${randomToken(32)}`;
      const apiKeyId = newInternalId();
      const name = cleanText(isRecord(req.body) ? req.body.name : null) || "CLI API Key";

      await pool.query(
        `
          INSERT INTO api_keys (id, account_id, name, key_hash)
          VALUES ($1, $2, $3, $4)
        `,
        [apiKeyId, auth.account_id, name, sha256(token)]
      );

      res.status(201).json({
        ok: true,
        apiKey: {
          id: apiKeyId,
          name
        },
        token
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/api-keys/:apiKeyId/revoke", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const result = await pool.query(
        `
          UPDATE api_keys
          SET revoked_at = now()
          WHERE id = $1
            AND account_id = $2
            AND revoked_at IS NULL
          RETURNING id
        `,
        [req.params.apiKeyId, auth.account_id]
      );

      if (!result.rowCount) {
        res.status(404).json({ ok: false, error: "API key not found." });
        return;
      }

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/uploads",
    uploadIpRateLimit,
    optionalUploadAuth,
    uploadKeyRateLimit,
    async (req, res, next) => {
      try {
        const auth = (req as RequestWithAuth).auth;
        const body = isRecord(req.body) ? req.body : {};
        const { html } = body;
        const filename = typeof body.filename === "string" ? body.filename : null;
        const metadata = isRecord(body.metadata) ? body.metadata : {};
        const submittedDraftId = typeof body.draftId === "string" && body.draftId
          ? body.draftId
          : null;
        const validation = validateHtml(html, { maxBytes: config.maxHtmlBytes });

        if (!validation.ok) {
          res.status(422).json({
            ok: false,
            errors: validation.errors,
            warnings: validation.warnings
          });
          return;
        }

        const htmlDocument = html as string;
        const byteLength = Buffer.byteLength(htmlDocument, "utf8");
        const nowHash = contentHash(htmlDocument);

        const result = await withTransaction(async (client) => {
          const existingDraft = submittedDraftId
            ? await findOwnedDraft(client, submittedDraftId, auth.account_id)
            : null;

          if (submittedDraftId && !existingDraft) {
            const error = new Error("Draft not found.") as Error & { statusCode: number };
            error.statusCode = 404;
            throw error;
          }

          const draftId = existingDraft?.id || newDraftId();
          const accountId = existingDraft?.account_id || auth.account_id;

          const versionNumber = existingDraft
            ? Number(
                (
                  await client.query<{ next_version: number | string }>(
                    "SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM draft_versions WHERE draft_id = $1",
                    [draftId]
                  )
                ).rows[0]?.next_version
              )
            : 1;

          const versionId = newInternalId();
          const objectKey = `drafts/${draftId}/versions/${versionId}.html`;
          const title = validation.title || existingDraft?.title || filename || "Untitled Draft";

          await putHtmlObject(objectKey, htmlDocument);

          if (!existingDraft) {
            await client.query(
              `
                INSERT INTO drafts (id, account_id, title, repo_org, repo_name)
                VALUES ($1, $2, $3, $4, $5)
              `,
              [
                draftId,
                accountId,
                title,
                cleanText(metadata.repoOrg),
                cleanText(metadata.repoName)
              ]
            );
          }

          await client.query(
            `
              INSERT INTO draft_versions (
                id, draft_id, version_number, object_key, content_hash, file_size,
                created_by_api_key_id, source_ip, user_agent, cli_version,
                git_branch, git_commit_sha, original_filename
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            `,
            [
              versionId,
              draftId,
              versionNumber,
              objectKey,
              nowHash,
              byteLength,
              auth.id,
              req.ip,
              req.get("user-agent") || null,
              cleanText(metadata.cliVersion),
              cleanText(metadata.gitBranch),
              cleanText(metadata.gitCommitSha),
              cleanText(filename)
            ]
          );

          await client.query(
            `
              UPDATE drafts
              SET current_version_id = $1,
                  title = $2,
                  repo_org = COALESCE($3, repo_org),
                  repo_name = COALESCE($4, repo_name),
                  updated_at = now()
              WHERE id = $5
            `,
            [versionId, title, cleanText(metadata.repoOrg), cleanText(metadata.repoName), draftId]
          );

          await client.query(
            `
              INSERT INTO upload_events (
                id, draft_id, draft_version_id, api_key_id, event_type,
                source_ip, user_agent, metadata_json
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
              newEventId(),
              draftId,
              versionId,
              auth.id,
              existingDraft ? "draft.updated" : "draft.created",
              req.ip,
              req.get("user-agent") || null,
              metadata
            ]
          );

          return {
            draftId,
            versionId,
            versionNumber,
            title,
            publicUrl: getDraftPublicUrl({
              draftId,
              publicBaseUrl: config.publicBaseUrl,
              requestBaseUrl: getRequestBaseUrl(req)
            }),
            warnings: validation.warnings
          };
        });

        res.status(submittedDraftId ? 200 : 201).json({ ok: true, ...result });
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete("/api/drafts/:draftId", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const result = await pool.query(
        `
          UPDATE drafts
          SET deleted_at = now(), updated_at = now()
          WHERE id = $1
            AND account_id = $2
            AND deleted_at IS NULL
          RETURNING id
        `,
        [req.params.draftId, auth.account_id]
      );

      if (!result.rowCount) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/drafts/:draftId/disable", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const reason = cleanText(isRecord(req.body) ? req.body.reason : null) || "Disabled by owner.";
      const result = await pool.query(
        `
          UPDATE drafts
          SET disabled_at = now(), disabled_reason = $3, updated_at = now()
          WHERE id = $1
            AND account_id = $2
            AND deleted_at IS NULL
          RETURNING id
        `,
        [req.params.draftId, auth.account_id, reason]
      );

      if (!result.rowCount) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/d/:draftId", async (req, res, next) => {
    try {
      await renderDraft(req, res, { draftId: req.params.draftId });
    } catch (error) {
      next(error);
    }
  });

  app.get("/d/:draftId/v/:versionNumber", async (req, res, next) => {
    try {
      await renderDraft(req, res, {
        draftId: req.params.draftId,
        versionNumber: Number(req.params.versionNumber)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/v/:versionNumber", async (req, res, next) => {
    try {
      const draftId = getDraftIdFromRequest(req);
      if (!draftId) {
        next();
        return;
      }

      await renderDraft(req, res, {
        draftId,
        versionNumber: Number(req.params.versionNumber)
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((_req, res) => {
    res.status(404).type("html").send(renderNotFound());
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = getStatusCode(error);
    const message = status >= 500
      ? "Internal server error."
      : error instanceof Error
        ? error.message
        : "Request failed.";
    if (status >= 500) {
      console.error(error);
    }
    res.status(status).json({ ok: false, error: message });
  });

  return app;
}

async function renderDraft(
  req: Request,
  res: Response,
  { draftId, versionNumber }: { draftId: string; versionNumber?: number }
): Promise<void> {
  const { draft, version } = await findPublicDraftVersion(draftId, versionNumber);
  if (!draft || !version) {
    res.status(404).type("html").send(renderNotFound());
    return;
  }

  const html = await getHtmlObject(version.object_key);
  const signedIn = Boolean(await optionalAuth(req));

  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src https: data:",
      "frame-src 'self' about:",
      "base-uri 'none'",
      "form-action 'none'"
    ].join("; ")
  );
  res.type("html").send(
    renderDraftWrapper({
      draft,
      version,
      html,
      signedIn,
      homeUrl: getHomeUrlForRequest(req)
    })
  );
}

async function findPublicDraftVersion(
  draftId: string,
  versionNumber?: number
): Promise<{ draft: DraftRow | null; version: DraftVersionRow | null }> {
  const draftResult = await pool.query<DraftRow>(
    `
      SELECT *
      FROM drafts
      WHERE id = $1
        AND deleted_at IS NULL
        AND disabled_at IS NULL
      LIMIT 1
    `,
    [draftId]
  );

  const draft = draftResult.rows[0] || null;
  if (!draft) return { draft: null, version: null };

  const versionResult = versionNumber
    ? await pool.query<DraftVersionRow>(
        `
          SELECT *
          FROM draft_versions
          WHERE draft_id = $1 AND version_number = $2
          LIMIT 1
        `,
        [draft.id, versionNumber]
      )
    : await pool.query<DraftVersionRow>("SELECT * FROM draft_versions WHERE id = $1 LIMIT 1", [
        draft.current_version_id
      ]);

  return { draft, version: versionResult.rows[0] || null };
}

async function findOwnedDraft(
  client: { query: typeof pool.query },
  draftId: string,
  accountId: string
): Promise<DraftRow | null> {
  const result = await client.query<DraftRow>(
    `
      SELECT *
      FROM drafts
      WHERE id = $1
        AND account_id = $2
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [draftId, accountId]
  );
  return result.rows[0] || null;
}

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = await optionalAuth(req);
  if (!auth) {
    res.status(401).json({ ok: false, error: "Missing or invalid API key." });
    return;
  }
  (req as RequestWithAuth).auth = auth;
  next();
}

async function optionalUploadAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  (req as RequestWithAuth).auth = (await optionalAuth(req)) || publicUploadAuth;
  next();
}

async function optionalAuth(req: Request): Promise<ApiKeyAuth | null> {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return findApiKeyByToken(match[1].trim());
}

function noStoreHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
}

function getHomeUrlForRequest(req: Request): string {
  return getHomeUrl({
    publicBaseUrl: config.publicBaseUrl,
    requestBaseUrl: getRequestBaseUrl(req)
  });
}

function getDraftIdFromRequest(req: Request): string | null {
  return getDraftIdFromHost({
    publicBaseUrl: config.publicBaseUrl,
    host: req.hostname || req.get("host")
  });
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 255) : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getStatusCode(error: unknown): number {
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  ) {
    return error.statusCode;
  }
  return 500;
}
