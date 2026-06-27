import assert from "node:assert/strict";
import { test } from "bun:test";
import { renderDraftWrapper } from "../src/render.js";

test("renders uploaded HTML inside a sandboxed srcdoc iframe", () => {
  const rendered = renderDraftWrapper({
    draft: { id: "abc123def456", title: "Draft <Title>" },
    version: { version_number: 3 },
    html: `<h1 onclick="alert(1)">Plan</h1>`,
    signedIn: false,
    homeUrl: "https://planlink.example"
  });

  assert.match(rendered, /<header class="planlink-banner">/);
  assert.match(rendered, /sandbox=""/);
  assert.match(rendered, /srcdoc="&lt;h1 onclick=&quot;alert\(1\)&quot;&gt;Plan&lt;\/h1&gt;"/);
  assert.match(rendered, /Draft &lt;Title&gt;/);
  assert.match(rendered, /draft:abc123def456 version:3/);
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
