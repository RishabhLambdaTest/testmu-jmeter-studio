/* Signing in - the studio uses the TestMu AI account the browser is already
 * signed in to, and never asks for an access key.
 *
 * The TestMu AI web login leaves an `accessToken` cookie on lambdatest.com.
 * The account service answers /api/user for that token with the username and
 * the API token, which is the pair every HyperExecute and session call takes as
 * Basic auth. That is how the HyperExecute dashboard gets its credentials too.
 *
 * Nothing here is written to storage. The pair lives in this page's memory and
 * is looked up again on the next page load, so signing out of TestMu AI signs
 * the studio out as well, and there is no copy of the key on disk to leak.
 */

const AUTH_ACCOUNTS = "https://accounts.lambdatest.com";
const AUTH_COOKIE = "accessToken";

let AUTH_ACCOUNT = null;        // {user, key} once signed in
let AUTH_TOKEN = null;          // the cookie value AUTH_ACCOUNT was looked up with

async function authToken() {
  const c = await chrome.cookies.get({ url: AUTH_ACCOUNTS + "/", name: AUTH_COOKIE });
  if (!c || !c.value) return null;
  try { return decodeURIComponent(c.value); } catch (e) { return c.value; }
}

/* null means signed out (no token, or a token the service no longer accepts);
   anything else going wrong is thrown, so a network failure is not mistaken
   for being signed out. */
async function authLookup(token) {
  const r = await fetch(AUTH_ACCOUNTS + "/api/user", {
    headers: { authorization: "Bearer " + token, accept: "application/json" },
    credentials: "omit",
  });
  if (r.status === 401 || r.status === 403) return null;
  if (!r.ok) throw new Error(`the TestMu AI account service returned HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !j.username || !j.apiToken) {
    throw new Error("the TestMu AI account service answered without a username and API token");
  }
  return { user: String(j.username), key: String(j.apiToken) };
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
    <div class="authcard">
      <h2 id="authGateTitle">Sign in to use JMeter Studio</h2>
      <p id="authGateText">JMeter Studio uses your TestMu AI account. Sign in
        once in this browser and the studio picks it up; there is no access key
        to copy.</p>
      <button type="button" class="go" id="authSignIn">Sign in to TestMu AI</button>
      <p class="authnote" id="authGateNote"></p>
    </div>`;
  document.body.appendChild(g);
  g.querySelector("#authSignIn").onclick = () =>
    chrome.tabs.create({ url: AUTH_ACCOUNTS + "/login" });
  return g;
}

function authRender(state, detail) {
  const g = authGateEl();
  const chip = document.getElementById("account");
  g.hidden = state === "in";
  document.body.classList.toggle("signed-out", state !== "in");
  const note = g.querySelector("#authGateNote");
  if (state === "checking") note.textContent = "checking your TestMu AI sign-in…";
  else if (state === "expired") note.textContent = "Your TestMu AI session has ended. Sign in again to continue.";
  else if (state === "error") note.textContent = "Could not check your sign-in: " + detail;
  else note.textContent = "Waiting for you to sign in - this page unlocks by itself.";
  g.querySelector("#authSignIn").hidden = state === "checking";
  if (chip) {
    chip.hidden = state !== "in";
    chip.textContent = state === "in" ? "Signed in as " + AUTH_ACCOUNT.user : "";
    chip.title = state === "in" ? "Signed in to TestMu AI as " + AUTH_ACCOUNT.user : "";
  }
}

/* Resolves once someone is signed in, and keeps the page in step with the
   browser's sign-in afterwards. A different account signing in reloads the
   page, so nothing chosen for the old account (a project, a session) carries
   over to the new one. */
function authReady() {
  return new Promise((resolve) => {
    let resolved = false;
    let unlockedFor = null;       // the account this page was first unlocked for
    let busy = null;

    async function check() {
      const token = await authToken();
      if (!token) {
        AUTH_ACCOUNT = AUTH_TOKEN = null;
        return authRender("out");
      }
      if (token === AUTH_TOKEN && AUTH_ACCOUNT) return;
      let account;
      try {
        account = await authLookup(token);
      } catch (e) {
        AUTH_ACCOUNT = AUTH_TOKEN = null;
        return authRender("error", e.message || String(e));
      }
      if (!account) {
        AUTH_ACCOUNT = AUTH_TOKEN = null;
        return authRender("expired");
      }
      if (unlockedFor && unlockedFor !== account.user) {
        location.reload();
        return;
      }
      AUTH_ACCOUNT = account;
      AUTH_TOKEN = token;
      authRender("in");
      if (!resolved) { resolved = true; unlockedFor = account.user; resolve(account); }
    }

    const run = () => { busy = (busy || Promise.resolve()).then(check).catch(() => {}); };

    chrome.cookies.onChanged.addListener(({ cookie }) => {
      if (cookie.name === AUTH_COOKIE && /(^|\.)lambdatest\.com$/.test(cookie.domain)) run();
    });
    // a tab left open overnight is re-checked when it is looked at again
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") run();
    });

    authRender("checking");
    run();
  });
}

window.AUTH = { ready: authReady, creds: authCreds };
