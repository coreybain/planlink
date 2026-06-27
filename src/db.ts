import { Pool, type PoolClient } from "pg";
import { config, requireEnv } from "./config.js";
import { sha256 } from "./crypto.js";
import { newInternalId } from "./ids.js";

export interface ApiKeyAuth {
  id: string;
  account_id: string;
  name: string;
  account_name: string;
}

export const publicUploadAuth: ApiKeyAuth = {
  id: "key_public_upload",
  account_id: "acct_public_upload",
  name: "Public Uploads",
  account_name: "Public Uploads"
};

export const pool = new Pool({
  connectionString: requireEnv("DATABASE_URL", config.databaseUrl)
});

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      title TEXT NOT NULL,
      current_version_id TEXT,
      repo_org TEXT,
      repo_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ,
      disabled_at TIMESTAMPTZ,
      disabled_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS draft_versions (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL REFERENCES drafts(id),
      version_number INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_by_api_key_id TEXT NOT NULL REFERENCES api_keys(id),
      source_ip TEXT,
      user_agent TEXT,
      cli_version TEXT,
      git_branch TEXT,
      git_commit_sha TEXT,
      original_filename TEXT,
      UNIQUE (draft_id, version_number)
    );

    CREATE TABLE IF NOT EXISTS upload_events (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL REFERENCES drafts(id),
      draft_version_id TEXT REFERENCES draft_versions(id),
      api_key_id TEXT NOT NULL REFERENCES api_keys(id),
      event_type TEXT NOT NULL,
      source_ip TEXT,
      user_agent TEXT,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS draft_versions_draft_id_idx ON draft_versions(draft_id);
    CREATE INDEX IF NOT EXISTS upload_events_draft_id_idx ON upload_events(draft_id);
  `);

  await ensurePublicUploadApiKey();
}

export async function ensureBootstrapApiKey(): Promise<void> {
  if (!config.bootstrapApiKey) return;

  const accountId = "acct_bootstrap";
  const apiKeyId = "key_bootstrap";
  const keyHash = sha256(config.bootstrapApiKey);

  await pool.query(
    `
      INSERT INTO accounts (id, name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET updated_at = now()
    `,
    [accountId, "Bootstrap Account"]
  );

  await pool.query(
    `
      INSERT INTO api_keys (id, account_id, name, key_hash)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE
        SET key_hash = EXCLUDED.key_hash,
            name = EXCLUDED.name,
            revoked_at = NULL
    `,
    [apiKeyId, accountId, "Bootstrap API Key", keyHash]
  );
}

export async function findApiKeyByToken(token: string): Promise<ApiKeyAuth | null> {
  const keyHash = sha256(token);
  const result = await pool.query<ApiKeyAuth>(
    `
      SELECT api_keys.id, api_keys.account_id, api_keys.name, accounts.name AS account_name
      FROM api_keys
      JOIN accounts ON accounts.id = api_keys.account_id
      WHERE api_keys.key_hash = $1
        AND api_keys.id <> $2
        AND api_keys.revoked_at IS NULL
      LIMIT 1
    `,
    [keyHash, publicUploadAuth.id]
  );

  const apiKey = result.rows[0] || null;
  if (apiKey) {
    await pool.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [apiKey.id]);
  }
  return apiKey;
}

async function ensurePublicUploadApiKey(): Promise<void> {
  await pool.query(
    `
      INSERT INTO accounts (id, name)
      VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            updated_at = now()
    `,
    [publicUploadAuth.account_id, publicUploadAuth.account_name]
  );

  await pool.query(
    `
      INSERT INTO api_keys (id, account_id, name, key_hash)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE
        SET key_hash = EXCLUDED.key_hash,
            name = EXCLUDED.name,
            revoked_at = NULL
    `,
    [
      publicUploadAuth.id,
      publicUploadAuth.account_id,
      publicUploadAuth.name,
      sha256("planlink-public-upload-sentinel")
    ]
  );
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function newEventId(): string {
  return newInternalId();
}
