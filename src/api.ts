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
import { extractNarrationSections, type NarrationSection } from "./narration.js";
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

interface DraftListRow {
  id: string;
  title: string;
  repo_org: string | null;
  repo_name: string | null;
  created_at: Date;
  updated_at: Date;
  disabled_at: Date | null;
  disabled_reason: string | null;
  version_number: number | null;
  file_size: number | null;
  original_filename: string | null;
  version_created_at: Date | null;
}

interface DraftQuestionRow {
  id: string;
  draft_id: string;
  question_text: string;
  reviewer_name: string;
  anchor_text: string | null;
  anchor_prefix: string | null;
  anchor_suffix: string | null;
  anchor_section_id: string | null;
  resolved_at: Date | null;
  resolved_by_api_key_id: string | null;
  addressed_version_id: string | null;
  created_by_api_key_id: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface DraftQuestionAnswerRow {
  id: string;
  question_id: string;
  draft_version_id: string;
  answer_text: string;
  created_by_api_key_id: string;
  created_at: Date;
  updated_at: Date;
}

interface DraftQuestionListRow {
  id: string;
  question_text: string;
  reviewer_name: string;
  anchor_text: string | null;
  anchor_prefix: string | null;
  anchor_suffix: string | null;
  anchor_section_id: string | null;
  resolved_at: Date | null;
  addressed_version_id: string | null;
  addressed_version_number: number | null;
  created_at: Date;
  updated_at: Date;
  answer_id: string | null;
  answer_text: string | null;
  answer_created_at: Date | null;
  answer_updated_at: Date | null;
  answer_version_number: number | null;
  answer_version_id: string | null;
}

interface DraftRequiredReviewerRow {
  id: string;
  reviewer_name: string;
  created_at: Date;
}

interface DraftApprovalDecisionRow {
  id: string;
  draft_version_id: string;
  version_number: number;
  reviewer_name: string;
  reviewer_name_normalized: string;
  decision: "approve" | "request_changes";
  note: string | null;
  created_at: Date;
}

interface DraftViewerData {
  draft: {
    draftId: string;
    title: string;
    publicUrl: string;
    repoOrg: string | null;
    repoName: string | null;
    createdAt: string;
    updatedAt: string;
  };
  versions: Array<{
    versionId: string;
    versionNumber: number;
    versionUrl: string;
    fileSize: number;
    originalFilename: string | null;
    createdAt: string;
    isCurrent: boolean;
    isSelected: boolean;
  }>;
  currentVersionNumber: number;
  selectedVersionNumber: number;
  canEdit: boolean;
  narration: NarrationSection[];
  approval: {
    requiredReviewers: Array<{
      reviewerId: string;
      reviewerName: string;
      createdAt: string;
    }>;
    decisions: Array<{
      decisionId: string;
      versionId: string;
      versionNumber: number;
      reviewerName: string;
      decision: "approve" | "request_changes";
      note: string | null;
      createdAt: string;
    }>;
    selectedVersionStatus: "not_required" | "pending" | "approved" | "changes_requested";
    approvedCount: number;
    requiredCount: number;
  };
  questions: Array<{
    questionId: string;
    questionText: string;
    reviewerName: string;
    anchor: {
      text: string;
      prefix: string;
      suffix: string;
      sectionId: string | null;
    } | null;
    resolvedAt: string | null;
    addressedVersionNumber: number | null;
    addressedVersionId: string | null;
    createdAt: string;
    updatedAt: string;
    answer: {
      answerId: string;
      answerText: string;
      versionNumber: number;
      versionId: string;
      createdAt: string;
      updatedAt: string;
    } | null;
  }>;
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
        const addressedQuestionIds = Array.isArray(body.addressedQuestionIds)
          ? [...new Set(body.addressedQuestionIds.filter((value): value is string => (
              typeof value === "string" && Boolean(value.trim())
            )).map((value) => value.trim()))].slice(0, 100)
          : [];
        const validation = validateHtml(html, { maxBytes: config.maxHtmlBytes });

        if (addressedQuestionIds.length && !submittedDraftId) {
          res.status(400).json({ ok: false, error: "Addressed feedback requires an existing draft." });
          return;
        }

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

          if (addressedQuestionIds.length) {
            const addressedResult = await client.query<{ id: string }>(
              `
                UPDATE draft_questions
                SET resolved_at = now(),
                    resolved_by_api_key_id = $1,
                    addressed_version_id = $2,
                    updated_at = now()
                WHERE draft_id = $3
                  AND id = ANY($4::text[])
                  AND deleted_at IS NULL
                RETURNING id
              `,
              [auth.id, versionId, draftId, addressedQuestionIds]
            );
            if ((addressedResult.rowCount || 0) !== addressedQuestionIds.length) {
              const error = new Error("One or more feedback IDs were not found on this draft.") as Error & {
                statusCode: number;
              };
              error.statusCode = 400;
              throw error;
            }
          }

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
            addressedQuestionIds,
            warnings: validation.warnings
          };
        });

        res.status(submittedDraftId ? 200 : 201).json({ ok: true, ...result });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get("/api/drafts", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const result = await pool.query<DraftListRow>(
        `
          SELECT
            drafts.id,
            drafts.title,
            drafts.repo_org,
            drafts.repo_name,
            drafts.created_at,
            drafts.updated_at,
            drafts.disabled_at,
            drafts.disabled_reason,
            draft_versions.version_number,
            draft_versions.file_size,
            draft_versions.original_filename,
            draft_versions.created_at AS version_created_at
          FROM drafts
          LEFT JOIN draft_versions ON draft_versions.id = drafts.current_version_id
          WHERE drafts.account_id = $1
            AND drafts.deleted_at IS NULL
          ORDER BY drafts.updated_at DESC
        `,
        [auth.account_id]
      );

      res.json({
        ok: true,
        drafts: result.rows.map((draft) => ({
          draftId: draft.id,
          title: draft.title,
          publicUrl: getDraftPublicUrl({
            draftId: draft.id,
            publicBaseUrl: config.publicBaseUrl,
            requestBaseUrl: getRequestBaseUrl(req)
          }),
          versionNumber: draft.version_number,
          fileSize: draft.file_size,
          originalFilename: draft.original_filename,
          repoOrg: draft.repo_org,
          repoName: draft.repo_name,
          createdAt: draft.created_at,
          updatedAt: draft.updated_at,
          versionCreatedAt: draft.version_created_at,
          disabledAt: draft.disabled_at,
          disabledReason: draft.disabled_reason
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/drafts/:draftId", async (req, res, next) => {
    try {
      const versionNumber = parseOptionalVersionNumber(req.query.versionNumber);
      const auth = await optionalAuth(req);
      const { version, viewer } = await findPublicDraftData(
        req,
        routeParam(req.params.draftId),
        versionNumber,
        auth
      );

      if (!viewer) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      if (version) {
        const html = await getHtmlObject(version.object_key);
        viewer.narration = extractNarrationSections(html);
      }

      res.json({ ok: true, ...viewer });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/drafts/:draftId/feedback", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const draftId = routeParam(req.params.draftId);
      const ownedDraft = await findOwnedDraft(pool, draftId, auth.account_id);
      if (!ownedDraft) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      const { viewer } = await findPublicDraftData(req, draftId, undefined, auth);
      if (!viewer) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      const includeResolved = req.query.status === "all";
      const feedback = includeResolved
        ? viewer.questions
        : viewer.questions.filter((question) => !question.resolvedAt);

      res.json({
        ok: true,
        draft: viewer.draft,
        currentVersionNumber: viewer.currentVersionNumber,
        feedback,
        summary: {
          open: viewer.questions.filter((question) => !question.resolvedAt).length,
          resolved: viewer.questions.filter((question) => question.resolvedAt).length,
          addressed: viewer.questions.filter((question) => question.addressedVersionNumber).length
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/drafts/:draftId/reviewers", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const draftId = routeParam(req.params.draftId);
      const reviewerName = cleanText(isRecord(req.body) ? req.body.reviewerName : null);
      if (!reviewerName) {
        res.status(400).json({ ok: false, error: "Reviewer name is required." });
        return;
      }

      const draft = await findOwnedDraft(pool, draftId, auth.account_id);
      if (!draft) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      const reviewerId = newInternalId();
      const result = await pool.query<DraftRequiredReviewerRow>(
        `
          INSERT INTO draft_required_reviewers (
            id, draft_id, reviewer_name, reviewer_name_normalized, created_by_api_key_id
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (draft_id, reviewer_name_normalized) WHERE deleted_at IS NULL
          DO UPDATE SET reviewer_name = EXCLUDED.reviewer_name
          RETURNING id, reviewer_name, created_at
        `,
        [reviewerId, draft.id, reviewerName, normalizeReviewerName(reviewerName), auth.id]
      );

      res.status(201).json({
        ok: true,
        reviewer: {
          reviewerId: result.rows[0].id,
          reviewerName: result.rows[0].reviewer_name,
          createdAt: toIso(result.rows[0].created_at)
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/drafts/:draftId/reviewers/:reviewerId", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const draftId = routeParam(req.params.draftId);
      const reviewerId = routeParam(req.params.reviewerId);
      const draft = await findOwnedDraft(pool, draftId, auth.account_id);
      if (!draft) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      const result = await pool.query(
        `
          UPDATE draft_required_reviewers
          SET deleted_at = now()
          WHERE id = $1
            AND draft_id = $2
            AND deleted_at IS NULL
          RETURNING id
        `,
        [reviewerId, draft.id]
      );
      if (!result.rowCount) {
        res.status(404).json({ ok: false, error: "Reviewer not found." });
        return;
      }
      res.json({ ok: true, reviewerId });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/drafts/:draftId/approvals", async (req, res, next) => {
    try {
      const draftId = routeParam(req.params.draftId);
      const body = isRecord(req.body) ? req.body : {};
      const submittedReviewerName = cleanText(body.reviewerName);
      const decision = body.decision === "approve" || body.decision === "request_changes"
        ? body.decision
        : null;
      const versionNumber = parseRequiredVersionNumber(body.versionNumber);
      const note = cleanBodyText(body.note, 4000);

      if (!submittedReviewerName || !decision || !versionNumber) {
        res.status(400).json({
          ok: false,
          error: "reviewerName, decision, and a valid versionNumber are required."
        });
        return;
      }

      const draft = await findPublicDraft(draftId);
      if (!draft) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }
      const version = await findDraftVersionByNumber(draft.id, versionNumber);
      if (!version) {
        res.status(404).json({ ok: false, error: "Draft version not found." });
        return;
      }

      const reviewerResult = await pool.query<DraftRequiredReviewerRow>(
        `
          SELECT id, reviewer_name, created_at
          FROM draft_required_reviewers
          WHERE draft_id = $1
            AND deleted_at IS NULL
          ORDER BY created_at ASC
        `,
        [draft.id]
      );
      const normalizedName = normalizeReviewerName(submittedReviewerName);
      const requiredReviewer = reviewerResult.rows.find(
        (reviewer) => normalizeReviewerName(reviewer.reviewer_name) === normalizedName
      );
      if (reviewerResult.rows.length && !requiredReviewer) {
        res.status(403).json({ ok: false, error: "This reviewer is not required for this draft." });
        return;
      }
      const reviewerName = requiredReviewer?.reviewer_name || submittedReviewerName;
      const decisionId = newInternalId();
      await pool.query(
        `
          INSERT INTO draft_approval_decisions (
            id, draft_id, draft_version_id, reviewer_name,
            reviewer_name_normalized, decision, note
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [decisionId, draft.id, version.id, reviewerName, normalizeReviewerName(reviewerName), decision, note]
      );

      res.status(201).json({
        ok: true,
        decisionId,
        approval: await getDraftApprovalData(draft.id, version.id)
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/drafts", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const body = isRecord(req.body) ? req.body : {};

      if (body.confirm !== "delete-all") {
        res.status(400).json({
          ok: false,
          error: 'Missing confirmation. Send {"confirm":"delete-all"}.'
        });
        return;
      }

      const result = await pool.query<{ id: string }>(
        `
          UPDATE drafts
          SET deleted_at = now(), updated_at = now()
          WHERE account_id = $1
            AND deleted_at IS NULL
          RETURNING id
        `,
        [auth.account_id]
      );

      res.json({
        ok: true,
        deletedCount: result.rowCount || 0,
        draftIds: result.rows.map((draft) => draft.id)
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/drafts/:draftId", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const result = await pool.query<{ id: string }>(
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

      res.json({ ok: true, draftId: result.rows[0].id });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/drafts/:draftId/questions", async (req, res, next) => {
    try {
      const draftId = routeParam(req.params.draftId);
      const body = isRecord(req.body) ? req.body : {};
      const questionText = cleanBodyText(body.questionText, 4000);
      const reviewerName = cleanText(body.reviewerName) || "Anonymous reviewer";
      const anchor = isRecord(body.anchor) ? body.anchor : {};
      const anchorText = cleanBodyText(anchor.text, 1000);
      const anchorPrefix = anchorText ? cleanBodyText(anchor.prefix, 200) : null;
      const anchorSuffix = anchorText ? cleanBodyText(anchor.suffix, 200) : null;
      const anchorSectionId = anchorText ? cleanText(anchor.sectionId) : null;

      if (!questionText) {
        res.status(400).json({ ok: false, error: "Question is required." });
        return;
      }

      const draft = await findPublicDraft(draftId);
      if (!draft) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      const questionId = newInternalId();
      const result = await pool.query<DraftQuestionRow>(
        `
          INSERT INTO draft_questions (
            id, draft_id, question_text, reviewer_name,
            anchor_text, anchor_prefix, anchor_suffix, anchor_section_id,
            created_by_api_key_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
        `,
        [
          questionId,
          draft.id,
          questionText,
          reviewerName,
          anchorText,
          anchorPrefix,
          anchorSuffix,
          anchorSectionId,
          publicUploadAuth.id
        ]
      );

      res.status(201).json({
        ok: true,
        question: questionToApi(result.rows[0], null)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/drafts/:draftId/questions/:questionId/answers", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const draftId = routeParam(req.params.draftId);
      const questionId = routeParam(req.params.questionId);
      const body = isRecord(req.body) ? req.body : {};
      const answerText = cleanBodyText(body.answerText, 20_000);
      const versionNumber = parseRequiredVersionNumber(body.versionNumber);

      if (!answerText) {
        res.status(400).json({ ok: false, error: "Answer is required." });
        return;
      }

      if (!versionNumber) {
        res.status(400).json({ ok: false, error: "A valid versionNumber is required." });
        return;
      }

      const draft = await findOwnedDraft(pool, draftId, auth.account_id);
      if (!draft) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      const question = await findDraftQuestion(questionId, draft.id);
      if (!question) {
        res.status(404).json({ ok: false, error: "Question not found." });
        return;
      }

      const version = await findDraftVersionByNumber(draft.id, versionNumber);
      if (!version) {
        res.status(404).json({ ok: false, error: "Draft version not found." });
        return;
      }

      const answerId = newInternalId();
      const answerResult = await pool.query<DraftQuestionAnswerRow>(
        `
          INSERT INTO draft_question_answers (
            id, question_id, draft_version_id, answer_text, created_by_api_key_id
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (question_id) DO UPDATE
            SET draft_version_id = EXCLUDED.draft_version_id,
                answer_text = EXCLUDED.answer_text,
                created_by_api_key_id = EXCLUDED.created_by_api_key_id,
                updated_at = now()
          RETURNING *
        `,
        [answerId, question.id, version.id, answerText, auth.id]
      );

      res.json({
        ok: true,
        answer: answerToApi(answerResult.rows[0], version.version_number)
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/drafts/:draftId/questions/:questionId", requireAuth, async (req, res, next) => {
    try {
      const auth = (req as RequestWithAuth).auth;
      const draftId = routeParam(req.params.draftId);
      const questionId = routeParam(req.params.questionId);
      const body = isRecord(req.body) ? req.body : {};
      const action = cleanText(body.action);

      if (!action || !["resolve", "reopen", "address"].includes(action)) {
        res.status(400).json({ ok: false, error: "Action must be resolve, reopen, or address." });
        return;
      }

      const draft = await findOwnedDraft(pool, draftId, auth.account_id);
      if (!draft) {
        res.status(404).json({ ok: false, error: "Draft not found." });
        return;
      }

      const question = await findDraftQuestion(questionId, draft.id);
      if (!question) {
        res.status(404).json({ ok: false, error: "Question not found." });
        return;
      }

      let addressedVersionId: string | null = null;
      if (action === "address") {
        const versionNumber = parseRequiredVersionNumber(body.versionNumber);
        if (!versionNumber) {
          res.status(400).json({ ok: false, error: "A valid versionNumber is required." });
          return;
        }
        const version = await findDraftVersionByNumber(draft.id, versionNumber);
        if (!version) {
          res.status(404).json({ ok: false, error: "Draft version not found." });
          return;
        }
        addressedVersionId = version.id;
      }

      await pool.query(
        `
          UPDATE draft_questions
          SET resolved_at = CASE WHEN $3 = 'reopen' THEN NULL ELSE now() END,
              resolved_by_api_key_id = CASE WHEN $3 = 'reopen' THEN NULL ELSE $4 END,
              addressed_version_id = CASE WHEN $3 = 'address' THEN $5 ELSE NULL END,
              updated_at = now()
          WHERE id = $1
            AND draft_id = $2
            AND deleted_at IS NULL
        `,
        [question.id, draft.id, action, auth.id, addressedVersionId]
      );

      const updated = (await listDraftQuestions(draft.id)).find((item) => item.questionId === question.id);
      res.json({ ok: true, question: updated });
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

async function findPublicDraft(draftId: string): Promise<DraftRow | null> {
  const result = await pool.query<DraftRow>(
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
  return result.rows[0] || null;
}

async function renderDraft(
  req: Request,
  res: Response,
  { draftId, versionNumber }: { draftId: string; versionNumber?: number }
): Promise<void> {
  const auth = await optionalAuth(req);
  const { draft, version, viewer } = await findPublicDraftData(req, draftId, versionNumber, auth);
  if (!draft || !version || !viewer) {
    res.status(404).type("html").send(renderNotFound());
    return;
  }

  const html = await getHtmlObject(version.object_key);
  viewer.narration = extractNarrationSections(html);

  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "connect-src 'self'",
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
      signedIn: Boolean(auth),
      homeUrl: getHomeUrlForRequest(req),
      review: viewer
    })
  );
}

async function findPublicDraftData(
  req: Request,
  draftId: string,
  versionNumber: number | undefined,
  auth: ApiKeyAuth | null
): Promise<{ draft: DraftRow | null; version: DraftVersionRow | null; viewer: DraftViewerData | null }> {
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
  if (!draft) return { draft: null, version: null, viewer: null };

  const versionsResult = await pool.query<DraftVersionRow>(
    `
      SELECT *
      FROM draft_versions
      WHERE draft_id = $1
      ORDER BY version_number DESC
    `,
    [draft.id]
  );
  const versions = versionsResult.rows;
  const currentVersion = versions.find((candidate) => candidate.id === draft.current_version_id);
  const version = versionNumber
    ? versions.find((candidate) => candidate.version_number === versionNumber) || null
    : currentVersion || null;

  if (!version || !currentVersion) {
    return { draft, version: null, viewer: null };
  }

  const publicUrl = getDraftPublicUrl({
    draftId: draft.id,
    publicBaseUrl: config.publicBaseUrl,
    requestBaseUrl: getRequestBaseUrl(req)
  });
  const questions = await listDraftQuestions(draft.id);
  const approval = await getDraftApprovalData(draft.id, version.id);
  const viewer: DraftViewerData = {
    draft: {
      draftId: draft.id,
      title: draft.title,
      publicUrl,
      repoOrg: draft.repo_org,
      repoName: draft.repo_name,
      createdAt: toIso(draft.created_at),
      updatedAt: toIso(draft.updated_at)
    },
    versions: versions.map((candidate) => ({
      versionId: candidate.id,
      versionNumber: candidate.version_number,
      versionUrl: getVersionPublicUrl(publicUrl, candidate.version_number),
      fileSize: candidate.file_size,
      originalFilename: candidate.original_filename,
      createdAt: toIso(candidate.created_at),
      isCurrent: candidate.id === currentVersion.id,
      isSelected: candidate.id === version.id
    })),
    currentVersionNumber: currentVersion.version_number,
    selectedVersionNumber: version.version_number,
    canEdit: auth?.account_id === draft.account_id,
    narration: [],
    approval,
    questions
  };

  return { draft, version, viewer };
}

async function getDraftApprovalData(
  draftId: string,
  selectedVersionId: string
): Promise<DraftViewerData["approval"]> {
  const [reviewerResult, decisionResult] = await Promise.all([
    pool.query<DraftRequiredReviewerRow>(
      `
        SELECT id, reviewer_name, created_at
        FROM draft_required_reviewers
        WHERE draft_id = $1
          AND deleted_at IS NULL
        ORDER BY created_at ASC
      `,
      [draftId]
    ),
    pool.query<DraftApprovalDecisionRow>(
      `
        SELECT
          draft_approval_decisions.id,
          draft_approval_decisions.draft_version_id,
          draft_versions.version_number,
          draft_approval_decisions.reviewer_name,
          draft_approval_decisions.reviewer_name_normalized,
          draft_approval_decisions.decision,
          draft_approval_decisions.note,
          draft_approval_decisions.created_at
        FROM draft_approval_decisions
        JOIN draft_versions ON draft_versions.id = draft_approval_decisions.draft_version_id
        WHERE draft_approval_decisions.draft_id = $1
        ORDER BY draft_approval_decisions.created_at DESC
      `,
      [draftId]
    )
  ]);

  const requiredReviewers = reviewerResult.rows.map((reviewer) => ({
    reviewerId: reviewer.id,
    reviewerName: reviewer.reviewer_name,
    createdAt: toIso(reviewer.created_at)
  }));
  const decisions = decisionResult.rows.map((decision) => ({
    decisionId: decision.id,
    versionId: decision.draft_version_id,
    versionNumber: decision.version_number,
    reviewerName: decision.reviewer_name,
    decision: decision.decision,
    note: decision.note,
    createdAt: toIso(decision.created_at)
  }));

  const latestByReviewer = new Map<string, DraftApprovalDecisionRow>();
  for (const decision of decisionResult.rows) {
    if (decision.draft_version_id !== selectedVersionId) continue;
    if (!latestByReviewer.has(decision.reviewer_name_normalized)) {
      latestByReviewer.set(decision.reviewer_name_normalized, decision);
    }
  }
  const requiredNames = reviewerResult.rows.map((reviewer) => normalizeReviewerName(reviewer.reviewer_name));
  const latestRequiredDecisions = requiredNames
    .map((name) => latestByReviewer.get(name))
    .filter((decision): decision is DraftApprovalDecisionRow => Boolean(decision));
  const approvedCount = latestRequiredDecisions.filter((decision) => decision.decision === "approve").length;
  const hasChangesRequested = latestRequiredDecisions.some(
    (decision) => decision.decision === "request_changes"
  );
  const selectedVersionStatus = requiredNames.length === 0
    ? "not_required"
    : hasChangesRequested
      ? "changes_requested"
      : approvedCount === requiredNames.length
        ? "approved"
        : "pending";

  return {
    requiredReviewers,
    decisions,
    selectedVersionStatus,
    approvedCount,
    requiredCount: requiredNames.length
  };
}

async function listDraftQuestions(draftId: string): Promise<DraftViewerData["questions"]> {
  const result = await pool.query<DraftQuestionListRow>(
    `
      SELECT
        draft_questions.id,
        draft_questions.question_text,
        draft_questions.reviewer_name,
        draft_questions.anchor_text,
        draft_questions.anchor_prefix,
        draft_questions.anchor_suffix,
        draft_questions.anchor_section_id,
        draft_questions.resolved_at,
        draft_questions.addressed_version_id,
        addressed_versions.version_number AS addressed_version_number,
        draft_questions.created_at,
        draft_questions.updated_at,
        draft_question_answers.id AS answer_id,
        draft_question_answers.answer_text,
        draft_question_answers.created_at AS answer_created_at,
        draft_question_answers.updated_at AS answer_updated_at,
        draft_question_answers.draft_version_id AS answer_version_id,
        draft_versions.version_number AS answer_version_number
      FROM draft_questions
      LEFT JOIN draft_question_answers
        ON draft_question_answers.question_id = draft_questions.id
      LEFT JOIN draft_versions
        ON draft_versions.id = draft_question_answers.draft_version_id
      LEFT JOIN draft_versions AS addressed_versions
        ON addressed_versions.id = draft_questions.addressed_version_id
      WHERE draft_questions.draft_id = $1
        AND draft_questions.deleted_at IS NULL
      ORDER BY draft_questions.created_at ASC
    `,
    [draftId]
  );

  return result.rows.map((question) => ({
    questionId: question.id,
    questionText: question.question_text,
    reviewerName: question.reviewer_name,
    anchor: question.anchor_text
      ? {
          text: question.anchor_text,
          prefix: question.anchor_prefix || "",
          suffix: question.anchor_suffix || "",
          sectionId: question.anchor_section_id
        }
      : null,
    resolvedAt: question.resolved_at ? toIso(question.resolved_at) : null,
    addressedVersionNumber: question.addressed_version_number,
    addressedVersionId: question.addressed_version_id,
    createdAt: toIso(question.created_at),
    updatedAt: toIso(question.updated_at),
    answer: question.answer_id && question.answer_text && question.answer_version_number && question.answer_version_id
      ? {
          answerId: question.answer_id,
          answerText: question.answer_text,
          versionNumber: question.answer_version_number,
          versionId: question.answer_version_id,
          createdAt: toIso(question.answer_created_at),
          updatedAt: toIso(question.answer_updated_at)
        }
      : null
  }));
}

async function findDraftQuestion(questionId: string, draftId: string): Promise<DraftQuestionRow | null> {
  const result = await pool.query<DraftQuestionRow>(
    `
      SELECT *
      FROM draft_questions
      WHERE id = $1
        AND draft_id = $2
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [questionId, draftId]
  );
  return result.rows[0] || null;
}

async function findDraftVersionByNumber(
  draftId: string,
  versionNumber: number
): Promise<DraftVersionRow | null> {
  const result = await pool.query<DraftVersionRow>(
    `
      SELECT *
      FROM draft_versions
      WHERE draft_id = $1
        AND version_number = $2
      LIMIT 1
    `,
    [draftId, versionNumber]
  );
  return result.rows[0] || null;
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

function cleanBodyText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function normalizeReviewerName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

function parseOptionalVersionNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return parseRequiredVersionNumber(value);
}

function parseRequiredVersionNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function questionToApi(
  question: DraftQuestionRow,
  answer: DraftViewerData["questions"][number]["answer"]
): DraftViewerData["questions"][number] {
  return {
    questionId: question.id,
    questionText: question.question_text,
    reviewerName: question.reviewer_name,
    anchor: question.anchor_text
      ? {
          text: question.anchor_text,
          prefix: question.anchor_prefix || "",
          suffix: question.anchor_suffix || "",
          sectionId: question.anchor_section_id
        }
      : null,
    resolvedAt: question.resolved_at ? toIso(question.resolved_at) : null,
    addressedVersionNumber: null,
    addressedVersionId: question.addressed_version_id,
    createdAt: toIso(question.created_at),
    updatedAt: toIso(question.updated_at),
    answer
  };
}

function answerToApi(
  answer: DraftQuestionAnswerRow,
  versionNumber: number
): NonNullable<DraftViewerData["questions"][number]["answer"]> {
  return {
    answerId: answer.id,
    answerText: answer.answer_text,
    versionNumber,
    versionId: answer.draft_version_id,
    createdAt: toIso(answer.created_at),
    updatedAt: toIso(answer.updated_at)
  };
}

function getVersionPublicUrl(publicUrl: string, versionNumber: number): string {
  return `${publicUrl}/v/${versionNumber}`;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : value;
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
