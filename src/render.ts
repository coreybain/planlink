import * as parse5 from "parse5";
import type { DefaultTreeAdapterMap, DefaultTreeAdapterTypes } from "parse5";

export interface DraftRenderData {
  id: string;
  title: string;
}

export interface DraftVersionRenderData {
  id?: string;
  version_number: number;
  created_at?: Date | string;
  file_size?: number;
  original_filename?: string | null;
}

export interface DraftReviewRenderData {
  draft: {
    draftId: string;
    title: string;
    publicUrl: string;
    repoOrg: string | null;
    repoName: string | null;
    createdAt: string;
    updatedAt: string;
  };
  versions: DraftReviewVersion[];
  currentVersionNumber: number;
  selectedVersionNumber: number;
  canEdit: boolean;
  narration: DraftNarrationSection[];
  questions: DraftReviewQuestion[];
}

export interface DraftReviewVersion {
  versionId: string;
  versionNumber: number;
  versionUrl: string;
  fileSize: number;
  originalFilename: string | null;
  createdAt: string;
  isCurrent: boolean;
  isSelected: boolean;
}

export interface DraftReviewQuestion {
  questionId: string;
  questionText: string;
  createdAt: string;
  updatedAt: string;
  answer: DraftReviewAnswer | null;
}

export interface DraftReviewAnswer {
  answerId: string;
  answerText: string;
  versionNumber: number;
  versionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DraftNarrationSection {
  narrationId: string;
  title: string;
  text: string;
  source: "explicit" | "section";
}

export interface AiPromptInput {
  draftTitle: string;
  versionUrl: string;
  versionNumber: number;
  questionText: string;
  answerText?: string | null;
}

type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlParentNode = DefaultTreeAdapterTypes.ParentNode;

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
  homeUrl = "/",
  review
}: {
  draft: DraftRenderData;
  version: DraftVersionRenderData;
  html: string;
  signedIn: boolean;
  homeUrl?: string;
  review?: DraftReviewRenderData;
}): string {
  const title = escapeHtml(draft.title || "PlanLink Draft");
  const safeHomeUrl = escapeAttribute(homeUrl);
  const reviewData = review || defaultReviewData(draft, version);
  const selectedVersion = reviewData.versions.find((candidate) => candidate.isSelected)
    || reviewData.versions[0];
  const selectedLabel = selectedVersion
    ? `v${selectedVersion.versionNumber}${selectedVersion.isCurrent ? " current" : ""}`
    : `v${Number(version.version_number)}`;
  const iframeHtml = renderIframeSrcdoc(html);
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
      background: #fbfbf8;
      color: #17201b;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    body {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    button,
    input,
    select,
    textarea {
      font: inherit;
    }

    button {
      cursor: pointer;
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
      background: #17201b;
      color: #f8fafc;
      border-bottom: 1px solid #304039;
      font-size: 14px;
      line-height: 1.3;
      flex: 0 0 auto;
    }

    .planlink-banner strong {
      font-weight: 700;
    }

    .planlink-banner span {
      color: #d9e1dc;
    }

    .planlink-banner a {
      color: #f8fafc;
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

    .review-panel {
      flex: 0 0 auto;
      border-top: 1px solid #d8ddd3;
      background: #f4f5ef;
      box-shadow: 0 -10px 28px rgba(23, 32, 27, 0.08);
      color: #17201b;
    }

    .review-bar {
      display: grid;
      grid-template-columns: minmax(150px, 1fr) minmax(150px, auto) auto;
      gap: 10px;
      align-items: center;
      min-height: 54px;
      padding: 8px 14px;
      box-sizing: border-box;
    }

    .review-toggle,
    .review-action,
    .review-copy,
    .review-save {
      min-height: 34px;
      border: 1px solid #bcc9bf;
      border-radius: 6px;
      background: #ffffff;
      color: #17201b;
      padding: 6px 10px;
      text-align: left;
    }

    .review-action,
    .review-save {
      background: #174c43;
      border-color: #174c43;
      color: #ffffff;
      text-align: center;
      white-space: nowrap;
    }

    .review-copy {
      background: #fff9e8;
      border-color: #d7bf73;
      white-space: nowrap;
    }

    .review-version {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      min-width: 0;
      color: #41514a;
      font-size: 13px;
    }

    .review-version select,
    .review-input,
    .review-textarea {
      border: 1px solid #bcc9bf;
      border-radius: 6px;
      background: #ffffff;
      color: #17201b;
      min-height: 34px;
      padding: 6px 8px;
      box-sizing: border-box;
    }

    .review-status {
      color: #52645a;
      font-size: 13px;
      white-space: nowrap;
    }

    .review-body {
      display: grid;
      grid-template-columns: minmax(220px, 300px) minmax(0, 1fr);
      gap: 14px;
      max-height: min(54vh, 560px);
      overflow: auto;
      padding: 0 14px 14px;
      box-sizing: border-box;
    }

    .review-body[hidden] {
      display: none;
    }

    .review-tools {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }

    .question-composer {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 0;
    }

    .review-textarea {
      width: 100%;
    }

    .review-textarea {
      resize: vertical;
      min-height: 86px;
      line-height: 1.45;
    }

    .question-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-width: 0;
    }

    .question-card {
      border: 1px solid #d8ddd3;
      border-radius: 8px;
      background: #ffffff;
      padding: 12px;
      box-sizing: border-box;
    }

    .question-head {
      display: flex;
      gap: 10px;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 8px;
    }

    .question-title {
      margin: 0;
      font-size: 15px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    .question-meta,
    .answer-meta,
    .review-empty {
      color: #52645a;
      font-size: 13px;
      line-height: 1.4;
    }

    .answer-text {
      margin: 8px 0 0;
      color: #25352e;
      font-size: 14px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .answer-editor {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }

    @media (max-width: 720px) {
      .review-bar {
        grid-template-columns: 1fr;
        align-items: stretch;
      }

      .review-version {
        justify-content: space-between;
      }

      .review-body {
        grid-template-columns: 1fr;
        max-height: 62vh;
      }
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
    srcdoc="${escapeAttribute(iframeHtml)}"></iframe>
  <section class="review-panel" id="planlink-review-panel" data-open="false">
    <div class="review-bar">
      <button class="review-toggle" id="review-toggle" type="button" aria-expanded="false">
        Review Q&amp;A
      </button>
      <label class="review-version">
        <span>Version</span>
        <select id="review-version-select">
          ${renderVersionOptions(reviewData.versions)}
        </select>
      </label>
      <span class="review-status" id="review-status">${escapeHtml(selectedLabel)}</span>
    </div>
    <div class="review-body" id="review-body" hidden>
      <div class="review-tools">
        <div class="question-composer" id="question-composer">
          <textarea class="review-textarea" id="question-text" placeholder="Ask a question or suggest a change"></textarea>
          <button class="review-action" id="question-save" type="button">Add question</button>
        </div>
      </div>
      <div class="question-list" id="question-list"></div>
    </div>
  </section>
  <script type="application/json" id="planlink-review-data">${serializeJsonForScript(reviewData)}</script>
  <script>
    (function () {
      var state = JSON.parse(document.getElementById("planlink-review-data").textContent || "{}");
      var storageKey = "planlink.ownerApiKey";
      var panel = document.getElementById("planlink-review-panel");
      var toggle = document.getElementById("review-toggle");
      var body = document.getElementById("review-body");
      var status = document.getElementById("review-status");
      var versionSelect = document.getElementById("review-version-select");
      var composer = document.getElementById("question-composer");
      var questionText = document.getElementById("question-text");
      var questionSave = document.getElementById("question-save");
      var questionList = document.getElementById("question-list");

      function getOwnerKey() {
        try {
          return window.localStorage.getItem(storageKey) || "";
        } catch (_error) {
          return "";
        }
      }

      function setOwnerKey(value) {
        try {
          if (value) window.localStorage.setItem(storageKey, value);
          else window.localStorage.removeItem(storageKey);
        } catch (_error) {}
      }

      function selectedVersion() {
        return state.versions.find(function (version) { return version.isSelected; }) || state.versions[0];
      }

      function setStatus(message) {
        status.textContent = message;
      }

      function authHeaders() {
        var token = getOwnerKey();
        var headers = { "Content-Type": "application/json" };
        if (token) headers.Authorization = "Bearer " + token;
        return headers;
      }

      async function refreshReview() {
        var versionNumber = encodeURIComponent(String(state.selectedVersionNumber));
        var response = await fetch("/api/drafts/" + encodeURIComponent(state.draft.draftId) + "?versionNumber=" + versionNumber, {
          headers: authHeaders()
        });
        var body = await response.json();
        if (!response.ok) throw new Error(body.error || "Unable to load review data.");
        state = {
          draft: body.draft,
          versions: body.versions,
          currentVersionNumber: body.currentVersionNumber,
          selectedVersionNumber: body.selectedVersionNumber,
          canEdit: Boolean(body.canEdit),
          narration: body.narration || state.narration || [],
          questions: body.questions || []
        };
        renderReview();
      }

      async function apiRequest(url, payload) {
        var token = getOwnerKey();
        if (!token) throw new Error("Owner access required.");
        return postJson(url, payload, authHeaders());
      }

      async function publicRequest(url, payload) {
        return postJson(url, payload, { "Content-Type": "application/json" });
      }

      async function postJson(url, payload, headers) {
        var response = await fetch(url, {
          method: "POST",
          headers: headers,
          body: JSON.stringify(payload)
        });
        var body = await response.json();
        if (!response.ok) throw new Error(body.error || "Request failed.");
        return body;
      }

      function renderReview() {
        var version = selectedVersion();
        versionSelect.innerHTML = "";
        state.versions.forEach(function (candidate) {
          var option = document.createElement("option");
          option.value = candidate.versionUrl;
          option.textContent = "v" + candidate.versionNumber + (candidate.isCurrent ? " current" : "");
          option.selected = candidate.isSelected;
          versionSelect.appendChild(option);
        });

        composer.hidden = false;
        setStatus(state.canEdit ? "Owner mode" : "v" + (version ? version.versionNumber : state.selectedVersionNumber));

        questionList.textContent = "";
        if (!state.questions.length) {
          var empty = document.createElement("p");
          empty.className = "review-empty";
          empty.textContent = "No questions yet.";
          questionList.appendChild(empty);
          return;
        }

        state.questions.forEach(function (question) {
          questionList.appendChild(renderQuestion(question));
        });
      }

      function renderQuestion(question) {
        var article = document.createElement("article");
        article.className = "question-card";

        var head = document.createElement("div");
        head.className = "question-head";

        var title = document.createElement("h3");
        title.className = "question-title";
        title.textContent = question.questionText;
        head.appendChild(title);

        var copyButton = document.createElement("button");
        copyButton.className = "review-copy";
        copyButton.type = "button";
        copyButton.textContent = "Copy AI prompt";
        copyButton.addEventListener("click", async function () {
          await copyText(buildPrompt(question));
          setStatus("Prompt copied");
        });
        head.appendChild(copyButton);
        article.appendChild(head);

        var meta = document.createElement("div");
        meta.className = "question-meta";
        meta.textContent = question.answer ? "Answered on v" + question.answer.versionNumber : "Open";
        article.appendChild(meta);

        if (question.answer) {
          var answer = document.createElement("p");
          answer.className = "answer-text";
          answer.textContent = question.answer.answerText;
          article.appendChild(answer);
        }

        if (state.canEdit) {
          var editor = document.createElement("div");
          editor.className = "answer-editor";

          var textarea = document.createElement("textarea");
          textarea.className = "review-textarea";
          textarea.placeholder = "Save an answer";
          textarea.value = question.answer ? question.answer.answerText : "";
          editor.appendChild(textarea);

          var save = document.createElement("button");
          save.className = "review-save";
          save.type = "button";
          save.textContent = "Save answer";
          save.addEventListener("click", async function () {
            try {
              await apiRequest(
                "/api/drafts/" + encodeURIComponent(state.draft.draftId)
                  + "/questions/" + encodeURIComponent(question.questionId) + "/answers",
                {
                  answerText: textarea.value,
                  versionNumber: state.selectedVersionNumber
                }
              );
              await refreshReview();
              setStatus("Answer saved");
            } catch (error) {
              setStatus(error.message || "Could not save answer");
            }
          });
          editor.appendChild(save);
          article.appendChild(editor);
        }

        return article;
      }

      function buildPrompt(question) {
        var version = selectedVersion();
        return [
          "Please update the plan based on this reviewer question.",
          "",
          "Plan: " + state.draft.title,
          "Draft URL: " + (version ? version.versionUrl : state.draft.publicUrl),
          "Selected version: v" + state.selectedVersionNumber,
          "",
          "Question:",
          question.questionText,
          "",
          "Current saved answer:",
          question.answer && question.answer.answerText ? question.answer.answerText : "(none yet)",
          "",
          "Return an updated plan and explain the changes you made."
        ].join("\\n");
      }

      async function copyText(value) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          return;
        }
        var textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }

      toggle.addEventListener("click", function () {
        var open = panel.getAttribute("data-open") !== "true";
        panel.setAttribute("data-open", open ? "true" : "false");
        toggle.setAttribute("aria-expanded", String(open));
        body.hidden = !open;
      });

      versionSelect.addEventListener("change", function () {
        window.location.href = versionSelect.value;
      });

      questionSave.addEventListener("click", async function () {
        try {
          await publicRequest("/api/drafts/" + encodeURIComponent(state.draft.draftId) + "/questions", {
            questionText: questionText.value
          });
          questionText.value = "";
          await refreshReview();
          setStatus("Question added");
        } catch (error) {
          setStatus(error.message || "Could not add question");
        }
      });

      if (window.location.hash === "#review") {
        panel.setAttribute("data-open", "true");
        toggle.setAttribute("aria-expanded", "true");
        body.hidden = false;
      }
      if (getOwnerKey()) {
        refreshReview().catch(function () {
          setOwnerKey("");
          renderReview();
        });
      } else {
        renderReview();
      }
    })();
  </script>
  <noscript></noscript>
  <!-- draft:${escapeHtml(draft.id)} version:${Number(version.version_number)} -->
</body>
</html>`;
}

function renderIframeSrcdoc(html: string): string {
  const document = parse5.parse<DefaultTreeAdapterMap>(html);
  const htmlNode = findChildElement(document, "html");
  const head = htmlNode ? findChildElement(htmlNode, "head") : findChildElement(document, "head");

  if (!head) return `<base href="about:srcdoc">\n${html}`;
  if (!hasBaseElement(head)) {
    head.childNodes.unshift({
      nodeName: "base",
      tagName: "base",
      attrs: [{ name: "href", value: "about:srcdoc" }],
      namespaceURI: "http://www.w3.org/1999/xhtml" as HtmlElement["namespaceURI"],
      parentNode: head,
      childNodes: []
    });
  }

  return parse5.serialize(document);
}

function findChildElement(node: HtmlParentNode, tagName: string): HtmlElement | undefined {
  return node.childNodes.find((child): child is HtmlElement => (
    "tagName" in child && child.tagName.toLowerCase() === tagName
  ));
}

function hasBaseElement(node: HtmlParentNode): boolean {
  return node.childNodes.some((child) => "tagName" in child && child.tagName.toLowerCase() === "base");
}

export function buildAiPrompt({
  draftTitle,
  versionUrl,
  versionNumber,
  questionText,
  answerText
}: AiPromptInput): string {
  return [
    "Please update the plan based on this reviewer question.",
    "",
    `Plan: ${draftTitle}`,
    `Draft URL: ${versionUrl}`,
    `Selected version: v${versionNumber}`,
    "",
    "Question:",
    questionText,
    "",
    "Current saved answer:",
    answerText || "(none yet)",
    "",
    "Return an updated plan and explain the changes you made."
  ].join("\n");
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

function renderVersionOptions(versions: DraftReviewVersion[]): string {
  return versions.map((version) => {
    const label = `v${version.versionNumber}${version.isCurrent ? " current" : ""}`;
    return `
            <option value="${escapeAttribute(version.versionUrl)}"${version.isSelected ? " selected" : ""}>
              ${escapeHtml(label)}
            </option>`;
  }).join("");
}

function defaultReviewData(
  draft: DraftRenderData,
  version: DraftVersionRenderData
): DraftReviewRenderData {
  const versionNumber = Number(version.version_number);
  return {
    draft: {
      draftId: draft.id,
      title: draft.title,
      publicUrl: "#",
      repoOrg: null,
      repoName: null,
      createdAt: "",
      updatedAt: ""
    },
    versions: [
      {
        versionId: version.id || String(versionNumber),
        versionNumber,
        versionUrl: "#",
        fileSize: version.file_size || 0,
        originalFilename: version.original_filename || null,
        createdAt: dateToIso(version.created_at),
        isCurrent: true,
        isSelected: true
      }
    ],
    currentVersionNumber: versionNumber,
    selectedVersionNumber: versionNumber,
    canEdit: false,
    narration: [],
    questions: []
  };
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

function dateToIso(value: Date | string | undefined): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : value;
}

function serializeJsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
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
