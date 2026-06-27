import assert from "node:assert/strict";
import { test } from "bun:test";
import { validateHtml } from "../src/html-policy.js";

test("accepts a static document and extracts the title", () => {
  const result = validateHtml(`<!doctype html><html><head><title>Launch Plan</title></head><body><h1>OK</h1></body></html>`);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.title, "Launch Plan");
});

test("warns when a document has no title", () => {
  const result = validateHtml("<main>Hello</main>");

  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, ["No <title> found; PlanLink will use a generic title."]);
});

test("blocks active content and unsafe URLs", () => {
  const result = validateHtml(`
    <html>
      <head><meta http-equiv="refresh" content="0;url=https://example.com"></head>
      <body>
        <script>alert(1)</script>
        <a href="java script:alert(1)" onclick="alert(1)">Click</a>
        <img src="file:///etc/passwd">
      </body>
    </html>
  `);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Blocked <script> tag found/);
  assert.match(result.errors.join("\n"), /Blocked inline event handler attribute "onclick" found/);
  assert.match(result.errors.join("\n"), /Blocked unsafe URL in "href" attribute/);
  assert.match(result.errors.join("\n"), /Blocked unsafe URL in "src" attribute/);
  assert.match(result.errors.join("\n"), /Blocked meta refresh tag found/);
});

test("enforces the maximum byte size", () => {
  const result = validateHtml("<p>abcdef</p>", { maxBytes: 4 });

  assert.equal(result.ok, false);
  assert.match(result.errors[0], /maximum is 4 bytes/);
});
