/* One studio surface, and the state that moves through it.
 *
 * The studio used to be two pages that happened to belong to the same
 * extension. Authoring opened a tab; Run on HyperExecute opened another one -
 * and if the studio had been maximised into a window of its own, that second
 * page could not go there at all, because a Chrome popup window holds no tabs.
 * It landed in whatever normal window was handy. You were then looking at the
 * run page in one window with the authoring page still live in another, with
 * nothing to say they were the same tool and no way back between them. Closing
 * the one you had finished with meant hunting for it.
 *
 * So the studio is ONE page now. Run is the next step of the page you are
 * already looking at, reached by navigating it, which keeps it in the tab and
 * the window you had. Back returns and restores what you built.
 *
 * Nothing is lost on the way. The plan and the authoring page's own state are
 * kept in IndexedDB rather than session storage: session storage is capped at
 * ten megabytes, which one large plan can exceed on its own, and losing a plan
 * because it was a good plan is indefensible. IndexedDB is disk-backed and
 * sized against the browser's quota.
 *
 * Loaded by the worker with importScripts and by the pages with a script tag,
 * so it defines globals rather than exporting.
 */

const STUDIO_DB = "jmxgen-studio";
const STUDIO_PAGES = ["author.html", "run.html"];

/* Long enough that authoring, being pulled away and coming back still finds
   the plan; short enough that yesterday's is not waiting in today's run page.
   It is a visible, removable row on the run page either way. */
const STUDIO_MAX_AGE = 12 * 60 * 60 * 1000;

function studioOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STUDIO_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      // one row per kind: "plan" is what the run page uploads, "author" is what
      // the authoring page shows when you come back to it
      if (!db.objectStoreNames.contains("carry")) {
        db.createObjectStore("carry", { keyPath: "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function studioPut(k, value) {
  const db = await studioOpen();
  const tx = db.transaction("carry", "readwrite");
  tx.objectStore("carry").put({ k, at: Date.now(), value });
  await new Promise((ok, no) => {
    tx.oncomplete = ok;
    tx.onerror = tx.onabort = () => no(tx.error || new Error("could not save"));
  });
  db.close();
}

async function studioGet(k) {
  const db = await studioOpen();
  const tx = db.transaction("carry", "readonly");
  const row = await new Promise((ok, no) => {
    const r = tx.objectStore("carry").get(k);
    r.onsuccess = () => ok(r.result || null);
    r.onerror = () => no(r.error);
  });
  db.close();
  if (!row) return null;
  if (Date.now() - (row.at || 0) > STUDIO_MAX_AGE) {
    await studioDel(k);
    return null;
  }
  return row.value;
}

async function studioDel(k) {
  const db = await studioOpen();
  const tx = db.transaction("carry", "readwrite");
  tx.objectStore("carry").delete(k);
  await new Promise((ok) => { tx.oncomplete = ok; tx.onerror = ok; tx.onabort = ok; });
  db.close();
}

const Pages = {
  /* ---- moving between the studio's steps ------------------------------- */

  /* From inside a studio page: go to the next step in this very tab. Same tab,
     same window, whether that window is an ordinary one or the studio's own. */
  goTo(page, search) {
    location.href = chrome.runtime.getURL(page) + (search || "");
  },

  /* From outside (the popup, the worker): bring the studio here and put it on
     the page asked for. An open studio page is navigated rather than joined by
     a second one, so there is never more than one of these to find. */
  async openStudio(page, opts) {
    const o = opts || {};
    const url = chrome.runtime.getURL(page) + (o.search || "");
    for (const p of STUDIO_PAGES) {
      const open = await chrome.tabs.query({ url: chrome.runtime.getURL(p) + "*" });
      if (!open.length) continue;
      await chrome.tabs.update(open[0].id, { url, active: true });
      await chrome.windows.update(open[0].windowId, { focused: true }).catch(() => {});
      return { reused: true, tabId: open[0].id };
    }
    if (o.asWindow) {
      const w = await chrome.windows.create({ url, type: "popup", width: 1180, height: 900 });
      return { reused: false, windowId: w && w.id };
    }
    const t = await chrome.tabs.create({ url, active: true });
    return { reused: false, tabId: t && t.id };
  },

  /* ---- what travels between the steps ---------------------------------- */

  /* The plan the run page uploads. Read but never consumed on arrival:
     deleting on read meant a reload dropped the plan out of the upload set
     while the page still looked exactly right. Cleared once submitted. */
  putPlan: (plan) => studioPut("plan", plan),
  readPlan: () => studioGet("plan"),
  clearPlan: () => studioDel("plan"),

  /* The authoring page's own result, so Back shows what you built rather than
     an empty form. Kept until the next plan replaces it. */
  putAuthored: (snap) => studioPut("author", snap),
  readAuthored: () => studioGet("author"),
  clearAuthored: () => studioDel("author"),
};
