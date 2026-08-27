"""mitmproxy addon: write captured traffic as a HAR jmxgen can read.

Shipped rather than relying on mitmproxy's own --set hardump, which only exists
in 10.1+; this works on any version that has the modern addon API.

    mitmdump -s mitm_har.py --set jmxgen_har=session.har -p 8080
"""

import base64
import json
import time

from mitmproxy import ctx


class HarWriter:
    def __init__(self):
        self.entries = []
        self.path = "session.har"

    def load(self, loader):
        loader.add_option("jmxgen_har", str, "session.har",
                          "Where to write the HAR when mitmdump exits")

    def configure(self, updated):
        if "jmxgen_har" in updated:
            self.path = ctx.options.jmxgen_har

    @staticmethod
    def _headers(msg):
        return [{"name": k, "value": v} for k, v in msg.headers.items()]

    @staticmethod
    def _text(msg):
        try:
            return msg.get_text(strict=False) or ""
        except Exception:
            try:
                return base64.b64encode(msg.raw_content or b"").decode()
            except Exception:
                return ""

    def response(self, flow):
        req, res = flow.request, flow.response
        started = getattr(flow.request, "timestamp_start", None) or time.time()
        entry = {
            "pageref": "Captured",
            "startedDateTime": time.strftime("%Y-%m-%dT%H:%M:%S",
                                             time.gmtime(started))
                               + ".%03dZ" % int((started % 1) * 1000),
            "time": 0,
            "cache": {},
            "timings": {"send": 0, "wait": 0, "receive": 0},
            "request": {
                "method": req.method,
                "url": req.pretty_url,
                "httpVersion": req.http_version,
                "headers": self._headers(req),
                "queryString": [{"name": k, "value": v}
                                for k, v in req.query.items(multi=True)],
                "cookies": [], "headersSize": -1,
                "bodySize": len(req.raw_content or b""),
            },
            "response": {
                "status": res.status_code,
                "statusText": res.reason or "",
                "httpVersion": res.http_version,
                "headers": self._headers(res),
                "cookies": [], "redirectURL": res.headers.get("location", ""),
                "headersSize": -1, "bodySize": len(res.raw_content or b""),
                "content": {
                    "size": len(res.raw_content or b""),
                    "mimeType": res.headers.get("content-type", ""),
                    "text": self._text(res),
                },
            },
        }
        body = self._text(req)
        if body:
            entry["request"]["postData"] = {
                "mimeType": req.headers.get("content-type", ""), "text": body}
        self.entries.append(entry)

    def done(self):
        har = {"log": {
            "version": "1.2",
            "creator": {"name": "jmxgen-mitm", "version": "1.0"},
            "pages": [{"id": "Captured", "title": "Captured",
                       "startedDateTime": "1970-01-01T00:00:00.000Z",
                       "pageTimings": {}}],
            "entries": self.entries,
        }}
        with open(self.path, "w", encoding="utf-8") as fh:
            json.dump(har, fh, indent=1)
        ctx.log.info("jmxgen: wrote %d entries to %s" % (len(self.entries), self.path))


addons = [HarWriter()]
