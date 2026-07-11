import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildAiPrompt, renderDraftWrapper, type DraftReviewRenderData } from "../src/render.js";

test("renders uploaded HTML directly and strips active content", () => {
  const rendered = renderDraftWrapper({
    draft: { id: "abc123def456", title: "Draft <Title>" },
    version: { version_number: 3 },
    html: `<h1 onclick="alert(1)">Plan</h1><script>alert(1)</script>`,
    signedIn: false,
    homeUrl: "https://planlink.example"
  });

  assert.match(rendered, /<header class="planlink-banner">/);
  assert.match(rendered, /<h1>Plan<\/h1>/);
  assert.doesNotMatch(rendered, /<iframe/);
  assert.doesNotMatch(rendered, /onclick=/);
  assert.doesNotMatch(rendered, /<script>alert\(1\)<\/script>/);
  assert.match(rendered, /Draft &lt;Title&gt;/);
  assert.match(rendered, /draft:abc123def456 version:3/);
});

test("preserves plan styles and fragment links in the server-rendered document", () => {
  const rendered = renderDraftWrapper({
    draft: { id: "abc123def456", title: "Draft" },
    version: { version_number: 1 },
    html: `<!doctype html><html lang="en" class="theme"><head><title>Plan</title><style>.plan { color: red; }</style></head><body class="plan"><a href="#scope">Scope</a><h2 id="scope">Scope</h2></body></html>`,
    signedIn: false
  });

  assert.match(rendered, /<html lang="en" class="theme">/);
  assert.match(rendered, /<body class="plan">/);
  assert.match(rendered, /<style>\.plan \{ color: red; \}<\/style>/);
  assert.match(rendered, /href="#scope"/);
  assert.doesNotMatch(rendered, /about:srcdoc/);
});

test("renders plan links in the top-level document", () => {
  const rendered = renderDraftWrapper({
    draft: { id: "abc123def456", title: "Draft" },
    version: { version_number: 1 },
    html: `<!doctype html><html><body>
      <a href="https://planlink.example/d/next-plan">Next plan</a>
      <a href="/d/another-plan" target="_self">Another plan</a>
    </body></html>`,
    signedIn: false
  });

  assert.match(rendered, /href="https:\/\/planlink\.example\/d\/next-plan" target="_top"/);
  assert.match(rendered, /href="\/d\/another-plan" target="_top"/);
  assert.doesNotMatch(rendered, /draft-frame/);
});

test("renders review Q&A and version controls after the plan content", () => {
  const rendered = renderDraftWrapper({
    draft: { id: "abc123def456", title: "Draft" },
    version: { version_number: 2 },
    html: "<p>Plan</p>",
    signedIn: false,
    review: reviewFixture()
  });

  assert.match(rendered, /id="planlink-review-panel"/);
  assert.match(rendered, /id="review-version-select"/);
  assert.match(rendered, /Copy AI prompt/);
  assert.match(rendered, /Copy all unresolved feedback/);
  assert.match(rendered, /Feedback ID:/);
  assert.match(rendered, /Save answer/);
  assert.match(rendered, /Ask a question or suggest a change/);
  assert.match(rendered, /Add feedback/);
  assert.match(rendered, /id="reviewer-name"/);
  assert.match(rendered, /id="selection-context"/);
  assert.match(rendered, /Addressed in v/);
  assert.match(rendered, /planlink-feedback-anchor/);
  assert.doesNotMatch(rendered, /Audio run-through/);
  assert.doesNotMatch(rendered, /id="narration-select"/);
  assert.doesNotMatch(rendered, /Owner API key/);
  assert.doesNotMatch(rendered, /Unlock owner mode/);
  assert.match(rendered, /"narrationId":"narration-1"/);
  assert.match(rendered, /"selectedVersionNumber":2/);
  assert.match(rendered, /"versionNumber":2/);
  assert.match(rendered, /"versionNumber":1/);
  assert.ok(rendered.indexOf("<p>Plan</p>") < rendered.indexOf("planlink-review-panel"));
});

test("hides the banner for signed-in viewers", () => {
  const rendered = renderDraftWrapper({
    draft: { id: "abc123def456", title: "Draft" },
    version: { version_number: 1 },
    html: "<p>Plan</p>",
    signedIn: true
  });

  assert.doesNotMatch(rendered, /<header class="planlink-banner">/);
});

test("builds AI prompt with draft, version, question, and saved answer", () => {
  const prompt = buildAiPrompt({
    draftTitle: "PathwayOS Plan",
    versionUrl: "https://planlink.example/d/abc123def456/v/2",
    versionNumber: 2,
    questionText: "Can we simplify the data model?",
    answerText: "Yes, remove the extra status table."
  });

  assert.match(prompt, /Plan: PathwayOS Plan/);
  assert.match(prompt, /Draft URL: https:\/\/planlink\.example\/d\/abc123def456\/v\/2/);
  assert.match(prompt, /Selected version: v2/);
  assert.match(prompt, /Can we simplify the data model\?/);
  assert.match(prompt, /Yes, remove the extra status table\./);
});

function reviewFixture(): DraftReviewRenderData {
  return {
    draft: {
      draftId: "abc123def456",
      title: "Draft",
      publicUrl: "https://planlink.example/d/abc123def456",
      repoOrg: "SpiritDevs",
      repoName: "pathwayapp",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "2026-06-29T01:00:00.000Z"
    },
    versions: [
      {
        versionId: "version_2",
        versionNumber: 2,
        versionUrl: "https://planlink.example/d/abc123def456/v/2",
        fileSize: 200,
        originalFilename: "plan.html",
        createdAt: "2026-06-29T01:00:00.000Z",
        isCurrent: true,
        isSelected: true
      },
      {
        versionId: "version_1",
        versionNumber: 1,
        versionUrl: "https://planlink.example/d/abc123def456/v/1",
        fileSize: 100,
        originalFilename: "plan.html",
        createdAt: "2026-06-29T00:00:00.000Z",
        isCurrent: false,
        isSelected: false
      }
    ],
    currentVersionNumber: 2,
    selectedVersionNumber: 2,
    canEdit: true,
    narration: [
      {
        narrationId: "narration-1",
        title: "Data Model",
        text: "This section explains the model choices in a listener-friendly way.",
        source: "explicit"
      }
    ],
    questions: [
      {
        questionId: "question_1",
        questionText: "Can we simplify the data model?",
        reviewerName: "Casey Reviewer",
        anchor: {
          text: "simplify the data model",
          prefix: "Can we ",
          suffix: "?",
          sectionId: "data-model"
        },
        resolvedAt: null,
        addressedVersionNumber: null,
        addressedVersionId: null,
        createdAt: "2026-06-29T01:10:00.000Z",
        updatedAt: "2026-06-29T01:10:00.000Z",
        answer: {
          answerId: "answer_1",
          answerText: "Yes, remove the extra status table.",
          versionNumber: 2,
          versionId: "version_2",
          createdAt: "2026-06-29T01:20:00.000Z",
          updatedAt: "2026-06-29T01:20:00.000Z"
        }
      }
    ]
  };
}
