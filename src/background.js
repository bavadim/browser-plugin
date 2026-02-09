const api = globalThis.chrome ?? globalThis.browser;

if (!api?.action || !api?.scripting) {
  console.error("Extension API not available.");
}

api?.action?.onClicked?.addListener(async (tab) => {
  if (!tab?.id) {
    return;
  }
  try {
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (error) {
    console.error("Failed to inject content script", error);
  }
});
