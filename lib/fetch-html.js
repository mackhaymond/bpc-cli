import { chromium } from 'playwright';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { convertPageToMarkdown } from './llmfeeder.js';

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

export async function fetchHtml(input, {
  waitMs = 5000, timeoutMs = 60000, selector, customRulesPath, userAgent = defaultUserAgent,
  bypass = true, markdown = false, log = () => {},
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
      page.on('response', response => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) lastStatus = response.status();
      });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
      } catch (error) {
        if (!/ERR_ABORTED|interrupted by another navigation/.test(error.message)) throw error;
        await page.waitForLoadState('domcontentloaded', { timeout: remaining() });
      }
      const html = await settledHtml(page, { waitMs, selector, remaining });
      const finalUrl = page.url();
      log(`HTTP ${lastStatus ?? 'unknown'}; ${finalUrl}; ${Buffer.byteLength(html)} bytes`);
      if (lastStatus >= 400) throw new Error(`Website returned HTTP ${lastStatus}`);
      const title = await page.title();
      if (/^(Just a moment|Attention Required|Access Denied|Robot Check|Verify (you are|you're) human)/i.test(title))
        throw new Error(`Website returned a bot challenge: ${title}`);
      const converted = markdown ? await convertPageToMarkdown(page) : undefined;
      if (converted) log(`LLMFeeder 2.2.1; ${Buffer.byteLength(converted)} Markdown bytes`);
      return { html, markdown: converted, url: finalUrl, status: lastStatus, title };
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
