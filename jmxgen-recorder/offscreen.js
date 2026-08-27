/* A service worker has no DOM, so it cannot call URL.createObjectURL - which is the
 * only way to hand chrome.downloads a large file. This offscreen document does it. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "make-blob-url") return;
  try {
    // octet-stream so Chrome keeps the .har name we chose - with application/json
    // it "corrects" the extension to .json on download
    const blob = new Blob([msg.text], { type: "application/octet-stream" });
    sendResponse({ ok: true, url: URL.createObjectURL(blob) });
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
  return true;
});
