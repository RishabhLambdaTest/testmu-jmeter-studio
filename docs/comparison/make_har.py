"""A synthetic HAR with known correlation cases, and the answer key.

Everything is made up: the host is under .test (reserved, never resolves) and
every token is random. Safe to hand to a third-party converter."""
import base64, datetime, json, os, urllib.parse

HOST = "https://shop.example.test"
T0 = datetime.datetime(2026, 9, 17, 9, 0, 0)

JWT = ("eyJhbGciOiJIUzI1NiJ9." +
       base64.urlsafe_b64encode(b'{"sub":"u-4471","exp":1789000000}').decode().rstrip("=") +
       ".q7Xk2mPz9LwRt5VbN3cYh8JdFs1GaE0uI6oKlQwZxTy")
CSRF = "c5f1e8a9b27d4c3e9f0a6b1d2e4f7a8c"
SESSION = "sess_9Qm2Lx7Pw4Rt8Zk1"
ORDER_ID = "904173"
AUTH_CODE = "ac_7HkP2sQx9Lm4Wn6R"
NONCE = "n-5e2b9c71-3f4a-4d8e-a1b6-0c7d2e9f4a13"
REQ_TOKEN = "rt.K8p3Xq6Vz1Nm5Bw7"
VIEWSTATE = "dDwtMTI3OTMzNDM4NDs7Pg+/Zx9=="          # needs URL-encoding in a form body
CART_ID = "cart-3b7f9e21"
STATIC_LOCALE = "en-US"                              # repeated, but not dynamic

ANSWERS = [
    # id, what, value, expected: correlate | leave | cookie
    ("C1", "JWT from a JSON login response, sent as Authorization: Bearer", JWT, "correlate"),
    ("C2", "CSRF token from an HTML hidden input, sent in a form POST body", CSRF, "correlate"),
    ("C3", "session id set by Set-Cookie, sent back as a Cookie", SESSION, "cookie"),
    ("C4", "order id from a JSON body, used in a later URL path", ORDER_ID, "correlate"),
    ("C5", "OAuth code from a 302 Location header, sent as a query parameter", AUTH_CODE, "correlate"),
    ("C6", "nonce from a JSON body, sent inside a JSON request body", NONCE, "correlate"),
    ("C7", "token from a response header, sent as a request header", REQ_TOKEN, "correlate"),
    ("C8", "ViewState-like value from HTML, URL-encoded in a form body", VIEWSTATE, "correlate"),
    ("C9", "cart id from a JSON array element, used in a query string", CART_ID, "correlate"),
    ("C10", "locale repeated in requests and responses - not dynamic", STATIC_LOCALE, "leave"),
]

def hdrs(d):
    return [{"name": k, "value": v} for k, v in d.items()]

n = 0
def entry(method, path, req_headers=None, body=None, mime=None, status=200,
          resp_headers=None, resp_body="", resp_mime="application/json"):
    global n
    n += 1
    url = HOST + path
    q = urllib.parse.urlsplit(url).query
    req = {"method": method, "url": url, "httpVersion": "HTTP/1.1",
           "headers": hdrs({"Host": "shop.example.test", "Accept-Language": STATIC_LOCALE,
                            **(req_headers or {})}),
           "queryString": [{"name": k, "value": v} for k, v in urllib.parse.parse_qsl(q)],
           "cookies": [], "headersSize": -1, "bodySize": len(body or "")}
    if body is not None:
        req["postData"] = {"mimeType": mime, "text": body}
        if mime == "application/x-www-form-urlencoded":
            req["postData"]["params"] = [{"name": k, "value": v} for k, v in urllib.parse.parse_qsl(body)]
    rh = {"Content-Type": resp_mime, "Content-Language": STATIC_LOCALE, **(resp_headers or {})}
    return {
        "startedDateTime": (T0 + datetime.timedelta(seconds=n * 2)).isoformat() + "Z",
        "time": 80, "request": req,
        "response": {"status": status, "statusText": "OK" if status == 200 else "Found",
                     "httpVersion": "HTTP/1.1", "headers": hdrs(rh), "cookies": [],
                     "content": {"size": len(resp_body), "mimeType": resp_mime, "text": resp_body},
                     "redirectURL": rh.get("Location", ""), "headersSize": -1,
                     "bodySize": len(resp_body)},
        "cache": {}, "timings": {"send": 1, "wait": 70, "receive": 9},
    }

html_login = (f'<html><body><form action="/login" method="post">'
              f'<input type="hidden" name="csrf_token" value="{CSRF}">'
              f'<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="{VIEWSTATE}">'
              f'<input name="username"><input name="password" type="password"></form>'
              f'<p lang="{STATIC_LOCALE}">Welcome</p></body></html>')

entries = [
    # 1 page with CSRF + viewstate; sets the session cookie
    entry("GET", "/login", req_headers={"Accept": "text/html"},
          resp_mime="text/html", resp_body=html_login,
          resp_headers={"Set-Cookie": f"SESSIONID={SESSION}; Path=/; HttpOnly"}),
    # 2 form POST uses CSRF + URL-encoded viewstate; response is JSON with the JWT
    entry("POST", "/login",
          req_headers={"Cookie": f"SESSIONID={SESSION}",
                       "Content-Type": "application/x-www-form-urlencoded"},
          body=urllib.parse.urlencode({"csrf_token": CSRF, "__VIEWSTATE": VIEWSTATE,
                                       "username": "demo", "password": "demo-pass"}),
          mime="application/x-www-form-urlencoded",
          resp_body=json.dumps({"access_token": JWT, "token_type": "Bearer", "locale": STATIC_LOCALE}),
          resp_headers={"X-Request-Token": REQ_TOKEN}),
    # 3 OAuth-style redirect carrying a code
    entry("GET", "/oauth/authorize?client_id=web&response_type=code",
          req_headers={"Cookie": f"SESSIONID={SESSION}", "Authorization": f"Bearer {JWT}"},
          status=302, resp_mime="text/html",
          resp_headers={"Location": f"{HOST}/callback?code={AUTH_CODE}&state=xyz"}),
    # 4 callback uses the code
    entry("GET", f"/callback?code={AUTH_CODE}&state=xyz",
          req_headers={"Cookie": f"SESSIONID={SESSION}", "Authorization": f"Bearer {JWT}",
                       "X-Request-Token": REQ_TOKEN},
          resp_body=json.dumps({"ok": True})),
    # 5 cart: JSON array with the cart id, and a nonce
    entry("GET", "/api/carts",
          req_headers={"Cookie": f"SESSIONID={SESSION}", "Authorization": f"Bearer {JWT}"},
          resp_body=json.dumps({"carts": [{"id": CART_ID, "items": 2}], "nonce": NONCE})),
    # 6 checkout: cart id in query, nonce in JSON body, request token header
    entry("POST", f"/api/checkout?cart={CART_ID}",
          req_headers={"Cookie": f"SESSIONID={SESSION}", "Authorization": f"Bearer {JWT}",
                       "X-Request-Token": REQ_TOKEN, "Content-Type": "application/json"},
          body=json.dumps({"nonce": NONCE, "locale": STATIC_LOCALE, "pay": "card"}),
          mime="application/json",
          resp_body=json.dumps({"order": {"id": int(ORDER_ID), "status": "placed"}})),
    # 7 order page uses the order id in the path
    entry("GET", f"/api/orders/{ORDER_ID}",
          req_headers={"Cookie": f"SESSIONID={SESSION}", "Authorization": f"Bearer {JWT}"},
          resp_body=json.dumps({"id": int(ORDER_ID), "status": "placed", "locale": STATIC_LOCALE})),
    # 8 order again with the id as a query value
    entry("GET", f"/api/orders/{ORDER_ID}/receipt?lang={STATIC_LOCALE}",
          req_headers={"Cookie": f"SESSIONID={SESSION}", "Authorization": f"Bearer {JWT}"},
          resp_body=json.dumps({"receipt": "R-1"})),
]

har = {"log": {"version": "1.2", "creator": {"name": "synthetic", "version": "1"},
               "pages": [], "entries": entries}}
here = os.path.dirname(os.path.abspath(__file__))
json.dump(har, open(os.path.join(here, "synthetic.har"), "w"), indent=1)
json.dump([{"id": i, "what": w, "value": v, "expect": e} for i, w, v, e in ANSWERS],
          open(os.path.join(here, "answers.json"), "w"), indent=1)
print("wrote synthetic.har with", len(entries), "entries and", len(ANSWERS), "cases")
