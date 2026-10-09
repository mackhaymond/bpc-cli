import { readFile } from 'node:fs/promises';

const sourcePaths = ['libs/readability.js', 'libs/turndown.js', 'shortcut-utils.js', 'settings.js', 'content.js'];
const sources = await Promise.all(sourcePaths.map(path => readFile(new URL(`../vendor/llmfeeder/${path}`, import.meta.url), 'utf8')));

// LLMFeeder's processing backend lives in its content script. Use the unchanged
// sources and normal convertToMarkdown message, replacing only the extension
// transport with an in-process callback. An isolated world keeps website scripts
// from reading or replacing our converter while sharing the post-BPC page DOM.
export async function convertPageToMarkdown(page, { log = () => {} } = {}) {
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
      const convert = () => new Promise(resolve => {
        __bpcLlmFeederHandler({ action: 'convertToMarkdown', settings }, {}, resolve);
      });
      const result = await convert();
      if (!result.success) return result;
      const normalize = text => text.normalize('NFKC')
        .replace(/\\\\([^\\w])/g, '$1').replace(/\\]\\([^)]*\\)/g, ']')
        .replace(/[\\[\\]*_\\u00ad\\u200b]/g, '').replace(/\\s+/g, ' ').trim();
      const body = document.querySelector('.n-content-body, [data-testid="article-body"], .article-body');
      const regions = (body ? [body] : Array.from(document.querySelectorAll('main, article, [role="main"]')))
        .filter(region => region.getClientRects().length)
        .map(region => {
          const clone = region.cloneNode(true);
          clone.querySelectorAll('nav, footer, form, .comments, .ads, .sidebar, [role="navigation"], [aria-hidden="true"]').forEach(node => node.remove());
          return { clone, original: region, length: clone.textContent.length };
        }).sort((a, b) => b.length - a.length);
      const region = regions[0];
      if (!region || region.length < 500) return result;
      const paragraphs = Array.from(region.original.querySelectorAll('p'))
        .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden' &&
          !node.closest('nav, footer, form, .comments, .ads, .sidebar, [role="navigation"], [aria-hidden="true"]'))
        .map(node => normalize(node.innerText))
        .filter(text => text.split(' ').length >= 12);
      const originalText = normalize(result.markdown);
      const missing = paragraphs.filter(text => !originalText.includes(text));
      if (!missing.length) return result;

      // Readability can discard a feature's standfirst or chart notes. Run
      // LLMFeeder's full-page mode on a clone of the semantic content region.
      // The live page and upstream converter remain unchanged.
      const nativeClone = document.cloneNode.bind(document);
      document.cloneNode = deep => {
        const clone = nativeClone(deep);
        const content = region.clone.cloneNode(true);
        content.querySelectorAll('h1').forEach(node => {
          if (normalize(document.title).includes(normalize(node.textContent))) node.remove();
        });
        clone.body.replaceChildren(content);
        return clone;
      };
      try {
        settings.contentScope = 'fullPage';
        const repaired = await convert();
        if (!repaired.success) return result;
        const repairedText = normalize(repaired.markdown);
        const remaining = paragraphs.filter(text => !repairedText.includes(text));
        if (remaining.length >= missing.length) return result;
        return { ...repaired, preservedParagraphs: missing.length - remaining.length };
      } finally {
        delete document.cloneNode;
      }
    })()`, true);
    if (!result?.success || typeof result.markdown !== 'string' || !result.markdown.trim())
      throw new Error(`LLMFeeder: ${result?.details || result?.error || 'No Markdown returned'}`);
    if (result.preservedParagraphs) log(`Preserved ${result.preservedParagraphs} paragraphs omitted by Readability`);
    return result.markdown.trimEnd() + '\n';
  } finally {
    await session.detach().catch(() => {});
  }
}
