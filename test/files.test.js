import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function reportPdf() {
  const stream = text => `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream('First report page has original source data.').length} >>\nstream\n${stream('First report page has original source data.')}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${stream('Final report page retains the conclusion.').length} >>\nstream\n${stream('Final report page retains the conclusion.')}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const pdf = reportPdf();
const csv = Buffer.from('source,value\nfirst,42\nlast,99\n');
const cli = fileURLToPath(new URL('../bin/bpc-html.js', import.meta.url));
const popplerAvailable = !spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).error;
let server, base, dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bpc-file-tests-'));
  server = createServer((req, res) => {
    if (req.url === '/go') { res.writeHead(302, { location: '/report.pdf' }); res.end(); return; }
    if (req.url === '/protected.pdf' && !req.headers['user-agent'].includes('Googlebot')) {
      res.writeHead(403); res.end(); return;
    }
    if (req.url === '/partial.pdf' || req.url === '/range.pdf') {
      const complete = req.url === '/range.pdf' && req.headers.range === `bytes=0-${pdf.length - 1}`;
      const part = complete ? pdf : pdf.subarray(0, Math.floor(pdf.length / 2));
      res.writeHead(206, { 'content-type': 'application/pdf', 'content-length': part.length,
        'content-range': `bytes 0-${part.length - 1}/${pdf.length}` });
      res.end(part); return;
    }
    const body = req.url === '/data.csv' ? csv : pdf;
    res.writeHead(200, { 'content-type': req.url === '/data.csv' ? 'text/csv' : 'application/pdf', 'content-length': body.length });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args]);
    let stderr = ''; const stdout = [];
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => stdout.push(data));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr, stdout: Buffer.concat(stdout) }));
  });
}

test('redirected PDF and CSV links return original file bytes, including in a mixed Markdown batch', async () => {
  for (const [path, expected] of [['/go', pdf], ['/data.csv', csv]]) {
    const output = join(dir, 'download');
    const result = await run([`${base}${path}`, '--no-bypass', '--markdown', '--native-files', '-o', output]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(await readFile(output), expected);
  }
});

test('PDF downloads preserve the extension-modified request headers', async () => {
  const rules = join(dir, 'rules.json');
  await writeFile(rules, JSON.stringify({ Fixture: { domain: '127.0.0.1', useragent: 'googlebot', allow_cookies: 1 } }));
  const output = join(dir, 'protected.pdf');
  const result = await run([`${base}/protected.pdf`, '--custom-rules', rules, '-o', output]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readFile(output), pdf);
});

test('optional PDF Markdown conversion retains both pages and the final conclusion', { skip: !popplerAvailable }, async () => {
  const result = await run([`${base}/report.pdf`, '--no-bypass', '--markdown']);
  assert.equal(result.code, 0, result.stderr);
  const markdown = result.stdout.toString();
  assert.match(markdown, /## Page 1/);
  assert.match(markdown, /## Page 2/);
  assert.match(markdown, /First report page has original source data/);
  assert.match(markdown, /Final report page retains the conclusion/);
  assert.match(markdown, /Figures and visual layout are not reproduced/);
});

test('native downloads retry complete ranges and reject incomplete files without overwriting output', async () => {
  const output = join(dir, 'range.pdf');
  const repaired = await run([`${base}/range.pdf`, '--no-bypass', '-o', output]);
  assert.equal(repaired.code, 0, repaired.stderr);
  assert.deepEqual(await readFile(output), pdf);
  await writeFile(output, 'Existing original');
  const incomplete = await run([`${base}/partial.pdf`, '--no-bypass', '-o', output]);
  assert.equal(incomplete.code, 1);
  assert.equal(incomplete.stdout.length, 0);
  assert.match(incomplete.stderr, /incomplete file/);
  assert.equal(await readFile(output, 'utf8'), 'Existing original');
});
