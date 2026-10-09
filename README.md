# BPC CLI

Fetch a URL in isolated headless Chromium, run Bypass Paywalls Clean's site rules,
and return the rendered HTML. Add `--markdown` to run the resulting page through
LLMFeeder's actual local conversion engine and return Markdown.

HTTP redirects, JavaScript redirects, and extension-driven navigations are
followed automatically. Each invocation has a fresh browser profile. It does not
open a visible window or use your existing browser sessions.

## Install

Requires Node.js 22 or newer.

```sh
git clone https://github.com/mackhaymond/bpc-cli.git
cd bpc-cli
npm ci
npm run setup
npm link
```

You can also run `node bin/bpc-html.js` directly without `npm link`.
On Linux, install Chromium's system dependencies if needed with
`npx playwright install --with-deps chromium`.

## Use

```sh
# HTML to stdout (logs and errors stay on stderr)
bpc-html 'https://example.com/article' > article.html

# HTML directly to a file
bpc-html 'https://example.com/article' -o article.html

# Markdown directly to a file
bpc-html 'https://example.com/article' --markdown -o article.md

# Markdown to stdout
bpc-html 'https://example.com/article' --markdown > article.md

# FT article tested end to end
bpc-html 'https://www.ft.com/content/dbd6e14c-2d47-4f6b-9981-98a42e172097' \
  --markdown --wait 10 --selector '.n-content-body' -o article.md

# Allow extra processing time, require the article, and show diagnostics
bpc-html 'https://example.com/article' --wait 10 --timeout 90 \
  --selector 'article' --verbose -o article.html

# Import a BPC custom-sites export for this invocation
bpc-html 'https://example.com/article' --custom-rules rules.json -o article.html

# Compare the page without BPC
bpc-html 'https://example.com/article' --no-bypass -o original.html
```

`--wait` is the minimum processing time after the initial navigation (5 seconds
by default). A quiet DOM interval follows, capped at 5 additional seconds for
pages with continuously changing ads. `--selector` requires a visible element
before export; it does not restrict the exported document. `--timeout` bounds
the browser startup, fetch, waits, and Markdown conversion together (60 seconds
by default). Browser shutdown may take a little additional time.

`--user-agent` overrides the default regular desktop Chrome user agent. The
default Chrome major version comes from the pinned Playwright browser metadata.
BPC's own per-site header rules can override it.

LLMFeeder has [no hosted conversion backend](https://github.com/jatinkrmalik/LLMFeeder#privacy--security).
The `--markdown` option invokes its unchanged content-script conversion handler
inside an isolated JavaScript world on the page after BPC finishes. It uses
LLMFeeder's default main-content extraction, Readability, Turndown, table and code
formatting, image and link processing, and title/source metadata. Conversion
stays local and does not require an API key or another server.

To embed the pipeline in Node.js:

```js
import { fetchHtml } from './lib/fetch-html.js';

const result = await fetchHtml('https://example.com/article', { markdown: true });
// result.html, result.markdown, result.url, result.status, result.title
```

## Behavior and limits

This runs the real BPC extension rather than reimplementing selected rules.
The extension's supplied custom-site manifest enables requests to article and
archive sources inside the temporary browser. The upstream JavaScript is
unchanged. The CLI enables the default supported sites and cookie-setting rules
and disables opt-in remote rule updates. BPC can make requests to alternate
article sources, including archives, when its rules require them. Its startup
may also check the upstream extension version.

Output is a snapshot of the rendered top-level DOM, including the doctype; it is
not an offline bundle of images and stylesheets. The Markdown converter extracts
the main content using LLMFeeder's normal rules.

Site support and content availability depend on upstream BPC rules. A successful
export does not itself prove the article is complete. HTTP errors and recognized
bot-challenge pages fail with exit code 1 and produce no document. Other paywall
or application-error pages can still return HTTP 200; use `--selector` and inspect
the output for important documents. Unsupported domains return their normally
rendered page.

## Verification

```sh
npm test
```

The integration suite checks HTTP and JavaScript redirects, real BPC header
modification and paywall removal, clean stdout/file output, HTTP/challenge errors,
timeouts, invalid input, and LLMFeeder article extraction with links, fenced code,
tables, and source metadata.

Live verification on macOS on 2026-10-09 followed a newsletter redirect to the
FT article and returned HTTP 200 with BPC 4.4.6.6 and 800 request rules active.
The generated Markdown was 5,798 bytes and retained all 14 article-body
paragraphs from the fetched HTML, along with the title and final source URL.
The fetched HTML had no FT paywall container. Generated articles and local
verification artifacts stay in the gitignored `artifacts/` directory.

## Sources and licenses

Source provenance is recorded in [vendor/provenance.json](vendor/provenance.json).

- BPC 4.4.6.6: [upstream project](https://gitflic.ru/project/magnolia1234/bypass-paywalls-chrome-clean),
  using the master ZIP linked by its README. Its MIT notices remain in the vendor
  directory and at the project root.
- LLMFeeder 2.2.1: [upstream repository](https://github.com/jatinkrmalik/LLMFeeder),
  pinned to commit `32f0f8b27d8bede59e886a63c81736c02f266747`. Its MIT license and
  the vendored Readability Apache-2.0 and Turndown MIT licenses are included.
- Playwright 1.64.0 is pinned in the package file and lockfile.

The upstream sources are vendored, so running the CLI does not download newer
conversion or extension code. Keep their notices when redistributing.
