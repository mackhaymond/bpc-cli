import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

const execute = promisify(execFile);
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function pdfToHtml(bytes, url, { workingDir, signal } = {}) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
    throw new Error('The document URL did not return a PDF');
  const path = join(workingDir, 'document.pdf');
  await writeFile(path, bytes, { mode: 0o600 });
  let text;
  try {
    ({ stdout: text } = await execute('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], {
      signal, maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('PDF extraction requires Poppler (pdftotext). Install it using the README installation steps.');
    if (signal?.aborted) throw signal.reason;
    throw new Error('PDF text extraction failed; the file may be encrypted or damaged');
  }
  const pages = text.split('\f');
  if (!pages.at(-1)?.trim()) pages.pop();
  if (!pages.some(page => page.trim())) throw new Error('PDF has no extractable text; scanned documents need OCR');
  let title = decodeURIComponent(basename(new URL(url).pathname)).replace(/\.pdf$/i, '') || 'PDF document';
  try {
    const { stdout } = await execute('pdfinfo', [path], { signal, maxBuffer: 1024 * 1024 });
    const metadataTitle = stdout.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    if (metadataTitle) title = metadataTitle;
  } catch (error) { if (signal?.aborted) throw signal.reason; }
  const note = 'Text extracted from the PDF. Figures and visual layout are not reproduced.';
  const sections = pages.map((page, i) => `<section data-pdf-page="${i + 1}"><h2>Page ${i + 1}</h2><pre>${escape(page.trimEnd() || '[No extractable text on this page.]')}</pre></section>`).join('\n');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title><base href="${escape(url)}"><meta name="bpc-document-format" content="pdf"></head><body><main><p>${note}</p>${sections}</main></body></html>`;
  return { html, title, pageCount: pages.length };
}
