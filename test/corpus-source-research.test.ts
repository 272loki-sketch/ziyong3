import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { researchCardCorpus } from "../src/outline/source-research.ts";
test(
  "普通导入原著按当前card/version只读全文，精确位置，不出网，不读越界文件",
  { timeout: 10000 },
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "liyuan-source-test-"));
    const root = join(cwd, ".liyuan", "outline", "research", "corpus");
    mkdirSync(join(root, "texts"), { recursive: true });
    const text = "第一章\n授权合成角色佩戴蓝色帽子，约定在上午九点。";
    const fingerprint = createHash("sha256").update(text).digest("hex");
    const doc = {
      id: "doc-1",
      title: "合成原文",
      status: "ready",
      cardKey: "card.json",
      chars: text.length,
      chunkCount: 1,
      sourceFingerprint: fingerprint,
      sourceVersion: 2,
    };
    writeFileSync(
      join(root, "documents.json"),
      JSON.stringify([
        doc,
        { ...doc, id: "private-other", cardKey: "other.json" },
        { ...doc, id: "../secret" },
      ]),
    );
    writeFileSync(join(root, "texts", "doc-1.txt"), text);
    try {
      assert.equal(
        (await researchCardCorpus(cwd, "card.json", "", 3, "visible")).documents
          .length,
        1,
      );
      assert.equal(
        (await researchCardCorpus(cwd, "card.json", "帽子", 3, "visible")).hits
          .length,
        0,
      );
      const [hit] = (
        await researchCardCorpus(cwd, "card.json", "帽子", 3, "author-planning")
      ).hits;
      assert.ok(hit.quote.includes("蓝色帽子"));
      assert.equal(hit.characterKnowledge, "not-established");
      assert.equal(hit.sourceFingerprint, fingerprint);
      assert.equal(
        (
          await researchCardCorpus(
            cwd,
            "card.json",
            "帽子",
            3,
            "author-planning",
            "private-other",
          )
        ).hits.length,
        0,
      );
      assert.equal(
        (
          await researchCardCorpus(
            cwd,
            "card.json",
            "帽子",
            3,
            "author-planning",
            "../secret",
          )
        ).hits.length,
        0,
      );
      writeFileSync(
        join(root, "texts", "doc-1.txt"),
        text.replace("蓝色", "绿色"),
      );
      assert.equal(
        (
          await researchCardCorpus(
            cwd,
            "card.json",
            "帽子",
            3,
            "author-planning",
          )
        ).hits.length,
        0,
      );
      rmSync(join(root, "texts", "doc-1.txt"));
      writeFileSync(join(cwd, "private.txt"), text);
      symlinkSync(join(cwd, "private.txt"), join(root, "texts", "doc-1.txt"));
      assert.equal(
        (
          await researchCardCorpus(
            cwd,
            "card.json",
            "帽子",
            3,
            "author-planning",
          )
        ).hits.length,
        0,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
