import { readFile } from 'node:fs/promises';

const sourcePaths = ['libs/readability.js', 'libs/turndown.js', 'shortcut-utils.js', 'settings.js', 'content.js'];
const sources = await Promise.all(sourcePaths.map(path => readFile(new URL(`../vendor/llmfeeder/${path}`, import.meta.url), 'utf8')));

// LLMFeeder's processing backend lives in its content script. Use the unchanged
// sources and normal convertToMarkdown message, replacing only the extension
// transport with an in-process callback. An isolated world keeps website scripts
// from reading or replacing our converter while sharing the post-BPC page DOM.
export async function convertPageToMarkdown(page) {
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
      return await new Promise(resolve => {
        __bpcLlmFeederHandler({ action: 'convertToMarkdown', settings }, {}, resolve);
      });
    })()`, true);
    if (!result?.success || typeof result.markdown !== 'string' || !result.markdown.trim())
      throw new Error(`LLMFeeder: ${result?.details || result?.error || 'No Markdown returned'}`);
    return result.markdown.trimEnd() + '\n';
  } finally {
    await session.detach().catch(() => {});
  }
}
