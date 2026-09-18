/* Signing in - the studio asks for a TestMu AI username and access key once
 * per browser session, and never writes them to disk.
 *
 * The pair is held in `chrome.storage.session`, which lives in memory for as
 * long as the browser is running: it is wiped when Chrome quits, it is private
 * to this extension, and at the default access level even this extension's own
 * content scripts cannot read it. Nothing reaches chrome.storage.local, a
 * cookie, or the profile on disk, so there is no copy left behind for anything
 * else to find.
 *
 * The extension holds no `cookies` permission either, so it cannot see the
 * LambdaTest session the browser may already have. The account in use is the
 * one you chose, not whichever one the browser happens to be signed in to, and
 * the chip in the page bar switches it or signs out.
 *
 * The pair is checked before the page unlocks, against the same HyperExecute
 * call the studio makes for real, so a key that cannot list projects is
 * refused here instead of failing at the first job. That check runs on every
 * page load, which is how a key revoked mid-session shows up as the gate
 * rather than as a puzzling 401 later on.
 */

const AUTH_CHECK = "https://api-hyperexecute.lambdatest.com/sentinel/v1.0/projects?per_page=1&type=jmeter";
const AUTH_KEYS_URL = "https://accounts.lambdatest.com/detail/profile";

const AUTH_STORE = "jmxgen.account";   // chrome.storage.session, never .local

let AUTH_ACCOUNT = null;        // {user, key} once signed in, in memory only

/* The browser-session store. Absent or malformed reads as signed out; a
   storage failure is thrown, so it is not mistaken for one. */
async function authLoad() {
  const got = await chrome.storage.session.get(AUTH_STORE);
  const a = got && got[AUTH_STORE];
  return a && a.user && a.key ? { user: String(a.user), key: String(a.key) } : null;
}

async function authStore(account) {
  if (account) await chrome.storage.session.set({ [AUTH_STORE]: account });
  else await chrome.storage.session.remove(AUTH_STORE);
}

/* true when the pair works, false when the service rejects it; anything else
   going wrong is thrown, so a network failure is not mistaken for a bad key. */
async function authCheck(user, key) {
  const r = await fetch(AUTH_CHECK, {
    headers: { authorization: "Basic " + btoa(user + ":" + key), accept: "application/json" },
    credentials: "omit",
  });
  if (r.status === 401 || r.status === 403) return false;
  if (!r.ok) throw new Error(`HyperExecute returned HTTP ${r.status}`);
  return true;
}

/* The pair for an API call. Throws when signed out, so callers need no check
   of their own; the gate is already covering the page in that case. */
function authCreds() {
  if (!AUTH_ACCOUNT) throw new Error("sign in to TestMu AI first");
  return { user: AUTH_ACCOUNT.user, key: AUTH_ACCOUNT.key };
}

/* ---- the gate ----------------------------------------------------------- */

function authGateEl() {
  let g = document.getElementById("authGate");
  if (g) return g;
  g = document.createElement("div");
  g.id = "authGate";
  g.className = "authgate";
  g.setAttribute("role", "dialog");
  g.setAttribute("aria-modal", "true");
  g.setAttribute("aria-labelledby", "authGateTitle");
  g.innerHTML = `
    <form class="authcard" id="authForm" autocomplete="off">
      <h2 id="authGateTitle">Sign in to use JMeter Studio</h2>
      <p id="authGateText">Your TestMu AI username and access key. Asked once per
        browser session, kept in memory, and gone when you close the browser.
        Nothing is written to disk.</p>
      <label class="authfield" for="authUser">Username</label>
      <input id="authUser" name="authUser" type="text" spellcheck="false"
             autocomplete="off" autocapitalize="off" required>
      <label class="authfield" for="authKey">Access key</label>
      <input id="authKey" name="authKey" type="password" spellcheck="false"
             autocomplete="off" required>
      <p class="authnote authwhere">Find both under
        <a id="authKeysLink" href="#" target="_blank" rel="noreferrer">Profile &rsaquo; Password &amp; Security</a>
        in your TestMu AI account.</p>
      <div class="authrow">
        <button type="submit" class="go" id="authSignIn">Sign in</button>
        <button type="button" class="alt" id="authCancel" hidden>Cancel</button>
        <button type="button" class="alt danger" id="authSignOut" hidden>Sign out</button>
      </div>
      <p class="authnote" id="authGateNote"></p>
    </form>`;
  document.body.appendChild(g);
  g.querySelector("#authKeysLink").onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: AUTH_KEYS_URL });
  };
  return g;
}

function authRender(state, detail) {
  const g = authGateEl();
  const chip = document.getElementById("account");
  g.hidden = state === "in";
  document.body.classList.toggle("signed-out", state !== "in");

  const note = g.querySelector("#authGateNote");
  const busy = state === "checking";
  if (busy) note.textContent = "checking your access key…";
  else if (state === "rejected") note.textContent = "That username and access key were not accepted. Check both, or paste a new key if this one was revoked.";
  else if (state === "error") note.textContent = "Could not reach TestMu AI: " + detail;
  else note.textContent = "";

  g.querySelector("#authSignIn").disabled = busy;
  g.querySelector("#authUser").disabled = busy;
  g.querySelector("#authKey").disabled = busy;
  // the cancel and sign-out pair only make sense once an account is in place
  g.querySelector("#authCancel").hidden = !AUTH_ACCOUNT || busy;
  g.querySelector("#authSignOut").hidden = !AUTH_ACCOUNT || busy;

  if (chip) {
    chip.hidden = state !== "in";
    chip.textContent = state === "in" ? AUTH_ACCOUNT.user : "";
    chip.title = state === "in"
      ? "Signed in to TestMu AI as " + AUTH_ACCOUNT.user + " - click to switch account or sign out"
      : "";
  }
}

/* Resolves once someone is signed in - immediately when this browser session
   already has an account, otherwise when the form is filled in. Switching to a
   different account, or signing out, reloads the page, so nothing chosen for
   the old account (a project, a session, a generated plan) carries over. */
function authReady() {
  return new Promise((resolve) => {
    const g = authGateEl();
    const form = g.querySelector("#authForm");
    const userEl = g.querySelector("#authUser");
    const keyEl = g.querySelector("#authKey");
    let resolved = false;

    const settle = (account) => {
      if (resolved) return;
      resolved = true;
      resolve({ user: account.user, key: account.key });
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      const user = userEl.value.trim();
      const key = keyEl.value.trim();
      if (!user || !key) return;
      authRender("checking");
      let ok;
      try {
        ok = await authCheck(user, key);
      } catch (err) {
        return authRender("error", err.message || String(err));
      }
      if (!ok) return authRender("rejected");
      const switching = AUTH_ACCOUNT && AUTH_ACCOUNT.user !== user;
      AUTH_ACCOUNT = { user, key };
      await authStore(AUTH_ACCOUNT);
      // a different account must not inherit the page's state; the reload
      // picks the new account straight back up out of the session store
      if (switching) return location.reload();
      keyEl.value = "";
      authRender("in");
      settle(AUTH_ACCOUNT);
    };

    g.querySelector("#authCancel").onclick = () => { keyEl.value = ""; authRender("in"); };
    g.querySelector("#authSignOut").onclick = async () => {
      AUTH_ACCOUNT = null;
      await authStore(null);
      location.reload();
    };

    const chip = document.getElementById("account");
    if (chip) {
      chip.onclick = () => {
        if (!AUTH_ACCOUNT) return;
        userEl.value = AUTH_ACCOUNT.user;
        keyEl.value = "";
        authRender("out");
        // both of these throw the page away, so say so before it happens
        g.querySelector("#authGateNote").textContent =
          "Signing in as a different account, or signing out, reloads this page "
          + "and clears what is on it.";
        keyEl.focus();
      };
    }

    // resume this browser session's account, re-checking it in case the key
    // was revoked since it was entered
    (async () => {
      authRender("checking");
      let saved = null;
      try { saved = await authLoad(); } catch (e) { /* treated as signed out */ }
      if (!saved) { authRender("out"); userEl.focus(); return; }
      let ok;
      try {
        ok = await authCheck(saved.user, saved.key);
      } catch (err) {
        userEl.value = saved.user;
        return authRender("error", err.message || String(err));
      }
      if (!ok) {
        await authStore(null);
        userEl.value = saved.user;
        authRender("rejected");
        keyEl.focus();
        return;
      }
      AUTH_ACCOUNT = saved;
      authRender("in");
      settle(AUTH_ACCOUNT);
    })();
  });
}

window.AUTH = { ready: authReady, creds: authCreds };
