/** Existing card-scoped Corpus files; no new source store or public transport. */
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { join, sep } from "node:path";
import {
  corpusDocumentsFile,
  corpusTextsDir,
  chunkText,
  splitChapters,
  CHUNK_CHARS,
  MAX_UPLOAD_BYTES,
  type CorpusDocument,
} from "./corpus.ts";
import { prepareNovelSource } from "../novel-play/source.ts";
import { searchNovelFulltextAsync } from "../novel-play/fulltext.ts";
import type { CanonResearchScope } from "../novel-play/research.ts";
import type { CorpusResearchResult } from "../tools/agentic-research.ts";
import { readJsonFile } from "../jsonio.ts";
const permittedId = (id: string) => /^[a-zA-Z0-9_-]{1,160}$/.test(id);
function within(file: string, root: string): string {
  if (lstatSync(file).isSymbolicLink()) throw new Error("source symlink");
  const target = realpathSync(file),
    base = realpathSync(root);
  if (!target.startsWith(base + sep)) throw new Error("source path");
  return target;
}
export async function researchCardCorpus(
  cwd: string,
  cardKey: string,
  query: string,
  limit: number,
  scope: CanonResearchScope,
  docId?: string,
  signal?: AbortSignal,
): Promise<CorpusResearchResult> {
  const raw: unknown = readJsonFile(corpusDocumentsFile(cwd));
  const rows = Array.isArray(raw) ? raw : [];
  const docs = rows.filter(
    (doc): doc is CorpusDocument =>
      doc &&
      typeof doc === "object" &&
      doc.cardKey === cardKey &&
      doc.status === "ready" &&
      typeof doc.id === "string" &&
      permittedId(doc.id),
  );
  const documents = docs.slice(0, 16).map((doc) => ({
    id: doc.id,
    title: doc.title,
    version: doc.sourceVersion,
  }));
  if (!query) return { documents, hits: [] };
  if (docId && !docs.some((d) => d.id === docId))
    return {
      documents,
      hits: [],
      error: "document outside current card scope",
    };
  if (scope !== "author-planning")
    return {
      documents,
      hits: [],
      error: "文档没有角色时间线；只能author-planning读取，不能冒充已发生事实",
    };
  const selected = docId
    ? docs.filter((d) => d.id === docId)
    : docs.slice(0, 3);
  const hits: CorpusResearchResult["hits"] = [];
  let failures = 0;
  for (const doc of selected) {
    if (signal?.aborted) throw new Error("source search cancelled");
    try {
      const textFile = within(
        join(corpusTextsDir(cwd), doc.id + ".txt"),
        corpusTextsDir(cwd),
      );
      if (lstatSync(textFile).size > MAX_UPLOAD_BYTES)
        throw new Error("source too large");
      const text = readFileSync(textFile, "utf8");
      // Digest text is a derived/model-facing artifact, not source authority.
      // Reuse the existing deterministic chunker on the actual stored source;
      // don't trust a modified digest.layout to supply "original" quotations.
      const chunks = chunkText(
        splitChapters(text).chapters,
        CHUNK_CHARS,
        Number.POSITIVE_INFINITY,
      );
      const source = prepareNovelSource(
        { ...doc, chunkCount: chunks.length },
        text,
        CHUNK_CHARS,
        chunks,
      );
      if (doc.sourceFingerprint && source.fingerprint !== doc.sourceFingerprint)
        throw new Error("source version mismatch");
      hits.push(
        ...(await searchNovelFulltextAsync(
          source,
          query,
          limit,
          scope,
          undefined,
          signal,
        )),
      );
    } catch {
      if (signal?.aborted) throw new Error("source search cancelled");
      failures++;
    }
  }
  return {
    documents,
    hits: hits.slice(0, Math.max(1, Math.min(6, limit))),
    ...(failures
      ? { error: "部分源文失效或不可读取，未采用；检索范围不完整" }
      : docs.length > selected.length && !docId
        ? { error: "仅检索前三文档；用doc_id选择其他版本" }
        : {}),
  };
}
