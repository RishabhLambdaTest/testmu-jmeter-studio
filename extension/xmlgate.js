/* The last check before a plan leaves the extension.
 *
 * The engine already runs jmxgen's own verify(), which parses the plan with a
 * real XML parser and reports what it finds. This is deliberately a second,
 * independent opinion, in the browser rather than in WebAssembly, sitting on
 * the two exits that matter: Download .jmx, and the upload to HyperExecute.
 *
 * The reason for two is that they fail differently. verify() reports; this
 * refuses. A plan that cannot be parsed is not a test plan, and shipping one to
 * a runner buys nothing but a job that fails ten minutes later with a stack
 * trace about an unexpected end of file.
 *
 * What it will not do is second-guess JMeter on anything but validity. A plan
 * with one sampler and no assertions is a poor test, and that is the author's
 * business. A plan that is not well-formed XML is nobody's business.
 *
 * A control character from a binary body recorded raw needs no check of its
 * own: it is not a legal XML character, so the parse below rejects it and
 * names the line, which is more than a hand-rolled scan would manage.
 */

const JMX_SAMPLERS = [
  "HTTPSamplerProxy", "JSR223Sampler", "DebugSampler", "TestAction",
  "WebDriverSampler", "JavaSampler", "BeanShellSampler",
];
const JMX_GROUPS = [
  "ThreadGroup", "SetupThreadGroup", "PostThreadGroup",
  "com.blazemeter.jmeter.threads.arrivals.ArrivalsThreadGroup",
  "kg.apc.jmeter.threads.UltimateThreadGroup",
];

/* Returns { ok, problems: [...] }. Every problem names the thing to look at,
   because "invalid plan" on its own tells the reader nothing they can act on. */
function jmxGate(xml, label = "the plan") {
  const problems = [];
  if (!xml || !xml.trim()) return { ok: false, problems: [`${label} is empty`] };

  const doc = new DOMParser().parseFromString(xml, "text/xml");

  /* DOMParser reports a failure as a parsererror element rather than throwing,
     and puts it in the document when the parse fails at the top level. */
  const bad = doc.querySelector("parsererror");
  if (bad) {
    /* Chrome wraps the real message in a sentence meant for a browser window.
       Keep the part that names the line and the fault, drop the rest. */
    const detail = (bad.textContent || "")
      .replace(/This page contains the following errors?:?/i, "")
      .replace(/Below is a rendering of the page.*/is, "")
      .replace(/\s+/g, " ").trim() || "unknown parse error";
    return { ok: false, problems: [`${label} is not well-formed XML: ${detail}`] };
  }

  const root = doc.documentElement;
  if (!root || root.nodeName !== "jmeterTestPlan") {
    problems.push(`${label} does not start with <jmeterTestPlan>, so JMeter ` +
                  `will not open it (found <${root ? root.nodeName : "nothing"}>)`);
    return { ok: false, problems };
  }

  if (!doc.querySelector("TestPlan")) problems.push(`${label} has no <TestPlan>`);

  const groups = JMX_GROUPS.reduce(
    (n, t) => n + doc.getElementsByTagName(t).length, 0);
  if (!groups) {
    problems.push(`${label} has no thread group, so nothing would run`);
  }

  let samplers = JMX_SAMPLERS.reduce(
    (n, t) => n + doc.getElementsByTagName(t).length, 0);
  if (!samplers) {
    // a plugin sampler this list does not know about is still a sampler
    samplers = [...doc.getElementsByTagName("*")]
      .filter((el) => /Sampler$/.test(el.nodeName)).length;
  }
  if (!samplers) {
    problems.push(`${label} has no samplers, so it would send no requests`);
  }

  return { ok: !problems.length, problems };
}

if (typeof window !== "undefined") window.jmxGate = jmxGate;
