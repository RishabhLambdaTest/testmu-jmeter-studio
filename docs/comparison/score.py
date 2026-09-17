"""Score a .jmx against the synthetic HAR's answer key.

A case counts as correlated only when, in the plan itself:
  - the recorded value no longer appears literally in any request sent after
    the response that produced it, and
  - a ${VAR} stands where it was, and some extractor in the plan defines VAR,
    and that extractor's expression really finds the value in the recorded
    response (checked by running it against the HAR).
Reported claims are not trusted; the XML is."""
import json, re, sys, urllib.parse
import xml.etree.ElementTree as ET

HERE = sys.argv[1] if len(sys.argv) > 1 else "."
har = json.load(open(f"{HERE}/synthetic.har"))["log"]["entries"]
answers = json.load(open(f"{HERE}/answers.json"))

def prop(el, name):
    for c in el:
        if c.get("name") == name:
            return c.text or ""
    return ""

def load(path):
    root = ET.parse(path).getroot()
    samplers, extractors = [], []
    def walk(ht, headers_inherited):
        kids = list(ht)
        i = 0
        while i < len(kids):
            el = kids[i]
            sub = kids[i + 1] if i + 1 < len(kids) and kids[i + 1].tag == "hashTree" else None
            if el.tag == "hashTree":
                walk(el, headers_inherited)
                i += 1
                continue
            if el.tag == "HTTPSamplerProxy":
                s = {"name": el.get("testname"), "path": prop(el, "HTTPSampler.path"),
                     "method": prop(el, "HTTPSampler.method"), "args": [], "headers": [], "text": ""}
                s["follows"] = prop(el, "HTTPSampler.follow_redirects") == "true"
                for ep in el.iter("elementProp"):
                    if ep.get("elementType") == "HTTPArgument":
                        s["args"].append((prop(ep, "Argument.name"), prop(ep, "Argument.value")))
                    elif prop(ep, "Header.name"):
                        # some converters keep headers inside the sampler itself
                        s["headers"].append((prop(ep, "Header.name"), prop(ep, "Header.value")))
                if sub is not None:
                    for c in sub:
                        if c.tag == "HeaderManager":
                            for ep in c.iter("elementProp"):
                                s["headers"].append((prop(ep, "Header.name"), prop(ep, "Header.value")))
                        elif c.tag in ("RegexExtractor", "JSONPostProcessor", "BoundaryExtractor",
                                       "XPathExtractor", "XPath2Extractor", "HtmlExtractor",
                                       "JSR223PostProcessor"):
                            extractors.append({"tag": c.tag, "after": len(samplers), "el": c})
                s["text"] = " ".join([s["path"]] + [f"{a}={b}" for a, b in s["args"]] +
                                     [f"{a}: {b}" for a, b in s["headers"]])
                samplers.append(s)
            elif el.tag in ("RegexExtractor", "JSONPostProcessor", "BoundaryExtractor",
                            "XPathExtractor", "HtmlExtractor", "JSR223PostProcessor"):
                extractors.append({"tag": el.tag, "after": None, "el": el})
            if sub is not None and el.tag != "HTTPSamplerProxy":
                walk(sub, headers_inherited)
            i += 2 if sub is not None else 1
    walk(root, [])
    return samplers, extractors

def ext_var(x):
    el, t = x["el"], x["tag"]
    return {"RegexExtractor": "RegexExtractor.refname", "JSONPostProcessor": "JSONPostProcessor.referenceNames",
            "BoundaryExtractor": "BoundaryExtractor.refname", "XPathExtractor": "XPathExtractor.refname",
            "HtmlExtractor": "HtmlExtractor.refname"}.get(t) and prop(el, {
            "RegexExtractor": "RegexExtractor.refname", "JSONPostProcessor": "JSONPostProcessor.referenceNames",
            "BoundaryExtractor": "BoundaryExtractor.refname", "XPathExtractor": "XPathExtractor.refname",
            "HtmlExtractor": "HtmlExtractor.refname"}[t]) or ""

def resp_text(entry):
    r = entry["response"]
    heads = "\n".join(f"{h['name']}: {h['value']}" for h in r["headers"])
    return heads, r["content"].get("text", "")

def jsonpath_get(doc, expr):
    # enough of JSONPath for $.a.b[0].c and $..key
    expr = expr.strip()
    if expr.startswith("$.."):
        key = expr[3:]
        out = []
        def rec(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if k == key: out.append(v)
                    rec(v)
            elif isinstance(o, list):
                for v in o: rec(v)
        rec(doc); return out
    cur = [doc]
    for part in re.findall(r"\.([^.\[]+)|\[(\d+|\*)\]", expr[1:]):
        key, idx = part
        nxt = []
        for c in cur:
            if key and isinstance(c, dict) and key in c: nxt.append(c[key])
            elif idx and isinstance(c, list):
                nxt.extend(c if idx == "*" else c[int(idx):int(idx) + 1])
        cur = nxt
    return cur

def extractor_finds(x, entry, value):
    el, t = x["el"], x["tag"]
    heads, body = resp_text(entry)
    try:
        if t == "RegexExtractor":
            src = prop(el, "RegexExtractor.useHeaders")
            text = heads if src in ("true", "request_headers") else body
            if src == "true": text = heads
            m = re.search(prop(el, "RegexExtractor.regex"), text if src else body)
            if not m and not src:
                m = re.search(prop(el, "RegexExtractor.regex"), heads)
            return bool(m) and value in m.group(m.lastindex or 0)
        if t == "BoundaryExtractor":
            l, r = prop(el, "BoundaryExtractor.lboundary"), prop(el, "BoundaryExtractor.rboundary")
            for text in (body, heads):
                i = text.find(l)
                if i >= 0:
                    j = text.find(r, i + len(l)) if r else len(text)
                    if j >= 0 and value in text[i + len(l):j]: return True
            return False
        if t == "JSONPostProcessor":
            doc = json.loads(body)
            vals = jsonpath_get(doc, prop(el, "JSONPostProcessor.jsonPathExprs"))
            return any(str(v) == value for v in vals)
    except Exception:
        return False
    return False

def score(path, label):
    samplers, extractors = load(path)
    rows = []
    for a in answers:
        v = a["value"]
        enc = {v, urllib.parse.quote(v, safe=""), urllib.parse.quote_plus(v)}
        # literal occurrences in requests
        literal = [s["name"] for s in samplers if any(e in s["text"] for e in enc)]
        cookie_hdr = [s["name"] for s in samplers
                      if any(n.lower() == "cookie" and v in val for n, val in s["headers"])]
        # which variables replaced it: vars used anywhere
        # find the producing HAR entry
        src = next((e for e in har if v in resp_text(e)[0] or v in resp_text(e)[1]), None)
        good_ext = [x for x in extractors if src is not None and extractor_finds(x, src, v)]
        vars_ok = {ext_var(x) for x in good_ext} - {""}
        used = [s["name"] for s in samplers if any("${%s}" % n in s["text"] for n in vars_ok)]
        if a["expect"] == "leave":
            verdict = "ok (left alone)" if not good_ext else "FALSE POSITIVE"
        elif a["expect"] == "cookie":
            verdict = "ok (cookie manager)" if not cookie_hdr else f"HARD-CODED Cookie header in {len(cookie_hdr)} request(s)"
        else:
            # a value may legitimately remain in the request that first carried
            # it only if it is the request that received it (none here)
            in_location = src is not None and any(
                h["name"].lower() == "location" and v in h["value"] for h in src["response"]["headers"])
            src_path = urllib.parse.urlsplit(src["request"]["url"]).path if src else ""
            follows = any(s["follows"] and s["path"].split("?")[0].lstrip("/") == src_path.lstrip("/")
                          for s in samplers)
            if good_ext and used and not literal:
                verdict = "correlated"
            elif in_location and not literal and follows:
                verdict = "handled: redirect followed at run time"
            elif in_location and literal and follows:
                verdict = f"BROKEN: redirect followed AND stale target replayed ({len(literal)})"
            elif good_ext and used and literal:
                verdict = f"partly: still literal in {len(literal)} request(s)"
            elif good_ext:
                verdict = "extracted but never used"
            else:
                verdict = f"NOT correlated - literal in {len(literal)} request(s)"
        rows.append({"id": a["id"], "what": a["what"], "expect": a["expect"], "verdict": verdict,
                     "extractors": sorted({f"{x['tag']}:{ext_var(x)}" for x in good_ext}),
                     "literal_in": literal, "cookie_header_in": cookie_hdr})
    return {"label": label, "samplers": len(samplers),
            "extractors": [f"{x['tag']}:{ext_var(x)}" for x in extractors], "cases": rows}

out = {"ours": score(f"{HERE}/ours.jmx", "JMeter Studio"),
       "bzm": score(f"{HERE}/bzm.jmx", "BlazeMeter converter")}
json.dump(out, open(f"{HERE}/score.json", "w"), indent=1)
for k in ("ours", "bzm"):
    o = out[k]
    print(f"== {o['label']}: {o['samplers']} samplers, extractors: {o['extractors']}")
    for r in o["cases"]:
        print(f"  {r['id']:4} {r['verdict']:45} {r['extractors']}")
