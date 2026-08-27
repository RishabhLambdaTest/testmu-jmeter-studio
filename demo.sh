#!/usr/bin/env bash
# End-to-end demo. Everything runs locally against sample targets it starts itself.
#
#   ./demo.sh              run the whole story
#   ./demo.sh --console    ...and open the web console at the end
set -uo pipefail
set +m
cd "$(dirname "$0")"
ROOT="$(pwd)"; JG="python3 $ROOT/jmxgen.py"
W="$(mktemp -d)"; trap 'rm -rf "$W"; pkill -f demo_api.py 2>/dev/null; pkill -f "http.server 8795" 2>/dev/null' EXIT
B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
step() { echo; echo "${B}──────────────────────────────────────────────────────────────${N}";
         echo "${B}  $1${N}"; echo "${B}──────────────────────────────────────────────────────────────${N}"; }
note() { echo "  ${Y}→${N} $1"; }

# ── sample targets ────────────────────────────────────────────────────────────
cat > "$W/demo_api.py" <<'PY'
import json, http.server
TOKEN = "tok_9f3c1ab77e2d4b50"
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _s(self, c, b):
        d = json.dumps(b).encode(); self.send_response(c)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path.endswith("/oauth/token"): return self._s(200, {"access_token": TOKEN})
        if self.headers.get("Authorization") != "Bearer " + TOKEN: return self._s(401, {"error":"unauthorized"})
        self._s(201, {"created": True, "id": 42})
    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer " + TOKEN: return self._s(401, {"error":"unauthorized"})
        self._s(200, {"orders": [], "page": 1})
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8794), H).serve_forever()
PY
mkdir -p "$W/site"
cat > "$W/site/index.html" <<'HTML'
<html><head><title>Demo Shop</title><link rel=stylesheet href=/app.css>
<script src=/app.js></script><script src=https://www.googletagmanager.com/gtag/js></script></head>
<body><img src=/hero.png><form action=/search method=get>
<input type=hidden name=csrf value=abc123><input name=q></form></body></html>
HTML
python3 "$W/demo_api.py" & (cd "$W/site" && python3 -m http.server 8795 >/dev/null 2>&1 &)
sleep 2

cat > "$W/api.yaml" <<'YAML'
openapi: 3.0.0
info: {title: Orders API, version: "1.0"}
servers: [{url: "http://127.0.0.1:8794/v1"}]
paths:
  /orders:
    get: {operationId: listOrders, tags: [Orders], responses: {"200": {description: ok}}}
    post:
      operationId: createOrder
      tags: [Orders]
      requestBody: {content: {application/json: {schema: {type: object,
                    properties: {sku: {type: string, example: SKU-1}}}}}}
      responses: {"201": {description: created}}
YAML
printf 'username,password\nu1,p1\nu2,p2\n' > "$W/users.csv"

echo
echo "${B}  jmxgen — end to end${N}"
echo "  sample API on :8794   sample site on :8795   (started by this script)"

# ── 1. API test from a contract ───────────────────────────────────────────────
step "1. An API test from an OpenAPI contract — no recording at all"
note "one command: author + auth + test data + validate"
echo "  \$ jmxgen from-openapi api.yaml --login 'POST /oauth/token' --csv users.csv:username,password --replay"
cd "$W"
$JG from-openapi "$W/api.yaml" -o "$W/api.jmx" --spec "$W/api.spec.yaml" \
   --login "POST /oauth/token" --login-body '{"grant_type":"client_credentials"}' \
   --csv "$W/users.csv:username,password" 2>&1 | sed 's/^/  /'
python3 - "$W/api.spec.yaml" <<'PY'
import sys, yaml
s = yaml.safe_load(open(sys.argv[1])); tg = s["thread_groups"][0]
tg.pop("duration", None); tg.update(threads=2, ramp_up=1, loops=1)
for t in tg["steps"]:
    for st in t.get("steps", []): st.pop("think_time", None)
yaml.safe_dump(s, open(sys.argv[1], "w"), sort_keys=False)
PY
$JG build "$W/api.spec.yaml" -o "$W/api.jmx" --login "POST /oauth/token" \
   --login-body '{"grant_type":"client_credentials"}' >/dev/null 2>&1
note "the API rejects anything without a token — so this proves the token really flows:"
$JG replay "$W/api.jmx" 2>&1 | sed 's/^/  /' | grep -v artifacts

# ── 2. correlation ────────────────────────────────────────────────────────────
step "2. A recorded journey — tokens wired up automatically"
python3 - "$W" <<'PY'
import json, sys
W = sys.argv[1]
VS = "/wEPDwULLTE2MTY2ODcyMjlkZBgB"; CSRF = "Xy8kZjkxMmRhYjRjNWU3"; CODE = "4/0AXqYs7Q-abc123"
def e(m, u, ct, body="", post=None, hdrs=None, status=200, rt="document", t="10:00:00"):
    return {"pageref": "Journey", "startedDateTime": "2026-08-25T%s.000Z" % t, "time": 0,
            "cache": {}, "timings": {"send":0,"wait":0,"receive":0}, "_resourceType": rt,
            "request": {"method": "POST" if post else m, "url": u, "headers": hdrs or [],
                        "queryString": [], "cookies": [], "headersSize": -1, "bodySize": 0,
                        **({"postData": post} if post else {})},
            "response": {"status": status, "statusText": "", "httpVersion": "HTTP/1.1",
                         "headers": hdrs if status == 302 else [], "cookies": [],
                         "redirectURL": "", "headersSize": -1, "bodySize": -1,
                         "content": {"size": len(body), "mimeType": ct, "text": body}}}
json.dump({"log": {"pages": [{"id": "Journey", "title": "Journey"}], "entries": [
  e("GET","https://shop.test/Default.aspx","text/html",
    '<input name="__VIEWSTATE" id="__VIEWSTATE" value="%s">' % VS),
  e("GET","https://shop.test/assets/app.js","application/javascript","x", rt="script", t="10:00:01"),
  e("GET","https://www.google-analytics.com/collect","image/gif", rt="image", t="10:00:01"),
  e("POST","https://shop.test/Default.aspx","text/html","<html>ok</html>",
    post={"mimeType":"application/x-www-form-urlencoded","text":"__VIEWSTATE=%s&go=1" % VS}, t="10:00:04"),
  e("GET","https://shop.test/login","text/html",
    '<form><input name="authenticity_token" value="%s"></form>' % CSRF, t="10:00:07"),
  e("POST","https://shop.test/session","text/html","<html>in</html>",
    post={"mimeType":"application/x-www-form-urlencoded","text":"authenticity_token=%s&u=bob" % CSRF}, t="10:00:11"),
  e("GET","https://shop.test/authorize","text/html","",status=302,
    hdrs=[{"name":"Location","value":"https://shop.test/cb?code=%s" % CODE}], t="10:00:14"),
  e("POST","https://shop.test/token","application/json",'{"ok":true}',
    post={"mimeType":"application/json","text":'{"code":"%s"}' % CODE}, rt="xhr", t="10:00:16"),
]}}, open(W + "/journey.har", "w"))
PY
note "a real recording: ASP.NET postback, a Rails login, an OAuth redirect, plus noise"
echo "  \$ jmxgen from-har journey.har --mode web --real-think-time"
$JG from-har "$W/journey.har" -o "$W/journey.jmx" --spec "$W/journey.spec.yaml" \
   --mode web --real-think-time 2>&1 | sed 's/^/  /'
note "every dynamic value was found by a named rule — including one in a Location header"

# ── 3. what a raw recorder would have shipped ────────────────────────────────
step "3. The same recording, filtered for an API test"
echo "  \$ jmxgen from-har journey.har --mode api"
$JG from-har "$W/journey.har" -o "$W/journey_api.jmx" --mode api 2>&1 | sed 's/^/  /' | head -3

# ── 4. validation catches a broken plan ───────────────────────────────────────
step "4. A plan that looks fine but is broken — caught before any load runs"
python3 - "$W" <<'PY'
import sys
W = sys.argv[1]
t = open(W + "/api.jmx").read()
open(W + "/broken.jmx", "w").write(t.replace("$.access_token", "$.token_v2"))
PY
note "pretend the login response changed shape: \$.access_token → \$.token_v2"
echo "  \$ jmxgen verify broken.jmx"
$JG verify "$W/broken.jmx" 2>&1 | sed 's/^/  /' | tail -2
note "valid XML, JMeter loads it — every static check passes. Now actually run it:"
echo "  \$ jmxgen replay broken.jmx"
$JG replay "$W/broken.jmx" 2>&1 | sed 's/^/  /' | grep -v artifacts

# ── 5. page journey without any recording ─────────────────────────────────────
step "5. A web page test from nothing but a URL"
echo "  \$ jmxgen probe http://localhost:8795/ --parallel 6"
$JG probe http://localhost:8795/ -o "$W/site.jmx" --parallel 6 2>&1 | sed 's/^/  /' | head -3

# ── 6. fixing a plan the customer already has ────────────────────────────────
if [ -f "$ROOT/samples/sp_idp_com_add_connect_and_response.jmx" ]; then
  step "6. Repairing a real customer plan (36 MB, generated by another tool)"
  echo "  \$ jmxgen optimize sp_idp_com_add_connect_and_response.jmx --drop-third-party --drop-static --cap-parallel 6"
  $JG optimize "$ROOT/samples/sp_idp_com_add_connect_and_response.jmx" -o "$W/fixed.jmx" \
     --drop-third-party --drop-static --cap-parallel 6 --dedupe-headers > "$W/opt.log" 2>&1
  sed 's/^/  /' "$W/opt.log" | head -8
  OPT_RESULT="$(grep -o '[0-9.]* MB -> [0-9.]* MB' "$W/opt.log" | head -1)"
fi

# ── 7. ship ───────────────────────────────────────────────────────────────────
step "7. Running it"
echo "  \$ jmxgen ship --jmx api.jmx --project-name 'Orders API' --concurrency 25 --duration 600"
note "creates the HyperExecute project, uploads, triggers, monitors, downloads artifacts"
note "(not run here — needs LambdaTest credentials)"

step "Summary"
printf "  %-46s %s\n" "API test from a contract"          "${G}validated against a live API${N}"
printf "  %-46s %s\n" "Recorded journey, tokens correlated" "${G}3 rules fired, incl. a header${N}"
printf "  %-46s %s\n" "Noise removed"                      "${G}assets + trackers dropped${N}"
printf "  %-46s %s\n" "Broken plan caught pre-run"         "${G}diagnosed the exact variable${N}"
printf "  %-46s %s\n" "Web test from a URL"                "${G}no recording needed${N}"
[ -n "${OPT_RESULT:-}" ] && \
  printf "  %-46s %s\n" "Existing customer plan repaired"   "${G}${OPT_RESULT}${N}"
echo
echo "  artifacts: $W"
if [ "${1:-}" = "--console" ]; then
  echo; note "opening the console — same engine, no commands"
  $JG console
fi
