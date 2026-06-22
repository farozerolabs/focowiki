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
      title: "Shanghai Free Trade Pilot Zone Rules",
      type: "legal",
      body: "Shanghai free trade pilot zone rules support trade facilitation and investment services."
    });
    const trade = writeSample(root, "trade.md", {
      title: "Trade Facilitation Measures",
      type: "legal",
      body: "Trade facilitation measures define single window services and customs coordination."
    });
    const bodies = new Map([
      [
        "pages/intro.md",
        "---\ntype: legal\ntitle: Shanghai Free Trade Pilot Zone Rules\ndescription: Rules for trade facilitation\ntags:\n  - trade\n---\n# Shanghai Free Trade Pilot Zone Rules\n\nShanghai free trade pilot zone rules support trade facilitation and investment services."
      ],
      [
        "pages/trade.md",
        "---\ntype: legal\ntitle: Trade Facilitation Measures\ndescription: Measures for trade facilitation\ntags:\n  - trade\n---\n# Trade Facilitation Measures\n\nTrade facilitation measures define single window services and customs coordination."
      ]
    ]);
    const indexes = buildIndexes([intro, trade]);

    const summary = validateGeneratedContentQuality({
      samples: [intro, trade],
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
      type: "legal",
      body: "Missing index content still has a source body."
    });

    assert.throws(
      () =>
        validateGeneratedContentQuality({
          samples: [sample],
          bodies: new Map([
            [
              "pages/missing.md",
              "---\ntype: legal\ntitle: Missing Index\n---\n# Missing Index\n\nMissing index content still has a source body."
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
  assert.equal(readContentQualitySampleLimit({ FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT: "30" }), 30);
  assert.throws(
    () => readContentQualitySampleLimit({ FOCOWIKI_VALIDATION_CONTENT_SAMPLE_COUNT: "31" }),
    /between 1 and 30/
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
    status: "有效",
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
          tags: ["trade"]
        }
      }))
    },
    search: {
      items: samples.map((sample) => ({
        path: `pages/${sample.basename}`,
        type: sample.type,
        title: sample.title,
        description: `Description for ${sample.title}`,
        tags: ["trade"],
        keywords: ["trade", "facilitation"],
        metadata: {
          type: sample.type,
          title: sample.title,
          description: `Description for ${sample.title}`,
          tags: ["trade"]
        }
      }))
    },
    links: {
      links: [
        {
          from: "pages/intro.md",
          to: "pages/trade.md",
          label: "Trade Facilitation Measures",
          relation_type: "shared_tag",
          reason: "Both files discuss trade facilitation."
        }
      ]
    }
  };
}
