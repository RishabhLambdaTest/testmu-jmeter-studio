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
 *
 * The account button in the page bar names the account and opens TestMu AI's
 * logout, which lands on the login page: that is how you sign out, and how you
 * come back as a different account. The page follows along by itself, because
 * it is watching the cookie either way.
 */

const AUTH_ACCOUNTS = "https://accounts.lambdatest.com";
const AUTH_COOKIE = "accessToken";
/* /logout clears the session and redirects to /login, so one link covers both
   signing out and coming back as someone else. */
const AUTH_LOGOUT = AUTH_ACCOUNTS + "/logout";

let AUTH_ACCOUNT = null;        // {user, key} once signed in
/* The tab this page opened to log in. TestMu AI's login redirects to the
   dashboard when it is done, which leaves that tab in front and the studio
   unlocking out of sight behind it. So the tab is ours to clean up: once the
   account resolves we close it and bring this page back to the front. */
let AUTH_LOGIN_TAB = null;
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
  return { user: String(j.username), key: String(j.apiToken),
           email: j.email ? String(j.email) : "" };
}

/* The pair for an API call. Throws when signed out, so callers need no check
   of their own; the gate is already covering the page in that case. */
function authCreds() {
  if (!AUTH_ACCOUNT) throw new Error("sign in to TestMu AI first");
  return { user: AUTH_ACCOUNT.user, key: AUTH_ACCOUNT.key };
}

/* The signed-in account's email, for feedback to be attributed to. Empty when
   signed out or when the account service did not send one; nothing depends on
   it. Like the pair above it is only ever in memory. */
function authEmail() {
  return (AUTH_ACCOUNT && AUTH_ACCOUNT.email) || "";
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
      <h2 id="authGateTitle">Sign in to use Thunder</h2>
      <p id="authGateText">Thunder uses your TestMu AI account. Log in the
        way you always do - Google, GitHub, SSO or a password. The login tab
        closes itself and you land back here, signed in. There is no access key
        to copy.</p>
      <button type="button" class="go" id="authSignIn">Log in to TestMu AI</button>
      <button type="button" class="alt" id="authSwitch" hidden>Log out of TestMu AI</button>
      <button type="button" class="alt" id="authCancel" hidden>Cancel</button>
      <p class="authnote" id="authGateNote"></p>
    </div>`;
  document.body.appendChild(g);
  g.querySelector("#authSignIn").onclick = async () => {
    AUTH_LOGIN_TAB = await authOpenLogin(AUTH_ACCOUNTS + "/login");
  };
  g.querySelector("#authSwitch").onclick = async () => {
    // logging out lands on login, so the same applies
    AUTH_LOGIN_TAB = await authOpenLogin(AUTH_LOGOUT);
  };
  return g;
}

/* One login tab, not a pile of them.
 *
 * Pressing the button twice, or logging out and then back in, used to leave a
 * login tab open behind each attempt - and only the last was remembered, so the
 * earlier ones were never cleaned up afterwards. */
async function authOpenLogin(url) {
  try {
    const open = await chrome.tabs.query({ url: AUTH_ACCOUNTS + "/*" });
    if (open && open.length) {
      await chrome.tabs.update(open[0].id, { url, active: true });
      await chrome.windows.update(open[0].windowId, { focused: true }).catch(() => {});
      return open[0].id;
    }
  } catch (e) { /* fall through and open a new one */ }
  const t = await chrome.tabs.create({ url });
  return t.id;
}

function authRender(state, detail) {
  const g = authGateEl();
  const chip = document.getElementById("account");
  // "manage" is the signed-in page asking what to do about its account, so the
  // card is over the page without the page being locked out
  const locked = state !== "in" && state !== "manage";
  g.hidden = state === "in";
  document.body.classList.toggle("signed-out", locked);

  const note = g.querySelector("#authGateNote");
  if (state === "checking") note.textContent = "checking your TestMu AI login\u2026";
  else if (state === "expired") note.textContent = "Your TestMu AI session has ended. Log in again to continue.";
  else if (state === "error") note.textContent = "Could not check your login: " + detail;
  else if (state === "manage") note.textContent = "";
  else note.textContent = "Waiting for you to log in - this page unlocks by itself.";

  const title = g.querySelector("#authGateTitle");
  const text = g.querySelector("#authGateText");
  if (state === "manage") {
    title.textContent = "Signed in as " + AUTH_ACCOUNT.user;
    text.textContent = "Logging out opens the TestMu AI login page, so this is "
      + "also how you come back as a different account. This page locks until "
      + "you do, and unlocks again by itself.";
  } else {
    title.textContent = "Sign in to use Thunder";
    text.textContent = "Thunder uses your TestMu AI account. Log in the "
      + "way you always do - Google, GitHub, SSO or a password. The login tab "
      + "closes itself and you land back here, signed in. There is no access "
      + "key to copy.";
  }

  g.querySelector("#authSignIn").hidden = state === "checking" || state === "manage";
  g.querySelector("#authSwitch").hidden = state !== "manage";
  g.querySelector("#authCancel").hidden = state !== "manage";

  if (chip) {
    chip.hidden = locked;
    if (AUTH_ACCOUNT) {
      chip.textContent = AUTH_ACCOUNT.user;
      chip.title = "Signed in to TestMu AI as " + AUTH_ACCOUNT.user
        + " - click to log out or switch account";
    }
  }
}

/* Closes the tab we sent someone to log in on and brings this page forward.
   TestMu AI's login redirects when it is done - to the dashboard, or to the
   marketing site, on either of the two domains the rebrand left in play - so
   the tab is matched by domain rather than by the URL it was opened with.
   Anything going wrong here is swallowed: a tab that will not close is not a
   reason to hold up a page that is now signed in. */
const AUTH_OURS = /(^|\.)(lambdatest\.com|testmuai\.com|testmu\.ai)$/;

async function authFinishLogin() {
  const id = AUTH_LOGIN_TAB;
  AUTH_LOGIN_TAB = null;
  if (id == null) return;
  try {
    const tab = await chrome.tabs.get(id);
    let host = "";
    try { host = new URL(tab.url || "").hostname; } catch (e) { host = ""; }
    // only ever close what is still one of theirs: a tab navigated somewhere
    // else in the meantime is no longer ours to close
    if (AUTH_OURS.test(host)) await chrome.tabs.remove(id);
  } catch (e) { /* already closed, or no url to read */ }
  try {
    const self = await chrome.tabs.getCurrent();
    if (self) {
      await chrome.tabs.update(self.id, { active: true });
      await chrome.windows.update(self.windowId, { focused: true });
    }
  } catch (e) { /* not fatal: the page is unlocked either way */ }
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
      authFinishLogin().catch(() => {});   // never block the resolve below
      if (!resolved) { resolved = true; unlockedFor = account.user; resolve(account); }
    }

    const run = () => { busy = (busy || Promise.resolve()).then(check).catch(() => {}); };

    const g = authGateEl();
    g.querySelector("#authCancel").onclick = () => authRender("in");
    const chip = document.getElementById("account");
    if (chip) chip.onclick = () => { if (AUTH_ACCOUNT) authRender("manage"); };

    /* Noticing that someone has signed in.
     *
     * Logging in happens on another page, so this one has to find out on its
     * own. It used to have two ways: a cookie change on lambdatest.com, and the
     * page being looked at again. Both can miss. The account service spans
     * three domains - the list above says so - but only one of them was
     * watched, and `visibilitychange` never fires for a studio in a window of
     * its own, because that window is on screen the whole time. Miss both and
     * the gate stays up over a page whose user is, in fact, signed in: you log
     * in, the new tab lands on the dashboard, and the studio behind it has
     * noticed nothing.
     *
     * So: every domain the account service uses, focus as well as visibility,
     * and - because an event that has to fire is a thing that can fail to - a
     * poll underneath them all. It runs only while the gate is up and stops the
     * moment someone is in, so the cost is a request every couple of seconds
     * during the seconds a person is logging in. */
    chrome.cookies.onChanged.addListener(({ cookie }) => {
      if (cookie.name === AUTH_COOKIE && AUTH_OURS.test(cookie.domain || "")) run();
    });
    // a tab left open overnight is re-checked when it is looked at again
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") run();
    });
    // a studio in its own window is never hidden, so it is focus that changes
    window.addEventListener("focus", () => run());

    /* Two speeds, because the question changes once someone is in.
     *
     * While the gate is up the answer is wanted the second it changes - that is
     * a person standing in front of a locked page waiting for it to open - so
     * it asks every couple of seconds, for the few seconds a login takes.
     * Afterwards the question is the opposite one, "is this session still
     * good", which nothing is waiting on; a signing-out noticed within the
     * minute is soon enough, and a request a minute is not worth optimising
     * away. Dropping the poll entirely once signed in was wrong: logging out
     * elsewhere then left the studio open over an account that no longer
     * existed. */
    let pollAt = 0;
    setInterval(() => {
      const every = AUTH_ACCOUNT ? 60000 : 2000;
      const now = Date.now();
      if (now - pollAt < every) return;
      pollAt = now;
      run();
    }, 1000);

    authRender("checking");
    run();
  });
}

window.AUTH = { ready: authReady, creds: authCreds, email: authEmail };
