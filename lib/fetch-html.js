import { chromium } from 'playwright';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { convertPageToMarkdown } from './llmfeeder.js';
import { findReutersSyndication, matchesHeadline } from './publisher-fallbacks.js';
import { pdfToHtml } from './pdf.js';
import { captureNativePage, captureNativeDocument } from './adapters/native-browser.js';

const vendorPath = fileURLToPath(new URL('../vendor/bypass-paywalls-chrome-clean-master/', import.meta.url));
const require = createRequire(import.meta.url);
const browserMetadata = JSON.parse(await readFile(join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8'));
const chromeMajor = browserMetadata.browsers.find(browser => browser.name === 'chromium').browserVersion.split('.')[0];
const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
  : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
// A regular Chrome UA avoids sites rejecting the HeadlessChrome product token.
const defaultUserAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

function validateUrl(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('Expected a complete HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  if (url.username || url.password) throw new Error('URLs containing credentials are not supported');
  return url.href;
}

async function loadCustomRules(path) {
  if (!path) return {};
  const rules = JSON.parse(await readFile(path, 'utf8'));
  if (!rules || typeof rules !== 'object' || Array.isArray(rules))
    throw new Error('Custom rules must be a BPC JSON object mapping site names to rules');
  for (const [name, rule] of Object.entries(rules)) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || typeof rule.domain !== 'string' || !rule.domain)
      throw new Error(`Custom rule ${JSON.stringify(name)} needs a domain string`);
  }
  return rules;
}

async function enableExtension(context, manifest, customRules, remaining) {
  let worker = context.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', {
    predicate: worker => worker.url().startsWith('chrome-extension://'), timeout: remaining(),
  });
  // Wait for the extension's install handler, then use its native storage API.
  await worker.evaluate(async () => {
    while (!Object.keys((await chrome.storage.local.get('sites')).sites || {}).length)
      await new Promise(resolve => setTimeout(resolve, 50));
  });
  const expected = await worker.evaluate(async ({ customRules }) => {
    const sites = Object.fromEntries(Object.entries(globalThis.defaultSites)
      .filter(([, rule]) => rule.domain && !rule.domain.match(/^(###$|#options_(disable|optin)_)/))
      .map(([name, rule]) => [name, rule.domain]));
    Object.assign(sites, Object.fromEntries(Object.entries(customRules).map(([name, rule]) => [name, rule.domain])));
    // Custom rules are written first so the sites listener can resolve their domains.
    await chrome.storage.local.set({
      sites_custom: customRules,
      optIn: true, optInUpdate: false, ext_update_check: Date.now(),
      optInShown: true, customShown: true, fetchShown: true,
    });
    await chrome.storage.local.set({ sites });
    return Object.keys(sites).length;
  }, { customRules });
  return await worker.evaluate(async ({ expected, version }) => {
    while (true) {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      if (Object.keys(globalThis.optionSites || {}).length === expected &&
          rules.length > 0 && rules.length === globalThis.sesRules.length)
        return { version, ruleCount: rules.length };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }, { expected, version: manifest.version });
}

async function settledHtml(page, { waitMs, selector, remaining }) {
  // Extension rules can navigate to AMP or replace the article asynchronously.
  // Allow a quiet DOM interval, with a cap for sites that constantly update ads.
  // News sites often keep analytics connections open, making networkidle unsuitable.
  await page.waitForTimeout(waitMs);
  if (selector) await page.locator(selector).first().waitFor({ state: 'visible', timeout: remaining() });
  let previous;
  let stableSince = Date.now();
  const settleDeadline = Date.now() + Math.min(5000, remaining());
  while (true) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: remaining() });
      const html = await page.content();
      if (html !== previous) { previous = html; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 1000) return html;
      if (Date.now() >= settleDeadline) return html;
    } catch (error) {
      if (!/Execution context was destroyed|navigating|Cannot find context/.test(error.message)) throw error;
      previous = undefined;
      stableSince = Date.now();
    }
    await page.waitForTimeout(200);
  }
}

async function articleFailure(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const body = document.querySelector('.n-content-body, [data-testid="article-body"], [style*="article-body"]');
    const hasKnownBody = visible(body) && (body.innerText || '').trim().length > 200;
    const hasBody = hasKnownBody ||
      Array.from(document.querySelectorAll('main, article')).some(region =>
        (region.innerText || '').length > 1500 && Array.from(region.querySelectorAll('p')).some(p =>
          (p.innerText || '').trim().split(/\s+/).length >= 25));
    if (!hasKnownBody && /BPC >[\s\S]{0,400}?(?:no article content found|failed to load|fetch blocked|no fix)/i.test(text))
      return 'The extension could not retrieve the article';
    if (!hasKnownBody && document.querySelector('#barrier-page')) return 'The article is still paywalled';
    const gates = Array.from(document.querySelectorAll('[class*="paywall"], [id*="paywall"], [class*="barrier"], [data-testid*="paywall"]'));
    if (gates.some(gate => visible(gate) && /subscribe to (?:continue reading|unlock)|sign in to read (?:the )?full article/i.test(gate.innerText || '')))
      return 'The article is still paywalled';
    const articleGates = Array.from(document.querySelectorAll('main p, article p, main section, article section, main div, article div'));
    if (articleGates.some(gate => visible(gate) && !gate.querySelector('p, section, div') &&
      (gate.innerText || '').trim().split(/\s+/).length < 75 &&
      /(?:please\s+)?(?:log\s*in|sign\s*in|subscribe)[\s\S]{0,80}?read\s+(?:the\s+)?full\s+(?:article|story)|subscribe\s+to\s+continue\s+reading/i.test(gate.innerText || '')))
      return 'The article is still paywalled';
    const location = new URL(window.location.href);
    if (location.hostname === 'subs.ft.com' || (/\.ft\.com$/.test(location.hostname) && /^Subscribe to (?:read|the Financial Times)/i.test(document.title)))
      return 'The article redirected to a subscription page';
    if (/(^|\.)ft\.com$/.test(location.hostname) && location.pathname.startsWith('/content/') && !hasKnownBody)
      return 'The publisher returned navigation without article content';
    if (/^(Just a moment|Attention Required|Access Denied|Robot Check|Verify (you are|you're) human)/i.test(document.title))
      return 'Website returned a bot challenge';
    if (!hasBody && document.querySelector('iframe[src*="captcha-delivery.com"], iframe[title*="CAPTCHA"]'))
      return 'Website returned a bot challenge';
    return null;
  });
}

function ftPreviewUrl(current, requested) {
  const location = current.searchParams.get('location');
  for (const value of [current.href, location, requested]) {
    if (!value) continue;
    let candidate;
    try { candidate = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`); } catch { continue; }
    if (!['http:', 'https:'].includes(candidate.protocol) || candidate.username || candidate.password) continue;
    if (candidate.hostname === 'ig.ft.com' && candidate.pathname !== '/') return candidate.href;
    if (/(^|\.)ft\.com$/.test(candidate.hostname) && candidate.pathname.startsWith('/content/')) return candidate.href;
  }
  return null;
}

function completeFileRange(headers, status, bytes) {
  const range = headers['content-range'];
  if (!range) return status !== 206;
  const match = range.match(/^bytes 0-(\d+)\/(\d+)$/);
  if (!match) return false;
  const end = Number(match[1]), total = Number(match[2]);
  return Number.isSafeInteger(total) && end + 1 === total && bytes.length === total;
}

export async function fetchHtml(input, {
  waitMs = 5000, timeoutMs = 60000, selector, customRulesPath, userAgent = defaultUserAgent,
  bypass = true, markdown = false, nativeFiles = false, log = () => {},
} = {}) {
  const url = validateUrl(input);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(waitMs) || waitMs < 0 || waitMs >= timeoutMs)
    throw new Error('Expected 0 <= waitMs < timeoutMs');
  if (!bypass && customRulesPath) throw new Error('--custom-rules cannot be used with --no-bypass');
  const customRules = await loadCustomRules(customRulesPath);
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error(`Timed out after ${timeoutMs / 1000} seconds`);
    return milliseconds;
  };
  const workingDir = await mkdtemp(join(tmpdir(), 'bpc-html-'));
  let context;
  let operationPromise;
  let timer;
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error('Interrupted'));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs / 1000} seconds`)), remaining());
  try {
    const operation = async () => {
      const args = [];
      let manifest;
      if (bypass) {
        const extensionPath = join(workingDir, 'extension');
        await cp(vendorPath, extensionPath, { recursive: true, filter: source => !source.includes('/.codegraph') && !source.includes('/.cursor') });
        // Upstream supplies this manifest for custom sites and external fetches.
        // Permissions apply only inside this throwaway browser profile.
        manifest = JSON.parse(await readFile(join(extensionPath, 'custom/manifest.json'), 'utf8'));
        await writeFile(join(extensionPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        args.push(`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`);
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      const launched = await chromium.launchPersistentContext(join(workingDir, 'profile'), {
        channel: 'chromium', headless: true, args, timeout: remaining(),
        viewport: { width: 1440, height: 1000 }, acceptDownloads: false,
        ...(userAgent ? { userAgent } : {}),
      });
      context = launched;
      if (controller.signal.aborted) { await context.close(); throw controller.signal.reason; }
      context.setDefaultTimeout(remaining());
      context.setDefaultNavigationTimeout(remaining());
      if (bypass) {
        const details = await enableExtension(context, manifest, customRules, remaining);
        log(`BPC ${details.version}; ${details.ruleCount} browser request rules loaded`);
      }
      const page = await context.newPage();
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      let lastStatus;
      let documentResponse;
      let documentRequest;
      let downloadUrl;
      let downloadFilename;
      page.on('request', request => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequest = request;
      });
      page.on('download', download => {
        downloadUrl = download.url();
        downloadFilename = download.suggestedFilename();
      });
      page.on('response', response => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          lastStatus = response.status();
          documentResponse = response;
        }
      });
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: remaining() });
      } catch (error) {
        if (!/ERR_ABORTED|interrupted by another navigation|Download is starting/.test(error.message)) throw error;
      }
      const responseType = documentResponse?.headers()['content-type'] || '';
      const documentUrl = downloadUrl || documentResponse?.url() || documentRequest?.url() || page.url();
      let pdf;
      const isPdf = /application\/pdf/i.test(responseType) || /\.pdf$/i.test(new URL(documentUrl).pathname);
      const isFile = !!downloadUrl || isPdf || /^(?:image\/|audio\/|video\/|application\/(?:octet-stream|zip|json|xml|vnd\.|msword|gzip)|text\/(?:plain|csv|xml))/i.test(responseType) ||
        /attachment/i.test(documentResponse?.headers()['content-disposition'] || '') ||
        /\.(?:csv|tsv|txt|json|xml|zip|gz|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|webp|mp3|wav|mp4|mov)$/i.test(new URL(documentUrl).pathname);
      if (isFile) {
        if (Number(documentResponse?.headers()['content-length']) > 50 * 1024 * 1024)
          throw new Error('File exceeds the 50 MB document limit');
        let bytes;
        let fileType = responseType, fileStatus = lastStatus, fileUrl = documentUrl;
        try {
          if (lastStatus >= 400) throw new Error(`Document returned HTTP ${lastStatus}`);
          if (lastStatus !== 206 && !documentResponse?.headers()['content-range'] && documentResponse?.url() === documentUrl) {
            try { bytes = await documentResponse.body(); } catch {}
          }
          // Chromium can expose its generated PDF-viewer placeholder as the
          // navigation body even though the response advertises application/pdf.
          const viewerBody = bytes && /^\s*<(?:!doctype\s+html|html)/i.test(bytes.subarray(0, 1024).toString('utf8')) &&
            !/html/i.test(responseType) && !/\.html?$/i.test(new URL(documentUrl).pathname);
          if (!bytes || viewerBody || (isPdf && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))) {
            const capturedHeaders = documentResponse?.url() === documentUrl
              ? await documentResponse.request().allHeaders() : (documentRequest?.headers() || {});
            const headers = Object.fromEntries(Object.entries(capturedHeaders).filter(([name]) =>
              !name.startsWith(':') && !['connection', 'proxy-connection', 'transfer-encoding', 'host', 'content-length'].includes(name.toLowerCase())));
            delete headers.range;
            delete headers['if-range'];
            let response = await context.request.get(documentUrl, { headers, timeout: remaining() });
            if (!response.ok()) throw new Error(`Document returned HTTP ${response.status()}`);
            if (Number(response.headers()['content-length']) > 50 * 1024 * 1024) throw new Error('File exceeds the 50 MB document limit');
            bytes = await response.body();
            if (!completeFileRange(response.headers(), response.status(), bytes)) {
              const total = Number(response.headers()['content-range']?.match(/\/(\d+)$/)?.[1]);
              if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Server returned an incomplete file');
              if (total > 50 * 1024 * 1024) throw new Error('File exceeds the 50 MB document limit');
              response = await context.request.get(documentUrl, { headers: { ...headers, range: `bytes=0-${total - 1}` }, timeout: remaining() });
              if (!response.ok()) throw new Error(`Document returned HTTP ${response.status()}`);
              bytes = await response.body();
              if (!completeFileRange(response.headers(), response.status(), bytes)) throw new Error('Server returned an incomplete file');
            }
            fileType = response.headers()['content-type'] || fileType;
            fileStatus = response.status();
            fileUrl = response.url();
          }
          if (bytes.length > 50 * 1024 * 1024) throw new Error('File exceeds the 50 MB document limit');
          if (isPdf && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-')))
            throw new Error('The document URL did not return a PDF');
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (!bypass || !isPdf || /50 MB/.test(error.message)) throw error;
          log('PDF download unavailable; retrying through the isolated background browser');
          const native = await captureNativeDocument(documentUrl, {
            signal: controller.signal, timeoutMs: Math.min(25000, remaining()), log,
          });
          if (!native) throw error;
          bytes = native.bytes;
          fileType = native.contentType || 'application/pdf';
          fileStatus = 200;
          fileUrl = native.url;
        }
        if (!markdown || nativeFiles) {
          log(`Original file returned: ${fileType || 'binary'}; ${bytes.length} bytes`);
          return { data: bytes, format: 'file', contentType: fileType, url: fileUrl, status: fileStatus,
            filename: downloadFilename || new URL(fileUrl).pathname.split('/').at(-1) || 'download' };
        }
        if (!isPdf) throw new Error('This URL returns a file. Omit --markdown or use --native-files to save the original bytes.');
        pdf = await pdfToHtml(bytes, fileUrl, { workingDir, signal: controller.signal });
        const route = handler => handler.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: pdf.html });
        await page.route(fileUrl, route);
        try { await page.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: remaining() }); }
        finally { await page.unroute(fileUrl, route); }
        log(`PDF text extracted from ${pdf.pageCount} pages`);
      }
      // Detect fetch failures before enforcing a selector: a blocked article
      // may never create the requested element, but can still be retried.
      let html = await settledHtml(page, { waitMs: pdf ? 0 : waitMs, remaining });
      let failure = await articleFailure(page);
      const currentUrl = new URL(page.url());
      const previewUrl = ftPreviewUrl(currentUrl, url);
      let originalSource;
      if (bypass && failure && previewUrl) {
        log('FT article unavailable; retrying the publisher preview representation');
        const session = await context.newCDPSession(page);
        try {
          await session.send('Network.setUserAgentOverride', {
            userAgent: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
          });
          await page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: remaining() });
          html = await settledHtml(page, { waitMs, remaining });
          failure = await articleFailure(page);
        } finally { await session.detach().catch(() => {}); }
      }
      if (bypass && !pdf && (failure || lastStatus === 401 || lastStatus === 403)) {
        const native = await captureNativePage(page.url(), {
          signal: controller.signal, timeoutMs: Math.min(25000, remaining()), log,
        }).catch(error => {
          if (controller.signal.aborted) throw controller.signal.reason;
          log(`Background browser retry unavailable: ${error.message}`);
          return null;
        });
        if (native && /^https?:/.test(native.url)) {
          const route = handler => handler.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: native.html });
          await page.route(native.url, route);
          try { await page.goto(native.url, { waitUntil: 'domcontentloaded', timeout: remaining() }); }
          finally { await page.unroute(native.url, route); }
          html = await settledHtml(page, { waitMs, remaining });
          failure = await articleFailure(page);
          log('Reprocessed the background browser page with BPC');
        }
      }
      if (bypass && (failure || lastStatus === 401 || lastStatus === 403) && /(^|\.)reuters\.com$/.test(currentUrl.hostname)) {
        log('Reuters blocked the request; checking for a matching syndicated Reuters article');
        const candidate = await findReutersSyndication(currentUrl.href, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(10000, remaining()))]),
        }).catch(error => {
          if (controller.signal.aborted) throw controller.signal.reason;
          log(`Syndication lookup unavailable: ${error.name}`);
          return null;
        });
        if (candidate) {
          await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: remaining() });
          html = await settledHtml(page, { waitMs, remaining });
          const attribution = await page.evaluate(() => ({
            title: document.querySelector('h1')?.textContent || document.title,
            reuters: !!document.querySelector('a[href="/reuters-stories"]'),
          }));
          if (!attribution.reuters || !matchesHeadline(candidate.expectedHeadline, attribution.title))
            throw new Error('Syndicated page did not verify as the requested Reuters article');
          failure = await articleFailure(page);
          originalSource = candidate.originalUrl;
          await page.evaluate(originalUrl => {
            const meta = document.createElement('meta');
            meta.name = 'bpc-original-source';
            meta.content = originalUrl;
            document.head.append(meta);
          }, originalSource);
          html = await page.content();
          log('Using a matching Reuters-attributed article from Devdiscourse');
        }
      }
      if (failure) throw new Error(failure);
      if (selector) {
        await page.locator(selector).first().waitFor({ state: 'visible', timeout: remaining() });
        html = await page.content();
      }
      const finalUrl = page.url();
      log(`HTTP ${lastStatus ?? 'unknown'}; ${finalUrl}; ${Buffer.byteLength(html)} bytes`);
      if (lastStatus >= 400) throw new Error(`Website returned HTTP ${lastStatus}`);
      const title = await page.title();
      if (/^(Just a moment|Attention Required|Access Denied|Robot Check|Verify (you are|you're) human)/i.test(title))
        throw new Error(`Website returned a bot challenge: ${title}`);
      const interactiveFt = new URL(finalUrl).hostname === 'ig.ft.com';
      let converted = markdown ? await convertPageToMarkdown(page, {
        log, contentScope: pdf || interactiveFt ? 'fullPage' : 'mainContent',
        ...(interactiveFt ? { contentSelector: 'article.article' } : {}),
      }) : undefined;
      if (converted && originalSource)
        converted += `\nOriginal Reuters article: ${originalSource}\nRetrieved from syndicated publisher: ${finalUrl}\n`;
      if (converted) log(`LLMFeeder 2.2.1; ${Buffer.byteLength(converted)} Markdown bytes`);
      return { html, markdown: converted, url: finalUrl, originalUrl: originalSource, status: lastStatus, title,
        ...(pdf ? { format: 'pdf', pageCount: pdf.pageCount } : {}) };
    };
    operationPromise = operation();
    return await Promise.race([operationPromise, aborted]);
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (context) await context.close().catch(() => {});
    await operationPromise?.catch(() => {});
    await rm(workingDir, { recursive: true, force: true });
  }
}
