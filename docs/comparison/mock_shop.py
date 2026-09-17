"""A local stand-in for shop.example.test that issues FRESH values every time
and rejects stale ones, so a plan passes only if it really correlates.

Every check that fails answers 4xx with the reason in the body."""
import json, secrets, sys, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

S = {}   # session id -> state
DRIFT = len(sys.argv) > 2 and sys.argv[2] == "drift"   # same app, a release later

def fresh(prefix=""):
    return prefix + secrets.token_hex(8)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json", headers=None):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Language", "en-US")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        print(f"{self.command} {self.path.split('?')[0]} -> {code} {body if code >= 400 else ''}", flush=True)

    def sess(self):
        c = self.headers.get("Cookie", "")
        for part in c.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "SESSIONID" and v in S:
                return S[v]
        return None

    def bearer(self, st):
        return st and self.headers.get("Authorization", "") == "Bearer " + st.get("jwt", "?")

    def body(self):
        n = int(self.headers.get("Content-Length", "0") or 0)
        return self.rfile.read(n).decode() if n else ""

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        st = self.sess()
        if u.path == "/login":
            sid = fresh("sess_")
            S[sid] = {"csrf": fresh(), "vs": fresh("vs+/") + "==", }
            extra = ' autocomplete="off"' if DRIFT else ""
            html = (f'<html><body><form action="/login" method="post">'
                    f'<input type="hidden" name="csrf_token" value="{S[sid]["csrf"]}"{extra}>'
                    f'<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="{S[sid]["vs"]}">'
                    f'<input name="username"><input name="password" type="password"></form>'
                    f'<p lang="en-US">Welcome</p></body></html>')
            return self.send(200, html, "text/html", {"Set-Cookie": f"SESSIONID={sid}; Path=/"})
        if not st:
            return self.send(401, "no valid session cookie")
        if u.path == "/oauth/authorize":
            if not self.bearer(st): return self.send(401, "stale bearer token")
            st["code"] = fresh("ac_")
            return self.send(302, "", "text/html", {"Location": f"/callback?code={st['code']}&state=xyz"})
        if u.path == "/callback":
            if not self.bearer(st): return self.send(401, "stale bearer token")
            if q.get("code") != st.get("code"): return self.send(400, "stale oauth code")
            if self.headers.get("X-Request-Token") != st.get("rt"): return self.send(403, "stale X-Request-Token")
            st["code"] = None                       # single use
            return self.send(200, json.dumps({"ok": True}))
        if u.path == "/api/carts":
            if not self.bearer(st): return self.send(401, "stale bearer token")
            st["cart"], st["nonce"] = fresh("cart-"), fresh("n-")
            return self.send(200, json.dumps({"carts": [{"id": st["cart"], "items": 2}], "nonce": st["nonce"]}))
        if u.path.startswith("/api/orders/"):
            if not self.bearer(st): return self.send(401, "stale bearer token")
            oid = u.path.split("/")[3]
            if oid != st.get("order"): return self.send(404, "unknown order id " + oid)
            if u.path.endswith("/receipt"):
                return self.send(200, json.dumps({"receipt": "R-1"}))
            return self.send(200, json.dumps({"id": int(oid), "status": "placed", "locale": "en-US"}))
        return self.send(404, "no route")

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        st = self.sess()
        raw = self.body()
        if not st:
            return self.send(401, "no valid session cookie")
        if u.path == "/login":
            f = dict(urllib.parse.parse_qsl(raw))
            if f.get("csrf_token") != st["csrf"]: return self.send(403, "stale csrf_token")
            if f.get("__VIEWSTATE") != st["vs"]: return self.send(403, "stale or badly encoded __VIEWSTATE")
            st["jwt"], st["rt"] = "eyJ" + fresh() + "." + fresh(), fresh("rt.")
            return self.send(200, json.dumps({"access_token": st["jwt"], "token_type": "Bearer", "locale": "en-US"}),
                             headers={"X-Request-Token": st["rt"]})
        if u.path == "/api/checkout":
            if not self.bearer(st): return self.send(401, "stale bearer token")
            if q.get("cart") != st.get("cart"): return self.send(404, "unknown cart " + q.get("cart", ""))
            if self.headers.get("X-Request-Token") != st.get("rt"): return self.send(403, "stale X-Request-Token")
            try:
                j = json.loads(raw)
            except ValueError:
                return self.send(400, "body is not JSON")
            if j.get("nonce") != st.get("nonce"): return self.send(403, "stale nonce")
            st["order"] = str(secrets.randbelow(900000) + 100000)
            return self.send(200, json.dumps({"order": {"id": int(st["order"]),
                                                       "status": "confirmed" if DRIFT else "placed"}}))
        return self.send(404, "no route")

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
