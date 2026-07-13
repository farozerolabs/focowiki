import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMarkdownLinkDestinations } from "../lib/markdown-body-comparison.mjs";

test("compares Markdown content independently from canonicalized link destinations", () => {
  const source = [
    "Read [Incident Response](on-call/incident-response.md).",
    "[Guide]: ../technical/guide.md"
  ].join("\n");
  const generated = [
    "Read [Incident Response](/pages/operations/on-call/incident-response.md).",
    "[Guide]: /pages/technical/guide.md"
  ].join("\n");

  assert.equal(
    normalizeMarkdownLinkDestinations(source),
    normalizeMarkdownLinkDestinations(generated)
  );
});

test("preserves link labels and surrounding content during comparison", () => {
  assert.notEqual(
    normalizeMarkdownLinkDestinations("Read [First](first.md)."),
    normalizeMarkdownLinkDestinations("Read [Second](/pages/first.md).")
  );
});
