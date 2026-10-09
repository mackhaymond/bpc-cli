#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { fetchHtml } from '../lib/fetch-html.js';

process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exitCode = 0;
  else { process.stderr.write(`bpc-html: ${error.message}\n`); process.exitCode = 1; }
});

const help = `Usage: bpc-html <http(s)://url> [options]

Run Bypass Paywalls Clean in a fresh headless Chromium browser.
The rendered HTML goes to stdout; diagnostics go to stderr.
Use --markdown to process the page through LLMFeeder's local converter.

Options:
  -o, --output <file>       Save output to a file instead of stdout
  -m, --markdown            Output Markdown through LLMFeeder instead of HTML
      --native-files        Keep file links as original bytes even with --markdown
      --wait <seconds>      Minimum processing time after navigation (default: 5)
      --timeout <seconds>   Total time limit including browser startup (default: 60)
      --selector <css>      Require a visible element before exporting HTML
      --custom-rules <file> Import a BPC custom-sites JSON file for this invocation
      --user-agent <text>   Set the browser user agent (site rules may override it)
      --no-bypass           Render without BPC (for comparison)
  -v, --verbose             Print version, rule count, URL, and HTTP status to stderr
  -h, --help                Show help

Examples:
  bpc-html 'https://example.com/article' > article.html
  bpc-html 'https://example.com/article' -o article.html --wait 10
  bpc-html 'https://example.com/article' --markdown -o article.md
`;

function seconds(value, name, minimum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > 3600)
    throw new Error(`${name} must be between ${minimum} and 3600 seconds`);
  return number * 1000;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      markdown: { type: 'boolean', short: 'm', default: false },
      'native-files': { type: 'boolean', default: false },
      wait: { type: 'string', default: '5' },
      timeout: { type: 'string', default: '60' },
      selector: { type: 'string' },
      'custom-rules': { type: 'string' },
      'user-agent': { type: 'string' },
      'no-bypass': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(help);
  } else {
    if (positionals.length !== 1) throw new Error('Pass exactly one HTTP(S) URL. Use --help for usage.');
    const waitMs = seconds(values.wait, '--wait', 0);
    const timeoutMs = seconds(values.timeout, '--timeout', 1);
    if (waitMs >= timeoutMs) throw new Error('--wait must be less than --timeout');
    const result = await fetchHtml(positionals[0], {
      waitMs, timeoutMs,
      selector: values.selector,
      customRulesPath: values['custom-rules'],
      userAgent: values['user-agent'],
      markdown: values.markdown,
      nativeFiles: values['native-files'],
      bypass: !values['no-bypass'],
      log: message => { if (values.verbose) process.stderr.write(`${message}\n`); },
    });
    const output = result.data ?? (values.markdown ? result.markdown : result.html);
    if (values.output) await writeFile(values.output, output, 'utf8');
    else await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
  }
} catch (error) {
  if (error.code === 'EPIPE') process.exitCode = 0;
  else {
    process.stderr.write(`bpc-html: ${error.message}\n`);
    process.exitCode = 1;
  }
}
