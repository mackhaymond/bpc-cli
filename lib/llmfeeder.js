import { readFile } from 'node:fs/promises';

const sourcePaths = ['libs/readability.js', 'libs/turndown.js', 'shortcut-utils.js', 'settings.js', 'content.js'];
const sources = await Promise.all(sourcePaths.map(path => readFile(new URL(`../vendor/llmfeeder/${path}`, import.meta.url), 'utf8')));

// LLMFeeder's processing backend lives in its content script. Use the unchanged
// sources and normal convertToMarkdown message, replacing only the extension
// transport with an in-process callback. An isolated world keeps website scripts
// from reading or replacing our converter while sharing the post-BPC page DOM.
export async function convertPageToMarkdown(page, { log = () => {}, contentScope = 'mainContent', contentSelector } = {}) {
  const session = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const { executionContextId } = await session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'bpc-cli-llmfeeder',
    });
    async function evaluate(expression, awaitPromise = false) {
      const response = await session.send('Runtime.evaluate', {
        expression, contextId: executionContextId, awaitPromise, returnByValue: true,
      });
      if (response.exceptionDetails)
        throw new Error(`LLMFeeder: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`);
      return response.result.value;
    }
    await evaluate(`globalThis.browser = {
      runtime: {
        onMessage: {
          addListener(listener) { globalThis.__bpcLlmFeederHandler = listener; },
          removeListener() {}
        },
        async sendMessage() { return { success: true, bindings: [] }; }
      }
    };`);
    for (let i = 0; i < sources.length; i++) await evaluate(`${sources[i]}\n//# sourceURL=llmfeeder/${sourcePaths[i]}`);
    const result = await evaluate(`(async () => {
      const settings = await SettingsUtils.getUserSettings({
        storage: { sync: { async get(defaults) { return defaults; } } }
      });
      settings.contentScope = ${JSON.stringify(contentScope)};
      const normalize = text => text.normalize('NFKC')
        .replace(/\\\\([^\\w])/g, '$1').replace(/\\]\\([^)]*\\)/g, ']')
        .replace(/[\\[\\]*_\\u00ad\\u200b]/g, '').replace(/\\s+/g, ' ').trim();
      const selector = ${JSON.stringify(contentSelector ?? null)};
      const selectedRegion = selector ? document.querySelector(selector) : null;
      if (selector && !selectedRegion)
        return { success: false, error: 'Requested content region was not found' };
      const convert = async (content = selectedRegion?.cloneNode(true)) => {
        const dispatch = () => new Promise(resolve => {
          __bpcLlmFeederHandler({ action: 'convertToMarkdown', settings }, {}, resolve);
        });
        if (!content) return dispatch();
        // Scope the converter's detached document, keeping the live DOM,
        // original location and title available for source attribution.
        const descriptor = Object.getOwnPropertyDescriptor(document, 'cloneNode');
        const nativeClone = document.cloneNode.bind(document);
        document.cloneNode = deep => {
          const clone = nativeClone(deep);
          const scopedContent = content.cloneNode(true);
          scopedContent.querySelectorAll('h1').forEach(node => {
            if (normalize(document.title).includes(normalize(node.textContent))) node.remove();
          });
          clone.body.replaceChildren(scopedContent);
          return clone;
        };
        try { return await dispatch(); }
        finally {
          if (descriptor) Object.defineProperty(document, 'cloneNode', descriptor);
          else delete document.cloneNode;
        }
      };
      const result = await convert();
      const visibleRegion = region => getComputedStyle(region).visibility !== 'hidden' &&
        (region.getClientRects().length || Array.from(region.querySelectorAll('p')).some(node => node.getClientRects().length));
      const bodies = (selectedRegion ? [selectedRegion] : Array.from(document.querySelectorAll('.n-content-body, [data-testid="article-body"], .article-body, [itemprop="articleBody"], .entry-content, .post-content, .article-content, .article__content, .rich-text, .node-documents, .gwm_ts_body.report_flagship')))
        .filter(visibleRegion);
      const regions = (bodies.length ? bodies : Array.from(document.querySelectorAll('main, article, [role="main"]')))
        .filter(visibleRegion)
        .map(region => {
          const clone = region.cloneNode(true);
          clone.querySelectorAll('nav, footer, form, .comments, .ads, .sidebar, [role="navigation"], [aria-hidden="true"]').forEach(node => node.remove());
          return { clone, original: region, length: clone.textContent.length };
        }).sort((a, b) => b.length - a.length);
      const region = regions[0];
      if (!region || region.length < (bodies.length ? 150 : 500)) return result;
      const blocks = Array.from(region.original.querySelectorAll('p, li, div, blockquote, figcaption'))
        .filter(node => !node.querySelector('p, li, div, blockquote, figcaption'))
        .filter(node => {
          const excluded = node.closest('nav, footer, form, .comments, .ads, .sidebar, [role="navigation"], [aria-hidden="true"]');
          return node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' &&
            (!excluded || !region.original.contains(excluded));
        })
        .map(node => normalize(node.innerText))
        .filter(text => text.split(' ').length >= 12 || /[\\u3400-\\u9fff]/.test(text) && text.length >= 40);
      const originalText = normalize(result.markdown || '');
      const missing = blocks.filter(text => !originalText.includes(text));
      if (!missing.length) return result;

      // Readability can discard a feature's standfirst or chart notes. Run
      // LLMFeeder's full-page mode on a clone of the semantic content region.
      // The live page and upstream converter remain unchanged.
      settings.contentScope = 'fullPage';
      const repaired = await convert(region.clone);
      if (!repaired.success) return result;
      const repairedText = normalize(repaired.markdown);
      const remaining = blocks.filter(text => !repairedText.includes(text));
      if (remaining.length >= missing.length) return result;
      return { ...repaired, preservedBlocks: missing.length - remaining.length };
    })()`, true);
    if (!result?.success || typeof result.markdown !== 'string' || !result.markdown.trim())
      throw new Error(`LLMFeeder: ${result?.details || result?.error || 'No Markdown returned'}`);
    if (result.preservedBlocks) log(`Preserved ${result.preservedBlocks} content blocks omitted by Readability`);
    return result.markdown.trimEnd() + '\n';
  } finally {
    await session.detach().catch(() => {});
  }
}
