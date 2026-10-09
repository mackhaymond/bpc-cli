import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findReutersSyndication, matchesHeadline } from '../lib/publisher-fallbacks.js';

const url = 'https://www.reuters.com/commentary/tin-rides-ai-investment-wave-new-price-dimension-2026-10-07/';
const article = {
  type: 'News', newsId: 12345, createdOn: '2026-10-07T13:36:00Z',
  title: 'ROI-Tin rides the AI investment wave to a new price dimension: Andy Home',
};

test('syndication lookup finds the matching headline within the publication date window', async () => {
  let requested;
  const result = await findReutersSyndication(url, { fetchImpl: async endpoint => {
    requested = endpoint;
    return { ok: true, json: async () => [{ ...article, title: 'Unrelated tin market report' }, article] };
  } });
  assert.match(requested, /tin%20rides\/News\/all\/all\/Global%20Edition\/2026-10-08\/2026-10-06\/1$/);
  assert.equal(result.originalUrl, url);
  assert.equal(new URL(result.url).hostname, 'www.devdiscourse.com');
  assert.match(result.url, /12345-roi-tin-rides-the-ai-investment-wave/);
});

test('syndication lookup rejects mismatched titles, dates, IDs and unavailable search results', async () => {
  for (const item of [
    { ...article, title: 'Another investment story' },
    { ...article, createdOn: '2025-10-07T00:00:00Z' },
    { ...article, newsId: '../wrong-destination' },
  ]) {
    const result = await findReutersSyndication(url, { fetchImpl: async () => ({ ok: true, json: async () => [item] }) });
    assert.equal(result, null);
  }
  assert.equal(await findReutersSyndication(url, { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(matchesHeadline('tin rides ai investment wave new price dimension', 'AI investment outlook'), false);
});

test('syndication lookup only requests the supported publisher and dated article URLs', async () => {
  const fetchImpl = () => { throw new Error('Must not request another publisher'); };
  assert.equal(await findReutersSyndication('https://example.com/article', { fetchImpl }), null);
  assert.equal(await findReutersSyndication('https://www.reuters.com/', { fetchImpl }), null);
});


test('headline matching rejects the same factual words in a contradictory order', async () => {
  const requested = 'oil-prices-rise-as-middle-east-tensions-ease-and-demand-forecast-improves';
  const opposite = 'Oil prices ease as Middle East tensions rise and demand forecast improves';
  assert.equal(matchesHeadline(requested, opposite), false);
  assert.equal(matchesHeadline(requested, 'ROI-Oil prices rise as Middle East tensions ease and demand forecast improves: Andy Home'), true);
  const result = await findReutersSyndication(`https://www.reuters.com/business/energy/${requested}-2026-10-07/`, {
    fetchImpl: async () => ({ ok: true, json: async () => [{ ...article, title: opposite }] }),
  });
  assert.equal(result, null);
});

test('headline matching normalizes publisher apostrophes while retaining ordered identity', () => {
  assert.equal(matchesHeadline('uaes-adnoc-buys-millions-barrels-iraqi-crude-sources-say',
    "UAE’s ADNOC buys millions of barrels of Iraqi crude, sources say"), true);
});


test('headline matching never drops a negation or changes a single factual term', () => {
  assert.equal(matchesHeadline('oil-prices-rise-after-iran-says-it-will-not-close-strait-hormuz',
    'Oil prices rise after Iran says it will close Strait Hormuz'), false);
  assert.equal(matchesHeadline('oil-prices-rise-on-growing-middle-east-tensions-as-investors-weigh-demand-outlook',
    'Oil prices fall on growing Middle East tensions as investors weigh demand outlook'), false);
});


test('headline matching rejects added negation or other substantive terms', () => {
  assert.equal(matchesHeadline('oil-prices-rise-after-iran-says-it-will-close-strait-hormuz',
    'Oil prices rise after Iran says it will not close Strait Hormuz'), false);
  assert.equal(matchesHeadline('oil-prices-rise-on-growing-middle-east-tensions-as-investors-weigh-demand-outlook',
    'Oil prices fail to rise on growing Middle East tensions as investors weigh demand outlook'), false);
});
