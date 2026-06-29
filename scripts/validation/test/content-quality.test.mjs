import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readContentQualitySampleLimit,
  validateGeneratedContentQuality
} from "../lib/content-quality.mjs";

test("content quality validation checks source body, indexes, model fields, and graph links", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-content-quality-"));

  try {
    const intro = writeSample(root, "intro.md", {
      title: "API Security Checklist",
      type: "checklist",
      body: "API security checklist covers token rotation and request signing."
    });
    const keys = writeSample(root, "keys.md", {
      title: "Key Rotation Guide",
      type: "guide",
      body: "Key rotation guide defines token rotation schedules and incident response."
    });
    const bodies = new Map([
      [
        "pages/intro.md",
        "---\ntype: checklist\ntitle: API Security Checklist\ndescription: Checklist for API security controls\ntags:\n  - security\n---\n# API Security Checklist\n\nAPI security checklist covers token rotation and request signing."
      ],
      [
        "pages/keys.md",
        "---\ntype: guide\ntitle: Key Rotation Guide\ndescription: Guide for token rotation schedules\ntags:\n  - security\n---\n# Key Rotation Guide\n\nKey rotation guide defines token rotation schedules and incident response."
      ]
    ]);
    const indexes = buildIndexes([intro, keys]);

    const summary = validateGeneratedContentQuality({
      samples: [intro, keys],
      bodies,
      indexes,
      modelAssistance: { enabled: true },
      semanticSampleLimit: 2
    });

    assert.equal(summary.structuralSamples, 2);
    assert.equal(summary.semanticSamples, 2);
    assert.equal(summary.modelCheckedPages, 2);
    assert.equal(summary.graphLinks, 1);
    assert.equal(summary.questionableGraphLinks, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("content quality validation rejects missing index entries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-content-quality-missing-"));

  try {
    const sample = writeSample(root, "missing.md", {
      title: "Missing Index",
      type: "page",
      body: "Missing index content still has a source body."
    });

    assert.throws(
      () =>
        validateGeneratedContentQuality({
          samples: [sample],
          bodies: new Map([
            [
              "pages/missing.md",
              "---\ntype: page\ntitle: Missing Index\n---\n# Missing Index\n\nMissing index content still has a source body."
            ]
          ]),
          indexes: {
            manifest: { files: [] },
            search: { items: [] },
            links: { links: [] }
          },
          modelAssistance: { enabled: false },
          semanticSampleLimit: 1
        }),
      /missing manifest entry/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("content quality sample limit validates configured bounds", () => {
  assert.equal(readContentQualitySampleLimit({}), 25);
  assert.equal(readContentQualitySampleLimit({ FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT: "200" }), 200);
  assert.throws(
    () => readContentQualitySampleLimit({ FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT: "201" }),
    /between 1 and 200/
  );
});

function writeSample(root, inputName, input) {
  const filePath = path.join(root, inputName);
  fs.writeFileSync(
    filePath,
    `---\ntype: ${input.type}\ntitle: ${input.title}\n---\n# ${input.title}\n\n${input.body}\n`
  );

  return {
    basename: inputName,
    filePath,
    title: input.title,
    type: input.type,
    status: "active",
    category: "test",
    publicationDate: "2026-01-01",
    sizeBytes: fs.statSync(filePath).size
  };
}

function buildIndexes(samples) {
  return {
    manifest: {
      files: samples.map((sample) => ({
        path: `pages/${sample.basename}`,
        title: sample.title,
        metadata: {
          type: sample.type,
          title: sample.title,
          description: `Description for ${sample.title}`,
          tags: ["security"]
        }
      }))
    },
    search: {
      items: samples.map((sample) => ({
        path: `pages/${sample.basename}`,
        type: sample.type,
        title: sample.title,
        description: `Description for ${sample.title}`,
        tags: ["security"],
        keywords: ["security", "rotation"],
        metadata: {
          type: sample.type,
          title: sample.title,
          description: `Description for ${sample.title}`,
          tags: ["security"]
        }
      }))
    },
    links: {
      links: [
        {
          from: "pages/intro.md",
          to: "pages/keys.md",
          label: "Key Rotation Guide",
          relation_type: "shared_tag",
          reason: "Both files discuss token rotation."
        }
      ]
    }
  };
}
