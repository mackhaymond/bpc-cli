import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/bpc-html.js', import.meta.url));
let server, base, dir;
const seen = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bpc-test-'));
  server = createServer((req, res) => {
    seen.push({ path: req.url, ua: req.headers['user-agent'] });
    if (req.url === '/start') { res.writeHead(302, { Location: '/middle' }); res.end(); }
    else if (req.url === '/middle') { res.writeHead(307, { Location: '/js-redirect' }); res.end(); }
    else if (req.url === '/js-redirect') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<script>location.replace("/article")</script>');
    } else if (req.url === '/error') { res.writeHead(403); res.end('Forbidden'); }
    else if (req.url === '/challenge') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Just a moment...</title><body>Checking your browser</body>');
    } else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
    else if (req.url === '/formatted') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>Markdown fixture</title><body><nav>UNRELATED NAVIGATION</nav><article>
        <h1>Markdown fixture</h1>
        ${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i + 1}: This sufficiently long fixture paragraph describes meaningful article content so that Readability can identify the article. It includes punctuation, context, and complete sentences for extraction.</p>`).join('')}
        <p>The final paragraph has <strong>bold text</strong> and <a href="https://example.com/source">a source link</a>.</p>
        <pre><code class="language-js">const answer = 42;</code></pre>
        <table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Sample</td><td>42</td></tr></tbody></table>
        </article><footer>UNRELATED FOOTER</footer></body>`);
    }
    else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Fixture article</title><body><div id="wall">Subscribe</div><article hidden>Complete fixture article.</article><script>setTimeout(() => document.body.dataset.rendered="yes", 100)</script></body>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('HTTP and JavaScript redirects return the final rendered document on stdout', async () => {
  const result = await run([`${base}/start`, '--no-bypass', '--wait', '0.3', '--verbose']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^<!DOCTYPE html>/i);
  assert.match(result.stdout, /Complete fixture article/);
  assert.match(result.stdout, /data-rendered="yes"/);
  assert.match(result.stderr, /\/article;/);
  assert.doesNotMatch(result.stdout, /HTTP 200;/);
  assert.ok(['/start', '/middle', '/js-redirect', '/article'].every(path => seen.some(request => request.path === path)));
});

test('real BPC modifies request headers and removes a fixture paywall through custom rules', async () => {
  const rulesFile = join(dir, 'rules.json');
  const output = join(dir, 'article.html');
  await writeFile(rulesFile, JSON.stringify({ Fixture: {
    domain: '127.0.0.1', useragent: 'googlebot', allow_cookies: 1,
    cs_code: [{ cond: '#wall', rm_elem: 1 }, { cond: 'article', rm_attrib: 'hidden' }],
  } }));
  const result = await run([`${base}/start`, '--custom-rules', rulesFile,
    '--selector', 'article:not([hidden])', '--wait', '3', '-o', output, '--verbose']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /BPC 4\.4\.6\.6; \d+ browser request rules loaded/);
  const html = await readFile(output, 'utf8');
  assert.doesNotMatch(html, /id="wall"/);
  assert.match(html, /<article>Complete fixture article\.<\/article>/);
  assert.ok(seen.some(request => request.path === '/article' && request.ua.includes('Googlebot')));
});

test('errors are nonzero with no HTML on stdout', async () => {
  for (const path of ['/error', '/challenge', '/loop']) {
    const result = await run([`${base}${path}`, '--no-bypass', '--wait', '0', '--timeout', '10']);
    assert.equal(result.code, 1, `${path}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /HTTP 403|bot challenge|TOO_MANY_REDIRECTS/);
  }
});

test('deadline stops a missing selector without returning partial HTML', async () => {
  const started = Date.now();
  const result = await run([`${base}/article`, '--no-bypass', '--selector', '#missing', '--wait', '0', '--timeout', '3']);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /[Tt]imeout|Timed out/);
  assert.ok(Date.now() - started < 8000);
});

test('rejects invalid input before launching a browser', async () => {
  for (const args of [['file:///etc/hosts'], ['https://example.com', '--timeout', 'NaN'], ['https://example.com', '--wait', '60'], []]) {
    const result = await run(args);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^bpc-html:/);
  }
});

test('LLMFeeder extracts the article and preserves Markdown links, code, tables and source metadata', async () => {
  const output = join(dir, 'fixture.md');
  const result = await run([`${base}/formatted`, '--no-bypass', '--markdown', '-o', output, '--wait', '0', '--verbose']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /LLMFeeder 2\.2\.1/);
  const markdown = await readFile(output, 'utf8');
  assert.match(markdown, /^# Markdown fixture/);
  assert.match(markdown, /Paragraph 1:/);
  assert.match(markdown, /Paragraph 8:/);
  assert.match(markdown, /\*\*bold text\*\*/);
  assert.match(markdown, /\[a source link\]\(https:\/\/example\.com\/source\)/);
  assert.match(markdown, /```(?:js)?\nconst answer = 42;\n```/);
  assert.match(markdown, /\| Name \| Value \|/);
  assert.match(markdown, /Source: \[Markdown fixture\]/);
  assert.doesNotMatch(markdown, /UNRELATED NAVIGATION|UNRELATED FOOTER/);
});
