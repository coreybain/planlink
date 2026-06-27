export interface DraftRenderData {
  id: string;
  title: string;
}

export interface DraftVersionRenderData {
  version_number: number;
}

export function renderHome({ publicBaseUrl }: { publicBaseUrl: string }): string {
  return htmlPage({
    title: "PlanLink",
    body: `
      <main class="home">
        <h1>PlanLink</h1>
        <p>Authenticated static HTML draft publishing for agents.</p>
        <pre>bunx planlink upload ./plan.html</pre>
        <p>Health: <a href="/healthz">/healthz</a></p>
        <p>Public base URL: ${escapeHtml(publicBaseUrl || "not configured")}</p>
      </main>
    `
  });
}

export function renderDraftWrapper({
  draft,
  version,
  html,
  signedIn,
  homeUrl = "/"
}: {
  draft: DraftRenderData;
  version: DraftVersionRenderData;
  html: string;
  signedIn: boolean;
  homeUrl?: string;
}): string {
  const title = escapeHtml(draft.title || "PlanLink Draft");
  const safeHomeUrl = escapeAttribute(homeUrl);
  const banner = signedIn
    ? ""
    : `
      <header class="planlink-banner">
        <strong>PlanLink</strong>
        <span>This is a hosted draft.</span>
        <a href="${safeHomeUrl}" target="_blank" rel="noreferrer">Learn more</a>
      </header>
    `;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    html, body {
      height: 100%;
      margin: 0;
      background: #ffffff;
      color: #111827;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .planlink-banner {
      position: relative;
      z-index: 2147483647;
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 42px;
      padding: 8px 14px;
      box-sizing: border-box;
      background: #111827;
      color: #ffffff;
      border-bottom: 1px solid #374151;
      font-size: 14px;
      line-height: 1.3;
      flex: 0 0 auto;
    }

    .planlink-banner strong {
      font-weight: 700;
    }

    .planlink-banner span {
      color: #d1d5db;
    }

    .planlink-banner a {
      color: #ffffff;
      text-decoration: underline;
      text-underline-offset: 3px;
      margin-left: auto;
      white-space: nowrap;
    }

    .draft-frame {
      display: block;
      width: 100%;
      min-height: 0;
      flex: 1 1 auto;
      border: 0;
      background: #ffffff;
    }
  </style>
</head>
<body>
  ${banner}
  <iframe
    class="draft-frame"
    title="${title}"
    sandbox=""
    referrerpolicy="no-referrer"
    srcdoc="${escapeAttribute(html)}"></iframe>
  <noscript></noscript>
  <!-- draft:${escapeHtml(draft.id)} version:${Number(version.version_number)} -->
</body>
</html>`;
}

export function renderNotFound(): string {
  return htmlPage({
    title: "Draft not found",
    body: `
      <main class="home">
        <h1>Draft not found</h1>
        <p>The requested draft is unavailable.</p>
      </main>
    `
  });
}

function htmlPage({ title, body }: { title: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      margin: 0;
      background: #f8fafc;
      color: #111827;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .home {
      max-width: 760px;
      margin: 64px auto;
      padding: 0 20px;
    }

    h1 {
      margin: 0 0 12px;
      font-size: 40px;
      line-height: 1.1;
    }

    p {
      color: #374151;
      font-size: 17px;
      line-height: 1.6;
    }

    pre {
      overflow-x: auto;
      padding: 14px;
      border: 1px solid #d1d5db;
      background: #ffffff;
      border-radius: 6px;
    }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}
