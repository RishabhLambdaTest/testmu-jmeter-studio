/* Feedback - a rating and a comment, sent to the same place the other
 * LambdaTest extensions send theirs.
 *
 * The endpoint takes an API key in a header. A key shipped inside an extension
 * is readable by anyone who installs it, so this one is not a secret and is
 * not treated as one: it is a write-only feedback route, it carries no
 * account data, and the worst it allows is someone posting junk feedback.
 *
 * What the server actually enforces, confirmed by calling it: the key is
 * required (401 without it) and a rating, when sent, must be 1-5. Everything
 * else is optional - so the "pick a star first" rule is ours, and lives here.
 *
 * Nothing is stored. The comment exists in the page until it is sent, and the
 * email comes from the account the page is already signed in to.
 */

const FB_URL = "https://backend-app.lambdatest.com/api/chrome-extension/feedback";
const FB_KEY = "b763153e7f6d629c130df295f7f4a1a9d0adf737ee609b4cbb8d96a2cedc6506";
const FB_MAX = 1000;

let FB_RATING = 0;
let FB_SENDING = false;

function fbCardEl() {
  let g = document.getElementById("fbGate");
  if (g) return g;
  g = document.createElement("div");
  g.id = "fbGate";
  g.className = "authgate fbgate";
  g.hidden = true;
  g.setAttribute("role", "dialog");
  g.setAttribute("aria-modal", "true");
  g.setAttribute("aria-labelledby", "fbTitle");
  g.innerHTML = `
    <div class="authcard fbcard">
      <h2 id="fbTitle">How is JMeter Studio working for you?</h2>
      <div class="fbstars" id="fbStars" role="radiogroup" aria-label="Rating, 1 to 5">
        ${[1, 2, 3, 4, 5].map((n) => `
        <button type="button" class="fbstar" data-n="${n}" role="radio"
                aria-checked="false" aria-label="${n} out of 5"
                tabindex="${n === 1 ? 0 : -1}">&#9733;</button>`).join("")}
      </div>
      <label class="fblabel" for="fbText">Anything you'd like to add? (optional)</label>
      <textarea id="fbText" maxlength="${FB_MAX}" rows="4"
                placeholder="What worked, what did not"></textarea>
      <p class="authnote" id="fbNote"></p>
      <div class="fbrow">
        <button type="button" class="go" id="fbSend" disabled>Send</button>
        <button type="button" class="alt" id="fbCancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(g);
  fbWire(g);
  return g;
}

function fbSetRating(n) {
  FB_RATING = n;
  const stars = [...document.querySelectorAll("#fbStars .fbstar")];
  stars.forEach((b) => {
    const v = Number(b.dataset.n);
    b.classList.toggle("on", v <= n);
    b.setAttribute("aria-checked", v === n ? "true" : "false");
    b.tabIndex = v === n ? 0 : -1;
  });
  const send = document.getElementById("fbSend");
  if (send) send.disabled = !n || FB_SENDING;
}

function fbWire(g) {
  const stars = [...g.querySelectorAll(".fbstar")];
  stars.forEach((b) => {
    b.onclick = () => fbSetRating(Number(b.dataset.n));
  });
  // arrow keys move through the stars, the way a radio group does
  g.querySelector("#fbStars").onkeydown = (e) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = Math.min(5, Math.max(1, (FB_RATING || 0) + step));
    fbSetRating(next);
    stars[next - 1].focus();
  };
  g.querySelector("#fbCancel").onclick = () => fbClose();
  g.querySelector("#fbSend").onclick = () => fbSend();
  g.onkeydown = (e) => { if (e.key === "Escape" && !FB_SENDING) fbClose(); };
  // clicking the backdrop, not the card, closes it
  g.onclick = (e) => { if (e.target === g && !FB_SENDING) fbClose(); };
}

function fbOpen() {
  const g = fbCardEl();
  g.hidden = false;
  fbSetRating(0);
  const t = g.querySelector("#fbText");
  t.value = "";
  t.disabled = false;
  g.querySelector("#fbNote").textContent = "";
  g.querySelector("#fbCancel").textContent = "Cancel";
  g.querySelector("#fbSend").hidden = false;
  g.querySelector(".fbstar").focus();
}

function fbClose() {
  const g = document.getElementById("fbGate");
  if (g) g.hidden = true;
}

/* The email is a nicety, not a requirement: the endpoint takes feedback
   without one, and a page that cannot read the account still sends. */
function fbEmail() {
  try {
    return (window.AUTH && AUTH.email && AUTH.email()) || "";
  } catch (e) { return ""; }
}

async function fbSend() {
  if (FB_SENDING || !FB_RATING) return;
  const g = fbCardEl();
  const note = g.querySelector("#fbNote");
  const send = g.querySelector("#fbSend");
  const text = g.querySelector("#fbText");
  FB_SENDING = true;
  send.disabled = true;
  note.className = "authnote";
  note.textContent = "sending…";

  const body = { rating: FB_RATING };
  const msg = text.value.trim();
  if (msg) body.message = msg.slice(0, FB_MAX);
  const email = fbEmail();
  if (email) body.user_email = email;

  try {
    const r = await fetch(FB_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json",
                 "x-api-key": FB_KEY },
      credentials: "omit",
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    note.className = "authnote ok";
    note.textContent = "Thank you - that has been passed on.";
    text.disabled = true;
    send.hidden = true;
    g.querySelector("#fbCancel").textContent = "Close";
  } catch (e) {
    // the comment is left as it is, so nothing anyone typed is lost
    note.className = "authnote warn";
    note.textContent = "Could not send that: " + (e.message || e) + ". Try again in a moment.";
    send.disabled = false;
  } finally {
    FB_SENDING = false;
  }
}

function fbInit() {
  const b = document.getElementById("feedback");
  if (b) b.onclick = () => fbOpen();
}

document.addEventListener("DOMContentLoaded", fbInit);
window.FEEDBACK = { open: fbOpen };
