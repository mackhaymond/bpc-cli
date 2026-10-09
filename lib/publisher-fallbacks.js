const stopWords = new Set(['the', 'a', 'an', 'to', 'of', 'and', 'in', 'on', 'for', 'with', 'roi', 'column', 'commentary']);

function words(text) {
  return text.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(word => word && !stopWords.has(word));
}

export function matchesHeadline(expected, actual) {
  // Reuters slug titles omit common function words. Only remove recognized
  // column decorations: arbitrary added/removed terms can reverse a story.
  const headline = actual.replace(/^\s*(?:ROI[-–—:]\s*|COLUMN[-–—:]\s*)/i, '')
    .replace(/:\s*(?:Andy Home|Clyde Russell|John Kemp)\s*$/i, '');
  const wanted = words(expected);
  const candidate = words(headline);
  return wanted.length >= 4 && wanted.length === candidate.length &&
    wanted.every((word, index) => word === candidate[index]);
}

export async function findReutersSyndication(input, { signal, fetchImpl = fetch } = {}) {
  const original = new URL(input);
  if (!/(^|\.)reuters\.com$/.test(original.hostname)) return null;
  const slug = original.pathname.split('/').filter(Boolean).at(-1) || '';
  const match = slug.match(/^(.*)-(\d{4}-\d{2}-\d{2})$/);
  if (!match || words(match[1]).length < 4) return null;
  const date = new Date(`${match[2]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  const day = offset => new Date(date.getTime() + offset * 86400000).toISOString().slice(0, 10);
  const query = words(match[1]).slice(0, 2).join(' ');
  // This is the same date-scoped search endpoint used by Devdiscourse's /Search
  // page. Resolve each story live; no article IDs or newsletter URLs are baked in.
  const segments = [query, 'News', 'all', 'all', 'Global Edition', day(1), day(-1), '1'];
  const endpoint = 'https://www.devdiscourse.com/api/Search/GetAdvancedSearch/' + segments.map(encodeURIComponent).join('/');
  const response = await fetchImpl(endpoint, { signal });
  if (!response.ok) return null;
  const items = await response.json();
  if (!Array.isArray(items)) return null;
  const item = items.find(item => {
    const created = Date.parse(item.createdOn);
    return item.type === 'News' && Number.isSafeInteger(item.newsId) && item.newsId > 0 &&
      created >= date.getTime() - 86400000 && created < date.getTime() + 2 * 86400000 &&
      typeof item.title === 'string' && matchesHeadline(match[1], item.title);
  });
  if (!item) return null;
  const titleSlug = item.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    originalUrl: original.href,
    url: `https://www.devdiscourse.com/article/international/${item.newsId}-${titleSlug}`,
    expectedHeadline: match[1],
  };
}
