import assert from "node:assert/strict";
import { test } from "bun:test";
import { extractNarrationSections } from "../src/narration.js";

test("extracts explicit PlanLink narration blocks", () => {
  const sections = extractNarrationSections(`
    <!doctype html>
    <main>
      <section>
        <h2>Data Model</h2>
        <p>The visible plan content is concise.</p>
        <aside data-planlink-narration>
          This is the detailed spoken run-through for the data model section.
          It explains why the model is intentionally small.
        </aside>
      </section>
      <section>
        <h2>Rollout</h2>
        <aside data-planlink-narration data-planlink-title="Release Plan">
          Ship the migration first, then turn on the review panel.
        </aside>
      </section>
    </main>
  `);

  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, "Data Model");
  assert.equal(sections[0].source, "explicit");
  assert.match(sections[0].text, /detailed spoken run-through/);
  assert.equal(sections[1].title, "Release Plan");
});

test("falls back to heading sections when no explicit narration exists", () => {
  const sections = extractNarrationSections(`
    <!doctype html>
    <main>
      <h1>Plan</h1>
      <h2>Architecture</h2>
      <p>The service stores drafts, versions, and review notes separately.</p>
      <p>This keeps uploaded HTML static while the wrapper owns interactivity.</p>
      <h2>Testing</h2>
      <p>Run typecheck, unit tests, and a production health check before publish.</p>
    </main>
  `);

  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, "Architecture");
  assert.equal(sections[0].source, "section");
  assert.match(sections[0].text, /wrapper owns interactivity/);
  assert.equal(sections[1].title, "Testing");
});
