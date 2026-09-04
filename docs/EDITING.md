# Editing a plan after it is generated

A generated plan is a first draft. A sampler has a name only a machine would
choose, a beacon slipped through the filters, the token the correlator missed
is still sitting there as a literal. None of that is worth re-recording for.

Everything on this page happens on the result page, after **Generate plan**.

## Where it is

The **Requests** tab. Every row is editable, and says so on the right.

![The Requests table, with edit on each row](screenshots/author-edit-hint.png)

Click a row and it opens: the URL, the headers and the body that sampler will
send, with the verbs underneath.

![A request open in the inspector](screenshots/author-edit-inspector.png)

```
Rename…  Assert 200  Assert text…  Extract…  Pause 1s  Replace value…  Move up  Move down  Delete
```

They are the same verbs the recording panel uses. The difference is only when
you reach for them: the panel is for what you know while browsing, this is for
what you notice afterwards.

## How it works underneath

Every edit is applied to the **spec**, and the plan is rebuilt from it. Nothing
edits the XML.

That matters for three reasons. A plan edited five times is exactly what the
spec says, with no accumulated damage. Every rebuild runs the same validation
as a fresh plan, so an edit cannot smuggle something past the checks. And the
XML gate still guards the exit, so a plan that no parser can read is refused
before it reaches a runner.

## The scenarios

### A sampler is called something useless

`POST /api/v2/x7` tells nobody anything, and in a week it will tell you nothing
either.

**Rename…** → `Save timesheet`. The name is what appears in the report and in
HyperExecute's filter list, so this is worth doing for the handful of requests
whose timing you will actually discuss.

### A request is in the plan that should not be

A beacon, a health check, a poll that fires every five seconds, an analytics
call that survived the filters.

**Delete.** The row disappears and the plan rebuilds without it.

If that request was the source of a correlated value, you will see a warning
saying so rather than a cheerful confirmation. That is the point: the plan
would still build, still run, and fail at load with a wall of 401s.

### A 200 might not mean success

Plenty of applications return `200 OK` with an error page in the body.

**Assert text…** → type something the *successful* response contains, such as
`"orderId"`. The sample now fails when the text is missing, which is the check
that catches a green report describing a broken system.

**Assert 200** is the simpler form: the response code must be 200.

### The correlator missed a token

Auto-correlation handles bearer tokens, CSRF fields, ASP.NET `__VIEWSTATE`,
JSF, SAML and OAuth. A bespoke application can still use something none of the
rules recognise, and then the Correlations tab shows nothing and the plan
replays a value that expired the moment recording stopped.

Fix it in two moves:

1. Open the request whose **response** carries the value. **Extract…**, give
   the JSONPath (`$.data.sessionKey`) and a variable name (`SESSIONKEY`).
2. Open any request that **uses** the value. **Replace value…**, paste the
   literal exactly as it appears in the request shown above, and give the same
   variable name.

The second step replaces it everywhere in the plan, not only in the request you
clicked, because a recorded token appears in every request that used it and
fixing one would leave the rest broken.

### Every virtual user logs in as the same person

The recording contains your username, so five hundred users will replay it.

**Replace value…** on the recorded username, with a variable name such as
`username`. Then fill in **Test data**: the CSV filename and the column names.
Each user now reads its own row.

Expect a warning between those two steps. A variable nothing defines yet is
exactly what you have created, and the message says so:

> replaced in 1 place(s), now `${USERNAME}` — but variable `${USERNAME}` is
> used but never defined — define it under Test data, or with Extract on an
> earlier request.

### The plan runs faster than a person could

**Pause 1s** inserts a Flow Control pause after the request.

Recorded think times are on by default, so this is for the gaps a recording did
not capture: a page a user would read, a form they would fill in slowly.

### The order is wrong

**Move up** and **Move down**. Order matters more than it looks: an extractor
has to run before the request that uses its variable, so a reorder can quietly
invalidate a correlation. The warning after the rebuild is what tells you.

### The plan needs something the form cannot express

A database step, a GraphQL sampler, a Groovy script, a throughput or Poisson
timer, an if or loop controller.

Open **Advanced — edit the spec** at the bottom of the page. The plan is
generated from that YAML and everything the engine can build is reachable
there. Edit it, press **Regenerate from the spec**, and the result goes through
the same validation as anything else. A spec that cannot be read says why.

## Reading what it tells you

| Message | Meaning |
|---|---|
| `rename applied` | done, nothing else changed |
| `replaced in 3 place(s), now ${TOKEN}` | done, and here is what it touched |
| `… — but variable ${X} is used but never defined` | the plan still builds, and it is now wrong in a way that only shows up under load. Fix it before running |
| `… and the plan now has an error: …` | the plan is broken. The Checks tab opens on its own |

A warning keeps you on the Requests tab, because you are usually mid-edit. An
error moves you to Checks, because there is nothing to do but look.

## What it will not do yet

**Add a request.** New requests come from the recording panel's *+ Manual
request…* while recording, or from the spec editor.

**Edit a header or a body directly.** You can see both, and **Replace value…**
can change any literal in them, but there is no field-by-field editor. The spec
editor is the way in.

**Rename a transaction.** The table lists samplers, not groups. Transaction
names are set while recording, or in the spec.

**Survive a re-authoring.** Pressing **Generate plan** again rebuilds from the
source and discards the edits, by design: the source is the truth and the plan
is derived from it. Download the `.jmx`, or keep the edited spec, before
regenerating.

---

Related: [OPTIONS.md](OPTIONS.md) for every control on the page,
[TRANSACTIONS.md](TRANSACTIONS.md) for naming steps while recording, which is
the one thing no amount of editing afterwards can recover.
