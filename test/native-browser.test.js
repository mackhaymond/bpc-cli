import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureNativePage, captureNativeDocument } from '../lib/adapters/native-browser.js';

function fixture({ missing = false, connectionFailure = false, document = '%PDF-1.7\nexample\n%%EOF', nativeStatus = 200, nativeTitle = 'Article' } = {}) {
  const calls = [];
  const page = {
    url: () => 'https://example.com/redirected-article',
    setDefaultTimeout() {}, waitForFunction: async () => {}, waitForTimeout: async () => {},
    content: async () => '<html><article>A full article</article></html>',
    title: async () => 'Article',
    evaluate: async (fn, args) => args?.maxBytes ? { base64: Buffer.from(document).toString('base64'), url: 'https://example.com/report.pdf', contentType: 'application/pdf' } : { status: nativeStatus, title: nativeTitle },
  };
  return { calls, deps: {
    runHelper: async (path, args, options) => {
      calls.push({ path, args, env: options.env, signal: options.signal });
      if (missing) throw Object.assign(new Error('Missing helper'), { code: 'ENOENT' });
      return { stdout: 'Owned background browser: port=4567 session=isolated-agent\n' };
    },
    connectOverCDP: async endpoint => {
      calls.push({ endpoint });
      if (connectionFailure) throw new Error('Connection failed');
      return { contexts: () => [{ pages: () => [page] }], close: async () => calls.push({ disconnect: true }) };
    },
  } };
}

test('native capture reuses the helper-owned page and closes the same isolated ownership label', async () => {
  const { calls, deps } = fixture();
  const result = await captureNativePage('https://example.com/article', deps);
  assert.equal(result.url, 'https://example.com/redirected-article');
  assert.match(result.html, /A full article/);
  assert.equal(calls[1].endpoint, 'http://127.0.0.1:4567');
  assert.deepEqual(calls.at(-1).args, ['close']);
  assert.match(calls[0].env.CUA_AGENT_ID, /^bpc-html-\d+-[0-9a-f-]{36}$/);
  assert.equal(calls[0].env.CUA_AGENT_ID, calls.at(-1).env.CUA_AGENT_ID);
});

test('missing optional helper degrades without attaching to any browser', async () => {
  const { calls, deps } = fixture({ missing: true });
  assert.equal(await captureNativePage('https://example.com/article', deps), null);
  assert.equal(calls.length, 1);
});

test('native capture cleans up its helper after a connection failure', async () => {
  const { calls, deps } = fixture({ connectionFailure: true });
  await assert.rejects(captureNativePage('https://example.com/article', deps), /Connection failed/);
  assert.deepEqual(calls.at(-1).args, ['close']);
});

test('already-aborted or credentialed requests do not launch a background browser', async () => {
  const { calls, deps } = fixture();
  const controller = new AbortController();
  controller.abort(new Error('Canceled'));
  await assert.rejects(captureNativePage('https://example.com/article', { ...deps, signal: controller.signal }), /Canceled/);
  await assert.rejects(captureNativePage('https://name:secret@example.com/article', deps), /without credentials/);
  assert.equal(calls.length, 0);
});


test('a missing CDP socket after helper launch still closes the owned native browser', async () => {
  const { calls, deps } = fixture();
  deps.connectOverCDP = async () => { throw Object.assign(new Error('CDP socket missing'), { code: 'ENOENT' }); };
  await assert.rejects(captureNativePage('https://example.com/article', deps), /CDP socket missing/);
  assert.deepEqual(calls.at(-1).args, ['close']);
});


test('native document capture returns validated PDF bytes from the same existing page', async () => {
  const { calls, deps } = fixture();
  const result = await captureNativeDocument('https://example.com/report.pdf', deps);
  assert.ok(Buffer.isBuffer(result.bytes));
  assert.match(result.bytes.toString(), /^%PDF-/);
  assert.equal(result.url, 'https://example.com/report.pdf');
  assert.deepEqual(calls.at(-1).args, ['close']);
});

test('native document capture rejects non-PDF challenge bytes and still closes its helper', async () => {
  const { calls, deps } = fixture({ document: '<html>Bot challenge</html>' });
  await assert.rejects(captureNativeDocument('https://example.com/report.pdf', deps), /did not return a PDF/);
  assert.deepEqual(calls.at(-1).args, ['close']);
});


test('concurrent captures have independent ownership labels and close only their own helper', async () => {
  const first = fixture();
  const second = fixture();
  await Promise.all([
    captureNativePage('https://example.com/first', first.deps),
    captureNativePage('https://example.com/second', second.deps),
  ]);
  const firstLabel = first.calls[0].env.CUA_AGENT_ID;
  const secondLabel = second.calls[0].env.CUA_AGENT_ID;
  assert.notEqual(firstLabel, secondLabel);
  assert.equal(first.calls.at(-1).env.CUA_AGENT_ID, firstLabel);
  assert.equal(second.calls.at(-1).env.CUA_AGENT_ID, secondLabel);
});


test('abort during an in-flight page wait closes the owned browser promptly', async () => {
  const { calls, deps } = fixture();
  const controller = new AbortController();
  const connect = deps.connectOverCDP;
  let rejectWait;
  deps.connectOverCDP = async (...args) => {
    const browser = await connect(...args);
    const page = browser.contexts()[0].pages()[0];
    page.waitForFunction = () => new Promise((resolve, reject) => {
      rejectWait = reject;
      queueMicrotask(() => controller.abort(new Error('Canceled during wait')));
    });
    browser.close = async () => { calls.push({ disconnectedDuringAbort: true }); rejectWait?.(new Error('Browser closed')); };
    return browser;
  };
  await assert.rejects(captureNativePage('https://example.com/article', { ...deps, signal: controller.signal }), /Canceled during wait/);
  assert.ok(calls.some(call => call.disconnectedDuringAbort));
  assert.deepEqual(calls.at(-1).args, ['close']);
});


test('abort during pending helper launch performs final cleanup after launch settlement', async () => {
  const controller = new AbortController();
  let sessionLive = false;
  const labels = [];
  const runHelper = async (path, args, options) => {
    labels.push(options.env.CUA_AGENT_ID);
    if (args[0] === 'open') {
      await new Promise(resolve => setTimeout(resolve, 30));
      sessionLive = true;
      return { stdout: 'port=4567 session=late-owned-browser' };
    }
    sessionLive = false;
    return { stdout: '' };
  };
  const operation = captureNativePage('https://example.com/article', { runHelper, signal: controller.signal });
  controller.abort(new Error('Canceled during launch'));
  await assert.rejects(operation, /Canceled during launch/);
  assert.equal(sessionLive, false);
  assert.equal(new Set(labels).size, 1);
});


test('native HTTP error responses cannot become successful article captures', async () => {
  for (const nativeStatus of [404, 500]) {
    const { calls, deps } = fixture({ nativeStatus });
    await assert.rejects(captureNativePage('https://example.com/article', deps), new RegExp(`HTTP ${nativeStatus}`));
    assert.deepEqual(calls.at(-1).args, ['close']);
  }
});

test('native200 error-title pages are rejected conservatively', async () => {
  for (const nativeTitle of ['Page not found | Publisher', '404 Not Found — Publisher']) {
    const { calls, deps } = fixture({ nativeTitle });
    await assert.rejects(captureNativePage('https://example.com/article', deps), /error page/);
    assert.deepEqual(calls.at(-1).args, ['close']);
  }
});
