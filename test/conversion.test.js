import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { convertPageToMarkdown } from '../lib/llmfeeder.js';

test('full-page conversion retains separate report pages and Unicode text', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><title>Energy report</title><body>
      <h1>Energy report</h1>
      <section><h2>Page 1</h2><p>The first report page discusses electricity transmission, investment requirements and the importance of reliable regional energy infrastructure for households and businesses.</p></section>
      <section><h2>Page 2</h2><p>第二页：全球电力需求持续增长，电网投资对可靠供应至关重要。</p><p>The second report page gives independent evidence about energy demand and explains the assumptions used to compare different investment scenarios.</p></section>
    </body>`);
    const markdown = await convertPageToMarkdown(page, { contentScope: 'fullPage' });
    assert.match(markdown, /Page 1/);
    assert.match(markdown, /Page 2/);
    assert.match(markdown, /first report page discusses electricity transmission/);
    assert.match(markdown, /第二页：全球电力需求持续增长/);
    assert.match(markdown, /second report page gives independent evidence/);
  } finally {
    await browser.close();
  }
});

test('document annotations remain alongside the primary transcript', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><title>Energy policy address</title><body>
      <h1>Energy policy address</h1>
      <main aria-hidden="true"><div class="node-documents"><div class="row"><div class="col-sm-8">
        <div class="field-docs-content">${Array.from({ length: 8 }, (_, i) => `<p>Transcript section ${i + 1}: This speech explains the national energy policy, the supply challenges facing the country and the coordinated steps required to keep electricity and fuel available to households. The policy combines immediate measures with investment in infrastructure, improving transparency while protecting consumers.</p>`).join('')}</div>
        <div class="field-docs-footnote"><p>Editorial note: The address was delivered at the White House and broadcast on national television. An advance text was released the same day.</p><p>The accompanying fact sheet describes the policy assumptions and provides essential context for interpreting the figures and commitments made in this address.</p></div>
      </div></div></div></main>
      <footer>Unrelated site footer</footer>
    </body>`);
    const markdown = await convertPageToMarkdown(page);
    assert.match(markdown, /Transcript section 8:/);
    assert.match(markdown, /Editorial note: The address was delivered/);
    assert.match(markdown, /accompanying fact sheet describes the policy assumptions/);
    assert.doesNotMatch(markdown, /Unrelated site footer/);
  } finally {
    await browser.close();
  }
});

test('cookie accessibility overlays do not hide rich-text prose and list items from conversion', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><title>Coordinated energy response</title>
      <body><main aria-hidden="true"><div class="rich-text">
        <div>The leaders met to discuss the global energy situation and agreed that their response to rising fuel prices must be coordinated across countries.</div>
        <ul><li>The countries will optimize refinery production and coordinate the release of strategic reserves to improve energy supply and market stability.</li><li>Export restrictions will be avoided so that energy markets can continue to operate and consumers can benefit from lower fuel prices.</li></ul>
      </div></main><div role="dialog"><h2>Cookies management panel</h2><p>This website uses cookies to measure its audience and provide third party services. Please review your privacy preferences before continuing to use these services.</p></div></body>`);
    const markdown = await convertPageToMarkdown(page);
    assert.match(markdown, /leaders met to discuss the global energy situation/);
    assert.match(markdown, /countries will optimize refinery production/);
    assert.match(markdown, /Export restrictions will be avoided/);
    assert.doesNotMatch(markdown, /Cookies management panel/);
  } finally {
    await browser.close();
  }
});

test('scoped full-page conversion includes article introductions and captions while preserving source metadata', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = 'https://publisher.test/interactive-report/';
    await page.route(url, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Interactive energy report</title><body>
      <header>UNRELATED SITE HEADER</header>
      <article class="feature"><h1>Interactive energy report</h1>
        <section><p>The introductory summary gives important context for the full interactive report and explains the assumptions behind the diagrams and projections.</p></section>
        <div class="article-body"><p>The principal article describes the evidence and explains the consequences of the infrastructure choices available to governments and energy producers.</p></div>
        <figure><figcaption>The chart annotation explains the boundaries of the analysis and identifies the data used to compare energy infrastructure costs and supply risks.</figcaption></figure>
      </article><footer>UNRELATED SITE FOOTER</footer></body>` }));
    await page.goto(url);
    const markdown = await convertPageToMarkdown(page, { contentScope: 'fullPage', contentSelector: 'article.feature' });
    assert.match(markdown, /introductory summary gives important context/);
    assert.match(markdown, /principal article describes the evidence/);
    assert.match(markdown, /chart annotation explains the boundaries/);
    assert.match(markdown, /^# Interactive energy report/);
    assert.ok(markdown.includes(`Source: [Interactive energy report](${url})`));
    assert.doesNotMatch(markdown, /UNRELATED SITE HEADER|UNRELATED SITE FOOTER/);
    assert.equal(page.url(), url);
    assert.equal(await page.title(), 'Interactive energy report');
    assert.equal(await page.locator('header').innerText(), 'UNRELATED SITE HEADER');
  } finally {
    await browser.close();
  }
});
