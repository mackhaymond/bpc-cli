import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);

// agent-chrome runs real Chrome on an isolated background display. This is an
// optional host integration: never substitute an ordinary headed launch or
// attach to a user's profile when the helper is unavailable.
async function captureOwnedNative(input, {
  signal, timeoutMs = 25000, log = () => {}, nativeDocument = false,
  helperPath = 'agent-chrome', runHelper = execFileAsync,
  connectOverCDP = chromium.connectOverCDP.bind(chromium),
} = {}) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Native capture requires an HTTP(S) URL without credentials');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Native capture requires a positive timeout');
  if (signal?.aborted) throw signal.reason || new Error('Interrupted');
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    if (signal?.aborted) throw signal.reason || new Error('Interrupted');
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error('Background native browser capture timed out');
    return milliseconds;
  };
  // The parent Node process stays alive until capture and cleanup complete.
  // A separate ownership label prevents closing a caller's agent browser.
  const env = { ...process.env, CUA_AGENT_ID: `bpc-html-${process.pid}-${randomUUID()}` };
  let launchAttempted = false;
  let unavailable = false;
  let helperLaunched = false;
  let launchPromise;
  let browser;
  let rejectAbort;
  let abortCleanup;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  // Prevent an unhandled rejection if abort arrives between operations.
  aborted.catch(() => {});
  const observe = promise => signal ? Promise.race([promise, aborted]) : promise;
  const onAbort = () => {
    rejectAbort(signal.reason || new Error('Interrupted'));
    // Close the owned page immediately, including during an in-flight wait or
    // fetch. The final close below repeats helper cleanup after launch settles.
    const pending = [];
    if (browser) pending.push(browser.close());
    if (launchAttempted && !unavailable)
      pending.push(runHelper(helperPath, ['close'], { env, timeout: 15000, maxBuffer: 1024 * 1024 }));
    abortCleanup = Promise.allSettled(pending);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    launchAttempted = true;
    launchPromise = runHelper(helperPath, ['open', url.href], {
      env, signal, timeout: remaining(), maxBuffer: 1024 * 1024,
    });
    const launched = await observe(launchPromise);
    helperLaunched = true;
    const match = launched.stdout.match(/port=(\d+)\s+session=(\S+)/);
    if (!match) throw new Error('Background browser helper did not return its owned connection');
    const port = Number(match[1]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error('Background browser helper returned an invalid connection');
    browser = await observe(connectOverCDP(`http://127.0.0.1:${port}`, { timeout: remaining() }).then(connected => {
      if (signal?.aborted) { connected.close().catch(() => {}); throw signal.reason || new Error('Interrupted'); }
      return connected;
    }));
    const contexts = browser.contexts();
    const pages = contexts.flatMap(context => context.pages());
    const page = pages.find(page => /^https?:/.test(page.url())) || pages[0];
    if (!page) throw new Error('Owned background browser has no existing page');
    // Reuse the window/page supplied by the background helper. Creating a page
    // here could create a visible foreground tab on macOS.
    page.setDefaultTimeout(remaining());
    await observe(page.waitForFunction(() => /^https?:/.test(location.href) && document.readyState !== 'loading' && !!document.body, null, { timeout: remaining() }));
    await observe(page.waitForTimeout(Math.min(1500, remaining())));
    remaining();
    if (nativeDocument) {
      // Browser fetch preserves this isolated native browser's network stack
      // and cookies. Read incrementally and cancel before exceeding the cap.
      const document = await observe(page.evaluate(async ({ maxBytes, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let reader;
        try {
          const response = await fetch(location.href, { credentials: 'include', signal: controller.signal });
          if (!response.ok) throw new Error(`Native document returned HTTP ${response.status}`);
          if (Number(response.headers.get('content-length')) > maxBytes)
            throw new Error('File exceeds the 50 MB document limit');
          if (!response.body) throw new Error('Native document returned no response body');
          reader = response.body.getReader();
          const chunks = []; let length = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > maxBytes) {
              await reader.cancel();
              throw new Error('File exceeds the 50 MB document limit');
            }
            chunks.push(value);
          }
          const range = response.headers.get('content-range');
          if (range) {
            const match = range.match(/^bytes 0-(\d+)\/(\d+)$/);
            if (!match || Number(match[1]) + 1 !== Number(match[2]) || length !== Number(match[2]))
              throw new Error('Native document returned an incomplete byte range');
          }
          const parts = [];
          for (const chunk of chunks)
            for (let offset = 0; offset < chunk.length; offset += 32768)
              parts.push(String.fromCharCode(...chunk.subarray(offset, offset + 32768)));
          return { base64: btoa(parts.join('')), url: response.url, contentType: response.headers.get('content-type') || '' };
        } finally {
          clearTimeout(timer);
          await reader?.cancel().catch(() => {});
        }
      }, { maxBytes: 50 * 1024 * 1024, timeoutMs: remaining() }));
      const bytes = Buffer.from(document.base64, 'base64');
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
        throw new Error('Native document did not return a PDF');
      log(`Captured ${bytes.length} PDF bytes from an isolated background browser`);
      return { bytes, url: document.url, title: await observe(page.title()), contentType: document.contentType };
    }
    const metadata = await observe(page.evaluate(() => ({
      status: Number(performance.getEntriesByType('navigation')[0]?.responseStatus || 0),
      title: document.title,
    })));
    if (metadata.status >= 400)
      throw new Error(`Background browser returned HTTP ${metadata.status}`);
    if (/^(?:(?:page )?not found|404(?:\s*[-–—:|]?\s*(?:page\s+)?not found)?|403 forbidden|500 internal server error|502 bad gateway|503 service unavailable)(?:$|\s*[-–—|:])/i.test(metadata.title))
      throw new Error('Background browser returned an error page');
    const captured = { html: await observe(page.content()), url: page.url(), title: metadata.title || await observe(page.title()), status: metadata.status || undefined };
    log(`Captured ${Buffer.byteLength(captured.html)} HTML bytes from an isolated background browser`);
    return captured;
  } catch (error) {
    if (!helperLaunched && error.code === 'ENOENT') {
      unavailable = true;
      log('Optional background browser helper is not installed');
      return null;
    }
    if (signal?.aborted) throw signal.reason || new Error('Interrupted');
    // Helper output may contain private redirect URLs; expose a bounded,
    // neutral diagnostic instead of forwarding subprocess stdout/stderr.
    if (error.cmd || error.killed) throw new Error('Background browser helper could not capture the page');
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await abortCleanup;
    // Launch can have spawned a daemon before cancellation is observed. Do
    // not let a late registration appear after our last same-label close.
    await launchPromise?.catch(() => {});
    // Disconnect first, then close only the helper session carrying our label.
    await browser?.close().catch(() => {});
    if (launchAttempted && !unavailable) {
      await runHelper(helperPath, ['close'], {
        env, timeout: 15000, maxBuffer: 1024 * 1024,
      }).catch(() => log('Background browser helper cleanup could not be confirmed'));
    }
  }
}


export async function captureNativePage(input, options = {}) {
  return captureOwnedNative(input, { ...options, nativeDocument: false });
}

export async function captureNativeDocument(input, options = {}) {
  return captureOwnedNative(input, { ...options, nativeDocument: true });
}
