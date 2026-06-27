import assert from "node:assert/strict";
import { test } from "bun:test";
import { getDraftIdFromHost, getDraftPublicUrl, getHomeUrl } from "../src/public-url.js";

test("builds path-based draft URLs when no wildcard base is configured", () => {
  assert.equal(
    getDraftPublicUrl({
      draftId: "abc123def456",
      publicBaseUrl: "https://planlink.example",
      requestBaseUrl: "http://localhost:3000"
    }),
    "https://planlink.example/d/abc123def456"
  );
});

test("builds wildcard draft URLs and home URLs", () => {
  assert.equal(
    getDraftPublicUrl({
      draftId: "abc123def456",
      publicBaseUrl: "https://*.planlink.example",
      requestBaseUrl: "http://localhost:3000"
    }),
    "https://abc123def456.planlink.example"
  );

  assert.equal(
    getHomeUrl({
      publicBaseUrl: "https://*.planlink.example",
      requestBaseUrl: "http://localhost:3000"
    }),
    "https://planlink.example"
  );
});

test("extracts draft IDs from valid wildcard hosts only", () => {
  assert.equal(
    getDraftIdFromHost({
      publicBaseUrl: "https://*.planlink.example",
      host: "abc123def456.planlink.example"
    }),
    "abc123def456"
  );

  assert.equal(
    getDraftIdFromHost({
      publicBaseUrl: "https://*.planlink.example",
      host: "nested.abc123def456.planlink.example"
    }),
    null
  );

  assert.equal(
    getDraftIdFromHost({
      publicBaseUrl: "https://planlink.example",
      host: "abc123def456.planlink.example"
    }),
    null
  );
});
