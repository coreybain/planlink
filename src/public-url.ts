const DRAFT_ID_PATTERN = /^[a-z0-9]{12}$/;

export interface RequestBaseUrlInput {
  get(header: string): string | undefined;
  protocol?: string;
}

export interface PublicUrlInput {
  publicBaseUrl?: string;
  requestBaseUrl?: string;
}

export interface DraftPublicUrlInput extends PublicUrlInput {
  draftId: string;
}

export interface DraftIdFromHostInput {
  publicBaseUrl?: string;
  host?: string;
}

export function getRequestBaseUrl(req: RequestBaseUrlInput): string {
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = forwardedProto
    ? forwardedProto.split(",")[0]?.trim() || "http"
    : req.protocol || "http";
  return `${protocol}://${req.get("host")}`;
}

export function getHomeUrl({ publicBaseUrl, requestBaseUrl }: PublicUrlInput): string {
  const configured = normalizeUrl(publicBaseUrl);
  const wildcard = parseWildcardBaseUrl(configured);

  if (wildcard) {
    wildcard.hostname = wildcard.hostname.slice(2);
    wildcard.pathname = "/";
    wildcard.search = "";
    wildcard.hash = "";
    return stripTrailingSlash(wildcard.toString());
  }

  return configured || normalizeUrl(requestBaseUrl);
}

export function getDraftPublicUrl({
  draftId,
  publicBaseUrl,
  requestBaseUrl
}: DraftPublicUrlInput): string {
  const configured = normalizeUrl(publicBaseUrl);
  const wildcard = parseWildcardBaseUrl(configured);

  if (wildcard) {
    wildcard.hostname = `${draftId}.${wildcard.hostname.slice(2)}`;
    wildcard.pathname = "/";
    wildcard.search = "";
    wildcard.hash = "";
    return stripTrailingSlash(wildcard.toString());
  }

  const baseUrl = configured || normalizeUrl(requestBaseUrl);
  return `${baseUrl}/d/${draftId}`;
}

export function getDraftIdFromHost({ publicBaseUrl, host }: DraftIdFromHostInput): string | null {
  const wildcard = parseWildcardBaseUrl(publicBaseUrl);
  if (!wildcard) return null;

  const rootHost = wildcard.hostname.slice(2).toLowerCase();
  const requestHost = parseHost(host);
  if (!requestHost || !requestHost.endsWith(`.${rootHost}`)) return null;

  const draftId = requestHost.slice(0, -(rootHost.length + 1));
  if (draftId.includes(".") || !DRAFT_ID_PATTERN.test(draftId)) return null;
  return draftId;
}

function parseWildcardBaseUrl(value: string | undefined): URL | null {
  const url = parseUrl(value);
  if (!url || !url.hostname.startsWith("*.")) return null;
  return url;
}

function parseHost(value: string | undefined): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;

  try {
    return new URL(`http://${normalized}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseUrl(value: string | undefined): URL | null {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;

  try {
    return new URL(normalized);
  } catch {
    return null;
  }
}

function normalizeUrl(value: string | undefined): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\/+$/, "");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
