# JMeter / Cloud Load Testing — Metrics Cheat Sheet

A quick reference for the dashboard parameters, the Aggregate Report columns,
percentiles, and VUH billing. Written for walking someone through a demo.

---

## 1. Dashboard Metric Groups

These are the top-level panels on a cloud load-test dashboard
(BlazeMeter / LambdaTest style).

| Parameter | What it captures | Say this in the demo |
|---|---|---|
| **Regions** | Geographic locations the virtual users were fired from (US-East, Mumbai, Frankfurt...) | "We simulated users from these regions, so we see real-world latency, not just localhost numbers." |
| **Virtual Users** | Number of concurrent simulated users active at each moment — the load curve (ramp-up → steady → ramp-down) | "This is the load we applied. Every other graph should be read against this line." |
| **Hits** | Requests sent per second (throughput / hits per second) | "How much traffic the server is actually taking per second." |
| **Errors** | Requests that failed — non-2xx, timeouts, connection resets — as count and error % | "The single most important number. If error % climbs while users climb, we've found the breaking point." |
| **Response Time** | Time from sending the request to receiving the **full** response (avg, 90/95/99th percentile, max) | "End-user perceived speed. Quote the 90th percentile, not the average — the average hides the slow users." |
| **Latency Time** | Time from sending the request to receiving the **first byte** (TTFB) | "Server thinking time. Response Time minus Latency ≈ time spent downloading the payload." |
| **Bytes** | Data transferred — response (and sent) bytes per second | "Bandwidth consumed. A spike here often explains a slow response time — heavy payloads, uncompressed images." |
| **Connect Time** | Time to establish the TCP connection + TLS/SSL handshake | "Network + handshake cost. If this is high, it's infra/DNS/SSL, not application code." |
| **Response Code** | Distribution of HTTP status codes — 200, 301, 400, 401, 404, 500, 502, 503 | "Tells us *why* it failed: 500 = app crashing, 503 = server refusing load, 401 = auth/token expiry in the script." |

### The timing relationship worth drawing on screen

```
Connect Time   ⊂   Latency Time      ⊂   Response Time
  (TCP + TLS)      (up to 1st byte)      (up to last byte)
```

### A 30-second demo narrative

1. Start with **Virtual Users** — "here's the load ramping from 10 → 100."
2. Overlay **Response Time** — "it stays flat until ~60 users, then it climbs."
3. Point at **Errors / Response Code** — "and that's where 503s appear — that's our capacity limit."
4. Close with **Latency vs Connect Time** — "connect time stayed flat, so the bottleneck is the application, not the network."

---

## 2. Aggregate / Summary Report Columns

One row per request (sampler).

| Column | What it means |
|---|---|
| **Element Label** | The request/sampler name — one row per HTTP call |
| **#Samples** | How many times that request was executed in total |
| **Avg. Resp. Time (ms)** | Mean response time across all samples |
| **Avg. Hits/s** | Throughput — requests completed per second |
| **90% line (ms)** | 90% of requests finished **faster than** this value |
| **95% line (ms)** | 95% of requests finished faster than this |
| **99% line (ms)** | 99% of requests finished faster than this — only the worst 1% were slower |
| **Max Resp. Time (ms)** | Slowest single request |
| **Min Resp. Time (ms)** | Fastest single request |
| **Avg. Bandwidth (KBytes/s)** | Data transferred per second for that request |
| **Error %** | Percentage of those samples that failed |
| **Milliseconds / Seconds toggle** | Display unit only — changes nothing in the data |

---

## 3. Percentiles — the 90 / 95 / 99 lines

Sort every response time from fastest to slowest, then walk up the list:

```
|------------------------------ all requests, sorted ------------------------------|
      50%              90%            95%           99%                        100%
    (median)        1846 ms        1868 ms       1942 ms                     6023 ms
                       ↑              ↑             ↑                           ↑
                 9 of 10 users    19 of 20      99 of 100                  worst user
                 were faster      were faster   were faster                 ever seen
```

**Why percentiles beat the average:** the average is dragged around by outliers and
hides pain. The 99% line says *"1 in every 100 users waited nearly 2 seconds"* — a
real, countable group of unhappy users. Max is a single worst case and can be a
one-off fluke, so nobody sets an SLA on it.

### Rule of thumb

| Metric | Use it for |
|---|---|
| **90%** | The typical bad day |
| **95%** | What you normally put in an SLA |
| **99%** | Tail latency / worst-experience users |
| **Max** | Spotting timeouts and GC pauses — not for targets |

### Reading a bad result

Two red flags to call out when they appear:

1. **High Error %** — a row at `100.00%` failed *every single time*. Check its
   bandwidth: a tiny KB/s value vs healthy rows means it's returning error bodies,
   not real content. That's a broken/blocked endpoint, not a performance finding.
2. **Min = 2 ms while Avg = 1774 ms** — that gap usually means the fast ones are
   cached/rejected/failing instantly while the real ones are slow.

> **Fix the errors first. Timing numbers are not trustworthy until error % is near zero.**

---

## 4. VUH — Virtual User Hours

The billing/consumption unit for cloud load testing (BlazeMeter, LambdaTest,
k6 Cloud...). It measures *how much load you generated for how long*, not how
many tests you ran.

### Formula

```
VUH = Virtual Users  ×  Test Duration (in hours)
```

### Examples

| Virtual Users | Duration | VUH consumed |
|---|---|---|
| 50 | 1 hour | 50 × 1 = **50 VUH** |
| 100 | 30 min | 100 × 0.5 = **50 VUH** |
| 500 | 12 min | 500 × 0.2 = **100 VUH** |
| 1000 | 6 min | 1000 × 0.1 = **100 VUH** |
| 10 | 90 min | 10 × 1.5 = **15 VUH** |

Rows 1 and 2 cost the same — **users and time trade off against each other**.
A short, huge test can burn as much quota as a long, small one.

### Details that actually bite you

1. **It's peak users, not average.** Most platforms bill the *maximum concurrency
   you configured*, not the area under the ramp-up curve. Ramp-up time is not free.
2. **Duration includes everything** — ramp-up + steady state + ramp-down + hold,
   usually rounded up to the nearest minute.
3. **Multiple regions multiply it.** 100 VU from 3 regions = 300 VU → 3× the VUH.
4. **Aborted tests still consume.** Cancel at minute 7 of 20 and you're charged for
   the 7 minutes run — engine spin-up time may count too.
5. **1 VU ≈ 1 JMeter thread.** Your Thread Group's *Number of Threads* drives the bill.

### Estimate before you launch

```
Threads (users) = 200
Ramp-up         = 300 s   (5 min)
Loop / duration = 900 s   (15 min)
Total runtime   = 20 min  = 0.333 h

VUH = 200 × 0.333 ≈ 67 VUH
```

### For a demo

Keep VU low and duration short — **20 users for 5 minutes is under 2 VUH** and still
produces a full set of percentile and error graphs. You don't need heavy load to show
the dashboard; you need enough samples to make the 90/95/99 lines meaningful.

---

## 5. Quick Glossary

| Term | One-liner |
|---|---|
| **Sampler** | A single request JMeter sends (HTTP, JDBC, FTP...) |
| **Thread Group** | Defines how many users, how fast they ramp, how long they run |
| **Ramp-up** | Time taken to go from 0 to full virtual users |
| **Throughput** | Requests completed per second/minute |
| **TTFB** | Time To First Byte = Latency Time |
| **SLA** | The agreed performance target, usually stated as a percentile |
| **Tail latency** | The slow end of the distribution — the 95th/99th percentile |
