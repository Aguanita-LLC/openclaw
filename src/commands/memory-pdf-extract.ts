import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "../logging/redact.js";

export type PdfTextItem = { str: string };

export type PdfPageLike = {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (ctx: { canvasContext: unknown; viewport: { width: number; height: number } }) => {
    promise: Promise<void>;
  };
};

export type PdfDocLike = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageLike>;
};

export type ExtractPdfTextDeps = {
  loadDocument?: (absPath: string) => Promise<PdfDocLike>;
  rasterizePageToPng?: (page: PdfPageLike) => Promise<Buffer>;
  describeImage?: (pngPath: string) => Promise<string>;
  redact?: (text: string) => string;
  stagingDir?: string;
};

// A PDF that yields fewer than roughly this many text characters per page is
// treated as scanned/empty and routed through the rasterize+vision fallback.
const TEXT_LAYER_THRESHOLD_CHARS_PER_PAGE = 40;

function redactForExport(text: string): string {
  return redactSensitiveText(text, { mode: "tools" });
}

async function defaultLoadDocument(absPath: string): Promise<PdfDocLike> {
  const data = await fs.readFile(absPath);
  // Double-cast through unknown: pdfjs's real types (RenderParameters etc.) are
  // stricter than the minimal PdfDocLike/PdfPageLike interfaces we use here,
  // and TypeScript's bidirectional structural check rejects a direct `as`.
  const { getDocument } = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument: (params: { data: Uint8Array }) => { promise: Promise<PdfDocLike> };
  };
  const loadingTask = getDocument({ data: new Uint8Array(data) });
  return loadingTask.promise;
}

async function defaultRasterizePageToPng(page: PdfPageLike): Promise<Buffer> {
  const viewport = page.getViewport({ scale: 2 });
  const { createCanvas } = (await import("@napi-rs/canvas")) as unknown as {
    createCanvas: (
      w: number,
      h: number,
    ) => {
      getContext: (k: "2d") => unknown;
      toBuffer: (mime: "image/png") => Buffer;
    };
  };
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer("image/png");
}

/**
 * Extract human-readable text from a PDF for the session summarizer.
 *
 * Strategy:
 *   1) Try the text layer (cheap, deterministic, no vision cost).
 *   2) If text is well below the per-page threshold (scanned PDF), rasterize each
 *      page to PNG and ask the injected `describeImage` to caption it.
 *      Result is returned as `[pdf p<N>: <description>]` blocks.
 *
 * All extracted strings pass through `redact()` before return (treat as untrusted
 * data — spec F-06). Temporary PNGs land under `stagingDir` and are deleted.
 */
export async function extractPdfText(
  absPath: string,
  deps: ExtractPdfTextDeps = {},
): Promise<{ text: string; unsupported: string[] }> {
  const redact = deps.redact ?? redactForExport;
  const loadDocument = deps.loadDocument ?? defaultLoadDocument;

  const doc = await loadDocument(absPath);
  const numPages = doc.numPages;

  const pageTexts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((it) => it.str)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pageTexts.push(pageText);
  }

  const combined = pageTexts.join("\n").trim();
  const enoughText = combined.length >= TEXT_LAYER_THRESHOLD_CHARS_PER_PAGE * numPages;

  if (enoughText) {
    return { text: redact(combined), unsupported: [] };
  }

  // Need vision fallback.
  const describeImage = deps.describeImage;
  const rasterize = deps.rasterizePageToPng ?? defaultRasterizePageToPng;
  const stagingDir = deps.stagingDir ?? path.dirname(absPath);

  if (!describeImage) {
    return {
      text: `[unsupported attachment: pdf — no text layer and no vision describer available]`,
      unsupported: ["pdf"],
    };
  }

  await fs.mkdir(stagingDir, { recursive: true });
  const parts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const pngPath = path.join(stagingDir, `${crypto.randomUUID()}.png`);
    try {
      const png = await rasterize(page);
      await fs.writeFile(pngPath, png);
      const description = await describeImage(pngPath);
      parts.push(`[pdf p${i}: ${redact(description)}]`);
    } catch {
      parts.push(`[pdf p${i}: unsupported — render or describe failed]`);
    } finally {
      await fs.unlink(pngPath).catch(() => {});
    }
  }

  return { text: parts.join("\n"), unsupported: parts.length === 0 ? ["pdf"] : [] };
}
