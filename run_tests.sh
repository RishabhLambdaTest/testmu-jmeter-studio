#!/usr/bin/env bash
# jmxgen regression suite.
#
#   ./run_tests.sh            every authoring path -> verify -> JMeter tree load
#   ./run_tests.sh --live     also start local targets and replay plans for real
#
# Exit code is the number of failures, so CI can gate on it.
set -uo pipefail
set +m            # no "Terminated" job-control noise when we stop test servers
cd "$(dirname "$0")"
ROOT="$(pwd)"
JG="python3 $ROOT/jmxgen.py"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
LIVE=0; [ "${1:-}" = "--live" ] && LIVE=1
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf "  \033[32mok\033[0m   %s\n" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf "  \033[31mFAIL\033[0m %s — %s\n" "$1" "$2"; }
skip() { printf "  \033[33mskip\033[0m %s — %s\n" "$1" "$2"; }

echo "== fixtures =="
FIX="$WORK/fixtures"; mkdir -p "$FIX/site"
cat > "$FIX/site/index.html" <<'HTML'
<html><head><title>Home</title><link rel=stylesheet href=/a.css><script src=/a.js></script></head>
<body><img src=/i.png><form action=/search method=get>
<input type=hidden name=csrf value=tok123><input name=q></form></body></html>
HTML
printf 'http://localhost:8791/\n' > "$FIX/pages.txt"
printf 'username,password\nu1,p1\n' > "$FIX/users.csv"
cat > "$FIX/api.yaml" <<'YAML'
openapi: 3.0.0
info: {title: Demo API, version: "1"}
servers: [{url: "https://api.demo.test/v1"}]
paths:
  /orders:
    get: {operationId: listOrders, tags: [Orders], responses: {"200": {description: ok}}}
    post:
      operationId: createOrder
      tags: [Orders]
      requestBody: {content: {application/json: {schema: {type: object,
                    properties: {sku: {type: string, example: "SKU-1"}}}}}}
      responses: {"201": {description: created}}
YAML
cat > "$FIX/coll.json" <<'JSON'
{"info":{"name":"Demo"},"variable":[{"key":"baseUrl","value":"https://api.demo.test"}],
 "item":[{"name":"Login","request":{"method":"POST","url":{"raw":"{{baseUrl}}/login"},
 "body":{"mode":"raw","raw":"{\"u\":\"bob\"}","options":{"raw":{"language":"json"}}}},
 "event":[{"listen":"test","script":{"exec":["pm.response.to.have.status(200);"]}}]}]}
JSON
cat > "$FIX/cmds.txt" <<'CURL'
curl -X POST https://api.demo.test/login -H 'Content-Type: application/json' --data-raw '{"u":"bob"}'
CURL
python3 - "$FIX" <<'PY'
import json, sys
F = sys.argv[1]
T = "eyJhbGciOiJIUzI1NiJ9.payload.sig"
VS = "/wEPDwULLTE2MTY2ODcyMjlkZBgB"
def e(page, m, u, ct, body="", post=None, hdrs=None, status=200, rt="xhr", started=None):
    return {"pageref": page, "startedDateTime": started or "2026-08-25T10:00:00.000Z",
            "time": 0, "cache": {}, "timings": {"send":0,"wait":0,"receive":0},
            "_resourceType": rt,
            "request": {"method": "POST" if post else m, "url": u, "headers": hdrs or [],
                        "queryString": [], "cookies": [], "headersSize": -1, "bodySize": 0,
                        **({"postData": post} if post else {})},
            "response": {"status": status, "statusText": "", "httpVersion": "HTTP/1.1",
                         "headers": [], "cookies": [], "redirectURL": "", "headersSize": -1,
                         "bodySize": -1,
                         "content": {"size": len(body), "mimeType": ct, "text": body}}}
# a mixed recording: page, asset, login+token, consumer, aspnet postback
json.dump({"log": {"pages": [{"id": "P1", "title": "Home"}], "entries": [
  e("P1","GET","https://shop.test/","text/html",
    '<input name="__VIEWSTATE" id="__VIEWSTATE" value="%s">' % VS, rt="document"),
  e("P1","GET","https://shop.test/a.js","application/javascript","x", rt="script"),
  e("P1","GET","https://shop.test/api/login","application/json",
    '{"data":{"token":"%s"}}' % T,
    post={"mimeType":"application/json","text":'{"u":"bob"}'},
    started="2026-08-25T10:00:03.000Z"),
  e("P1","GET","https://shop.test/api/cart","application/json",'{"items":[]}',
    hdrs=[{"name":"Authorization","value":"Bearer %s" % T}],
    started="2026-08-25T10:00:06.000Z"),
  e("P1","GET","https://shop.test/Default.aspx","text/html","<html>ok</html>",
    post={"mimeType":"application/x-www-form-urlencoded","text":"__VIEWSTATE=%s" % VS},
    rt="document", started="2026-08-25T10:00:09.000Z"),
]}}, open(F + "/mixed.har", "w"))
PY
echo "  fixtures ready"

echo "== local targets =="
(cd "$FIX/site" && python3 -m http.server 8791 >/dev/null 2>&1 &) ; sleep 1
echo "  http://localhost:8791 up"

echo "== authoring paths =="
run() { name="$1"; shift; out="$WORK/$name.jmx"
  if $JG "$@" -o "$out" >"$WORK/$name.log" 2>&1 && grep -q "VALID - ready to run" "$WORK/$name.log"
  then ok "$name"; else bad "$name" "$(tail -2 "$WORK/$name.log" | tr '\n' ' ')"; fi; }
run openapi      from-openapi "$FIX/api.yaml"
run openapi_auth from-openapi "$FIX/api.yaml" --login "POST /oauth/token" --csv "$FIX/users.csv:username,password"
run postman      from-postman "$FIX/coll.json"
run curl         from-curl    "$FIX/cmds.txt"
run har_auto     from-har     "$FIX/mixed.har"
run har_api      from-har     "$FIX/mixed.har" --mode api
run har_web      from-har     "$FIX/mixed.har" --mode web
run har_think    from-har     "$FIX/mixed.har" --real-think-time
run har_post     from-har     "$FIX/mixed.har" --methods POST
run probe        probe        "$FIX/pages.txt"
run probe_par    probe        "$FIX/pages.txt" --parallel 6
run url          from-url     http://localhost:8791/

echo "== correlation rules =="
$JG from-har "$FIX/mixed.har" --mode web -o "$WORK/c.jmx" >"$WORK/corr.log" 2>&1
for rule in asp.net-viewstate bearer-token; do
  grep -q "$rule" "$WORK/corr.log" && ok "rule fires: $rule" || bad "rule fires: $rule" "not correlated"
done
grep -q '\${' "$WORK/c.jmx" && ok "variables substituted" || bad "variables substituted" "no \${} in plan"

echo "== think times from recording =="
$JG from-har "$FIX/mixed.har" --real-think-time --spec "$WORK/t.yaml" -o "$WORK/t.jmx" >/dev/null 2>&1
grep -q "think_time: 3000" "$WORK/t.yaml" && ok "3s gap became think time" || bad "3s gap became think time" "not found"

echo "== workload models =="
cat > "$FIX/arrivals.yaml" <<'YAML'
name: Arrival rate
defaults: {protocol: http, domain: localhost, port: 8791}
thread_groups:
- {name: Open, model: arrivals, rate: 50, unit: S, ramp_up: 10, duration: 60,
   max_concurrency: 500, steps: [{name: GET /, method: GET, path: /}]}
- {name: Steady, model: concurrency, threads: 200, ramp_up: 30, duration: 120,
   steps: [{name: GET /, method: GET, path: /}]}
YAML
$JG build "$FIX/arrivals.yaml" -o "$WORK/arrivals.jmx" >"$WORK/arrivals.log" 2>&1
grep -q "VALID" "$WORK/arrivals.log" \
  && ok "open-workload plan is valid" || bad "open-workload plan is valid" "invalid"
grep -q "2 thread group" "$WORK/arrivals.log" \
  && ok "verifier counts plugin thread groups" \
  || bad "verifier counts plugin thread groups" "reported none"
grep -q "ArrivalsThreadGroup" "$WORK/arrivals.jmx" \
  && ok "arrivals thread group emitted" || bad "arrivals thread group emitted" "missing"
grep -q "ConcurrencyThreadGroup" "$WORK/arrivals.jmx" \
  && ok "concurrency thread group emitted" || bad "concurrency thread group emitted" "missing"
grep -q 'name="TargetLevel">\${__P(rate,50)}' "$WORK/arrivals.jmx" \
  && ok "rate overridable with -Jrate" || bad "rate overridable with -Jrate" "value baked in"
grep -q "jmeter-plugins-casutg" "$WORK/arrivals.log" \
  && ok "names the plugin jar needed" || bad "names the plugin jar needed" "vague warning"
printf 'name: x\nthread_groups:\n- {name: a, model: bogus, steps: []}\n' > "$FIX/bogus.yaml"
$JG build "$FIX/bogus.yaml" -o "$WORK/bogus.jmx" >"$WORK/bogus.log" 2>&1
grep -q "unknown thread group model" "$WORK/bogus.log" \
  && ok "rejects an unknown model" || bad "rejects an unknown model" "accepted it"

echo "== browser steps (recorded GUI -> Playwright + JMX) =="
python3 - "$FIX/gui.har" <<'PYEOF'
import json, sys
har = {"log": {"version": "1.2", "creator": {"name": "jmxgen-recorder", "version": "1.0.0"},
  "_jmxgen": {"actions": [
    {"do": "navigate", "url": "http://localhost:8791/", "transaction": "Open"},
    {"do": "click", "label": "button", "transaction": "Buy",
     "locators": [{"type": "testid", "value": "checkout"},
                  {"type": "text", "value": "Checkout", "tag": "button"}]},
    {"do": "type", "label": "input", "text": "emilys", "transaction": "Buy",
     "locators": [{"type": "name", "value": "q"}]},
    {"do": "select", "label": "select", "text": "Two", "transaction": "Buy",
     "locators": [{"type": "id", "value": "count"}]}]},
  "pages": [{"id": "Buy", "title": "Buy", "startedDateTime": "2026-01-01T00:00:00Z",
             "pageTimings": {"onContentLoad": -1, "onLoad": -1}}],
  "entries": [{"pageref": "Buy", "startedDateTime": "2026-01-01T00:00:00Z", "time": 5,
    "request": {"method": "GET", "url": "http://localhost:8791/", "httpVersion": "HTTP/1.1",
                "headers": [], "queryString": [], "cookies": [], "headersSize": -1, "bodySize": 0},
    "response": {"status": 200, "statusText": "OK", "httpVersion": "HTTP/1.1", "headers": [],
      "cookies": [], "content": {"size": 2, "mimeType": "text/html", "text": "ok"},
      "redirectURL": "", "headersSize": -1, "bodySize": 2},
    "cache": {}, "timings": {"send": 0, "wait": 5, "receive": 0}, "_resourceType": "document"}]}}
open(sys.argv[1], "w").write(json.dumps(har))
PYEOF

$JG from-har "$FIX/gui.har" --spec "$WORK/gui.yaml" -o "$WORK/gui.jmx" >"$WORK/gui.log" 2>&1
grep -q "VALID" "$WORK/gui.log"   && ok "recording -> plan with browser steps" || bad "recording -> plan with browser steps" "invalid"
grep -q "Browser journey" "$WORK/gui.yaml"   && ok "browser steps become their own thread group"   || bad "browser steps become their own thread group" "not found"
grep -q "WebDriverSampler" "$WORK/gui.jmx"   && ok "browser steps reach the .jmx" || bad "browser steps reach the .jmx" "no sampler"

$JG to-playwright "$FIX/gui.har" -o "$WORK/gui_test.py" >/dev/null 2>&1
python3 -c "import ast,sys; ast.parse(open('$WORK/gui_test.py').read())" 2>/dev/null   && ok "playwright script is valid python" || bad "playwright script is valid python" "syntax error"
grep -q "get_by_test_id('checkout')" "$WORK/gui_test.py"   && ok "test-id locator preferred" || bad "test-id locator preferred" "not emitted"
grep -q "first_of(page, \[" "$WORK/gui_test.py"   && ok "locator fallback chain emitted" || bad "locator fallback chain emitted" "single locator only"
grep -q "select_option(label='Two')" "$WORK/gui_test.py"   && ok "select action" || bad "select action" "not emitted"

# a plan with no browser steps must say so rather than write an empty script
$JG to-playwright "$WORK/curl.jmx" -o "$WORK/none.py" >"$WORK/none.log" 2>&1
grep -q "no browser steps" "$WORK/none.log"   && ok "refuses a plan with no browser steps"   || bad "refuses a plan with no browser steps" "wrote one anyway"
$JG to-playwright "$FIX/cmds.txt" -o "$WORK/none2.py" >"$WORK/none2.log" 2>&1
grep -q "expected a spec" "$WORK/none2.log"   && ok "names the file types it accepts"   || bad "names the file types it accepts" "raw parser error"

echo "== Taurus export =="
$JG to-taurus "$WORK/gui.yaml" -o "$WORK/gui.taurus.yml" >/dev/null 2>&1
python3 -c "
import yaml,sys
c = yaml.safe_load(open('$WORK/gui.taurus.yml'))
assert 'execution' in c and 'scenarios' in c, 'missing top-level keys'
sc = list(c['scenarios'].values())[0]
assert isinstance(sc.get('store-cookie'), bool), 'store-cookie must be the boolean'
assert 'cookies' not in sc, 'cookies takes a list, not a bool - bzt rejects it'
" 2>/dev/null && ok "taurus config shape" || bad "taurus config shape" "invalid for bzt"

echo "== import / optimize round-trip =="
$JG import-jmx "$WORK/har_auto.jmx" --spec "$WORK/rt.yaml" -o "$WORK/rt.jmx" >"$WORK/rt.log" 2>&1 \
  && grep -q "VALID" "$WORK/rt.log" && ok "jmx -> spec -> jmx" || bad "jmx -> spec -> jmx" "round-trip failed"
$JG optimize "$WORK/probe.jmx" -o "$WORK/opt.jmx" --drop-static >"$WORK/opt.log" 2>&1 \
  && grep -q "VALID" "$WORK/opt.log" && ok "optimize" || bad "optimize" "failed"

echo "== JMeter loads every plan =="
if command -v jmeter >/dev/null; then
  for f in "$WORK"/*.jmx; do
    n=$(basename "$f" .jmx)
    # a plan that needs an optional jpgc jar cannot load on a stock JMeter -
    # that is the plugin missing, not the plan being wrong
    needs_plugin=$(grep -c "com.blazemeter.jmeter\|kg.apc.jmeter\|com.googlecode.jmeter" "$f" || true)
    have_plugin=$(ls "$(dirname "$(readlink -f "$(command -v jmeter)")")/../lib/ext/" 2>/dev/null \
                  | grep -ci "casutg\|webdriver" || true)
    if [ "$needs_plugin" -gt 0 ] && [ "$have_plugin" -eq 0 ]; then
      skip "deep: $n" "needs a jpgc plugin this JMeter does not have"
      continue
    fi
    $JG verify "$f" --deep 2>&1 | grep -q "loaded the tree successfully" \
      && ok "deep: $n" || bad "deep: $n" "JMeter could not load it"
  done
else
  echo "  (jmeter not on PATH - skipped)"
fi

if [ "$LIVE" = "1" ]; then
  echo "== live replay =="
  cat > "$WORK/api.py" <<'PYAPI'
import json, http.server
TOKEN = "tok_LIVE"
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def _s(self, c, b):
        d = json.dumps(b).encode(); self.send_response(c)
        self.send_header("Content-Type","application/json")
        self.send_header("Content-Length", str(len(d))); self.end_headers(); self.wfile.write(d)
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length",0)))
        if self.path.endswith("/oauth/token"): return self._s(200, {"access_token": TOKEN})
        if self.headers.get("Authorization") != "Bearer "+TOKEN: return self._s(401, {})
        self._s(201, {"ok": True})
    def do_GET(self):
        if self.headers.get("Authorization") != "Bearer "+TOKEN: return self._s(401, {})
        self._s(200, {"orders": []})
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", 8792), H).serve_forever()
PYAPI
  python3 "$WORK/api.py" & APIPID=$!; sleep 2
  sed 's|https://api.demo.test/v1|http://127.0.0.1:8792/v1|' "$FIX/api.yaml" > "$FIX/api_local.yaml"
  $JG from-openapi "$FIX/api_local.yaml" --spec "$WORK/live.yaml" -o /dev/null >/dev/null 2>&1
  python3 - "$WORK/live.yaml" <<'PY'
import sys, yaml
s = yaml.safe_load(open(sys.argv[1]))
tg = s["thread_groups"][0]; tg.pop("duration", None); tg.update(threads=1, ramp_up=1, loops=1)
for t in tg["steps"]:
    for st in t.get("steps", []): st.pop("think_time", None)
yaml.safe_dump(s, open(sys.argv[1], "w"), sort_keys=False)
PY
  $JG build "$WORK/live.yaml" -o "$WORK/live.jmx" --login "POST /oauth/token" \
      --login-body '{"grant_type":"client_credentials"}' >/dev/null 2>&1
  $JG replay "$WORK/live.jmx" > "$WORK/live.log" 2>&1
  if grep -q "PASS" "$WORK/live.log"; then ok "auth token reaches request threads"
  else bad "auth token reaches request threads" "$(tail -3 "$WORK/live.log" | tr '\n' ' ')"; fi
  python3 - "$WORK/live.jmx" <<'PY'
import sys
t = open(sys.argv[1]).read()
open(sys.argv[1].replace("live", "livebad"), "w").write(t.replace("$.access_token", "$.nope"))
PY
  $JG replay "$WORK/livebad.jmx" > "$WORK/livebad.log" 2>&1
  if grep -q "correlation did not resolve" "$WORK/livebad.log"; then
    ok "replay diagnoses a broken correlation"
  else bad "replay diagnoses a broken correlation" "$(tail -3 "$WORK/livebad.log" | tr '\n' ' ')"; fi
  kill $APIPID 2>/dev/null; wait $APIPID 2>/dev/null
fi

pkill -f "http.server 8791" 2>/dev/null; wait 2>/dev/null
echo
echo "=============================================="
printf "  %d passed, %d failed\n" "$PASS" "$FAIL"
echo "=============================================="
exit $FAIL
