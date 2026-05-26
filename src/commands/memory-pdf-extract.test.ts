import { describe, expect, it, vi } from "vitest";
import { extractPdfText, type PdfDocLike, type PdfPageLike } from "./memory-pdf-extract.js";

function makeTextPage(text: string): PdfPageLike {
  return {
    getTextContent: async () => ({ items: text.split(" ").map((str) => ({ str })) }),
    getViewport: () => ({ width: 1, height: 1 }),
    render: () => ({ promise: Promise.resolve() }),
  };
}

function makeEmptyPage(): PdfPageLike {
  return {
    getTextContent: async () => ({ items: [] }),
    getViewport: () => ({ width: 100, height: 100 }),
    render: () => ({ promise: Promise.resolve() }),
  };
}

function makeDoc(pages: PdfPageLike[]): PdfDocLike {
  return {
    numPages: pages.length,
    getPage: async (n: number) => pages[n - 1]!,
  };
}

describe("extractPdfText", () => {
  it("rasterizes each page and calls describeImage when the text layer is empty", async () => {
    const doc = makeDoc([makeEmptyPage(), makeEmptyPage()]);
    const loadDocument = vi.fn(async () => doc);
    const rasterizePageToPng = vi.fn(async () => Buffer.from("fake-png-bytes"));
    let pageCounter = 0;
    const describeImage = vi.fn(async () => {
      pageCounter++;
      return `picture of page ${pageCounter}`;
    });
    const stagingDir = "/tmp/pdf-extract-test-staging";

    const result = await extractPdfText("/tmp/scanned.pdf", {
      loadDocument,
      rasterizePageToPng,
      describeImage,
      stagingDir,
    });

    expect(rasterizePageToPng).toHaveBeenCalledTimes(2);
    expect(describeImage).toHaveBeenCalledTimes(2);
    expect(result.text).toContain("[pdf p1: picture of page 1]");
    expect(result.text).toContain("[pdf p2: picture of page 2]");
    expect(result.unsupported).toEqual([]);
  });

  it("redacts the extracted text layer", async () => {
    const secret = "sk-openai-1234567890ABCDEFGH";
    const doc = makeDoc([
      makeTextPage(
        `Here is a long page of content that mentions a token ${secret} embedded inside it for testing redaction.`,
      ),
    ]);
    const result = await extractPdfText("/tmp/secret.pdf", { loadDocument: async () => doc });
    expect(result.text).not.toContain(secret);
    expect(result.text).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  it("returns combined text-layer text when pages have text", async () => {
    const doc = makeDoc([
      makeTextPage("This is a long enough page one with several words of real content."),
      makeTextPage("And here is page two with comparable substantive text content for testing."),
    ]);
    const loadDocument = vi.fn(async () => doc);

    const result = await extractPdfText("/tmp/fake.pdf", { loadDocument });

    expect(loadDocument).toHaveBeenCalledWith("/tmp/fake.pdf");
    expect(result.text).toContain("page one");
    expect(result.text).toContain("page two");
    expect(result.unsupported).toEqual([]);
  });
});
