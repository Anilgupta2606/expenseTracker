import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PasswordNeededError } from './errors';
import { groupLines, type Page } from './layout';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Extracts positioned text lines from each page of a PDF. */
export async function readPdfPages(data: ArrayBuffer, password?: string): Promise<Page[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data), password, verbosity: 0 });
  let doc: pdfjs.PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (e) {
    if (e instanceof Error && e.name === 'PasswordException') {
      throw new PasswordNeededError(Boolean(password));
    }
    throw e;
  }
  const pages: Page[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.flatMap((it) =>
      'str' in it ? [{ x: it.transform[4], y: it.transform[5], w: it.width, s: it.str }] : [],
    );
    pages.push(groupLines(items));
  }
  await doc.destroy();
  return pages;
}
