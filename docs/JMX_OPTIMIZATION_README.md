# JMeter JMX Optimization — CPU & Memory Guide

A quick reference for reviewing customer-generated `.jmx` test plans and finding what
drives **CPU** and **memory (heap)** consumption. Written from a real review of a
37 MB / 12k-sampler customer plan.

---

## 0. The #1 rule people get wrong

JMeter uses only its **JVM heap (`-Xmx`)**, *not* the machine RAM.
A 16 GB VM still OOMs if `-Xmx` is the default (~1 GB).

- Heap **cannot** be set in `user.properties` / `system.properties` (JVM is already
  started before those load).
- Set it via the **`HEAP`** or **`JVM_ARGS`** environment variable *before* the jmeter
  command runs. If you can't edit the runner command (e.g. locked CI/HyperExecute),
  you must instead **shrink what the plan holds in memory** (this whole doc).
- Always run load in **non-GUI mode** (`jmeter -n -t plan.jmx -l out.jtl`).
  GUI mode is for editing only and holds far more in heap.

---

## 1. Memory (heap) culprits — ranked

### 🔴 Listeners that store results in RAM  ← usually the #1 OOM cause
- **View Results Tree** / **View Results Full Visualizer** — keep **every request +
  full response body** in heap, unbounded. Fine for 5-request debugging, fatal for load.
  → **Remove them.** (Or, if debugging, cap via `view.results.tree.max_results`.)
- **Aggregate Report / Aggregate Graph** — hold per-sample data to compute percentiles;
  grows with unique labels.
- **Summary Report** — lighter (bounded by number of labels) but still holds rows.
- ✅ **Keep only a Simple Data Writer** with response data OFF — it streams to disk,
  near-zero heap.

### 🔴 Unbounded runs
- `LoopController.loops = -1` **without** a scheduler → runs forever, anything buffered
  grows without limit.
- **Exception:** with `scheduler=true` + a `duration`, `-1` is *correct* (time-boxed).
  Do **not** change `-1`→`1` in that case — it would end the test after one pass.

### 🔴 Plan size itself
- The **entire test tree loads into heap as Java objects just to open the file.**
  A 37 MB / 500k-line plan can consume a large share of a 1 GB heap before any request runs.
  → **Split into smaller focused JMX files.**
- **Disabled elements are NOT free** — they're still parsed and held in memory.
  → **Delete** unused branches, don't just disable.

### 🔴 Parallel Controllers (BlazeMeter plugin)
- Each controller fans out to N concurrent requests → N responses in heap simultaneously.
- Check **"Limit max thread number"** is actually *enabled* — otherwise the max value
  is ignored and fan-out is unbounded. Cap it to what's truly needed (e.g. 3–5).

### 🟡 Saving response data
- HTTP samplers / listeners saving **response body**, **headers**, **sampler data**, or
  **as XML** multiply memory. Keep them OFF unless debugging; save JTL as **CSV**.
- **Functional Test Mode** (Test Plan) forces response data to be kept — keep it OFF for load.

### 🟡 Retrieve All Embedded Resources
- Downloads every image/CSS/JS into memory per request. Only enable if you're genuinely
  testing full page loads, and use a URL include/exclude filter.

### 🟡 Large data feeds
- **CSV Data Set** is streamed (cheap). But reading whole files via a script,
  `__FileToString`, or huge `User Defined Variables` loads it all into heap.

---

## 2. CPU culprits — ranked

### 🔴 Scripting elements (BeanShell / JSR223)
- **BeanShell** samplers/PrePost processors/assertions are **interpreted** and slow —
  high CPU under load.
  → Use **JSR223 with Groovy** and **tick "Cache compiled script"** (or use a script file).
- Uncompiled / inline JSR223 recompiles every iteration — CPU spike.

### 🔴 Regular Expression Extractors & assertions
- Complex/greedy regex over large responses is CPU-heavy per sample.
  → Prefer **JSON Extractor** / **Boundary Extractor** where possible; anchor regex.

### 🔴 Response Assertions on big bodies
- "Contains"/regex assertions scanning large responses cost CPU each time.
  → Assert on response **code/headers** where possible; scope narrowly.

### 🔴 GUI mode
- Rendering results live burns CPU (and memory). Always load-test in **non-GUI**.

### 🟡 Timers
- Missing timers → threads hammer as fast as possible (CPU + unrealistic load).
- Heavy use of **Gaussian/Random timers** across thousands of samplers adds overhead.

### 🟡 Aggressive ramp / too many threads per engine
- More threads than the box can handle → context-switching overhead, GC pressure.
  Scale horizontally (distributed/multiple engines) instead of one giant thread count.

### 🟡 Missing timeouts (indirect CPU + memory)
- No **connect/response timeout** → hung requests hold threads, sockets, and buffers
  forever. Set them once on **HTTP Request Defaults** (e.g. connect 5000 / response 30000).

---

## 3. Quick review checklist

```
[ ] Heap set via HEAP / JVM_ARGS env var (not properties file)? Non-GUI run?
[ ] View Results Tree / Full Visualizer REMOVED?
[ ] Only a Simple Data Writer left, response data OFF, CSV (not XML)?
[ ] loops=-1 only WITH scheduler+duration; else finite?
[ ] Connect + Response timeouts set on HTTP Request Defaults?
[ ] Parallel Controllers: "Limit max thread number" enabled + sane cap?
[ ] Disabled/dead elements DELETED (not just disabled)?
[ ] Scripting = JSR223 Groovy with compiled-cache (no BeanShell)?
[ ] No "Retrieve All Embedded Resources" unless intended?
[ ] Functional Test Mode OFF?
[ ] Plan split if huge (tens of MB / thousands of samplers)?
```

---

## 4. Fast grep triggers (for reviewing a JMX file)

```bash
F=plan.jmx
grep -c 'ViewResultsFullVisualizer\|ViewResultsTree' "$F"      # >0 = remove
grep -oE 'LoopController.loops">[^<]*' "$F"                     # -1 without scheduler = risk
grep -oE 'ThreadGroup.scheduler">[^<]*|ThreadGroup.duration">[^<]*' "$F"
grep -oE 'HTTPSampler.(connect|response)_timeout">[^<]*' "$F"  # empty = no timeout
grep -c 'enabled="false"' "$F"                                 # dead weight
grep -oE 'maxThreadNumber">[^<]*|limitMaxThreadNumber">[^<]*' "$F"  # parallel cap
grep -c 'BeanShell' "$F"                                       # replace with JSR223/Groovy
grep -oE 'HTTPSampler.image_parser">[^<]*' "$F"                # embedded resources
grep -oE 'TestPlan.functional_mode">[^<]*' "$F"               # should be false
```

---

**Golden path when heap is locked (can't raise `-Xmx`):**
remove result-storing listeners → cap parallel fan-out → delete dead elements →
split the plan. That's what keeps a fixed ~1 GB heap alive on a large customer plan.
