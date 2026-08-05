# QATestFlow Recorder — What It Does, Feature by Feature

A guide for trying the app out. Every feature below is built and working.
For each one: **what it is**, **why it matters**, and **how to run it**.

---

## What this app is, in one paragraph

Most test automation starts with writing code. This flips it around. There's a real Chrome
browser built into the app. You drive a website normally — click, type, navigate — and the app
writes the test for you as you go: plain-English steps, each with the most stable selector it can
find. You can replay it right there and watch the browser drive itself. When something breaks it
tells you *why*, and whether the app is at fault or the test is. Then you export it as real
Playwright code for CI.

The thing it's really built around is **trust**: a green test that verifies nothing is worse than
a red one, so a lot of the app exists to catch tests that lie.

---

## Before you start

**Install:** run `qatestflow-recorder-0.1.0-setup.exe`. It's unsigned, so Windows will show
"Windows protected your PC" — click **More info → Run anyway**.

**Test sites used in the examples below:**

| Site | Login | Good for |
|---|---|---|
| https://www.saucedemo.com | `standard_user` / `secret_sauce` | most things |
| https://the-internet.herokuapp.com | — | iframes, popups, dialogs, dynamic content |
| https://demoqa.com | — | anything needing real API calls (Mock Studio) |

On SauceDemo, avoid `error_user` / `problem_user` / `visual_user` — those accounts have
*deliberate* bugs baked in, which is confusing when you're testing the tool.

**Two things worth knowing up front:**

- **The AI features need the Claude CLI** installed and logged in on the machine. Without it they
  fail loudly and clearly (never a silent pass) — and the failure explainer falls back to a
  built-in rules engine and tells you it did.
- **If you run the shared test bundle**, set a `PASSWORD` environment variable before running, or
  the login tests will fail. Passwords are deliberately never stored in test files.

---

# 1. The core loop — record, replay, export

This is the foundation. Everything else builds on it.

### Recording

**What it does.** You type a URL, hit **Go**, and a real Chrome browser loads inside the app. Press
**● Record** and just use the site. Every click, keystroke, dropdown, hover and navigation becomes
a step written in plain English.

**Why it matters.** No code, no selector hunting. And passwords show as dots — they're never
written into the test file in plain text.

**How to run it.** Type `saucedemo.com` → **Go** → **● Record** → log in and add something to the
cart → **■ Stop**. Look at the Steps panel on the right.

### Stable selectors, with a backup plan

**What it does.** For every element it builds a *ladder* of selectors, best first —
`getByTestId(...)`, then id, then role+name, then visible text, then position. Each step shows a
traffic-light dot: green means rock-solid, amber means this is the one that'll break first.

**Why it matters.** Most recorders capture one brittle selector. This captures several and knows
which is strongest, so it can fall back when the page changes.

**How to run it.** Click any selector chip in a step row to see the full ladder.

### Replay

**What it does.** **▶ Replay** and the browser drives itself through your steps, lighting each one
green as it goes.

**How to run it.** Click **▶ Replay** after recording.

### Export to real Playwright

**What it does.** **Export** turns your recording into real Playwright TypeScript, in two styles
you can toggle between:
- **Inline** — one file, straightforward `await page.getByTestId('login-button').click()`
- **Page Object** — a proper `…Page.ts` class with locators and methods, plus a spec that drives it

Passwords come out as `process.env.PASSWORD`, never the actual value. The base URL comes out as
`process.env.BASE_URL || "<recorded>"` so CI can point it anywhere.

**How to run it.** Record something → **Export** → toggle Inline ↔ Page Object → **Save**.

> Worth trying: save the export and actually run it with `npx playwright test`. It compiles and
> runs — that's been verified across all 61 saved tests, in both styles.

### Save, library and suites

**What it does.** Save a recording and it joins the library on the welcome screen, grouped into
suite folders, each test showing its recent pass/fail history as coloured dots (newest on the
left). Each suite has **▶ Run all**.

**How to run it.** **💾 Save** → name it → pick a section. Then go Home to see the library.

---

# 2. Making tests stop lying

This is the part that's unusual, and it's the point of the whole app.

### Trust score (grade A–F)

**What it does.** Every saved test gets a grade and a 0–100 score, combining: does it actually
assert anything, how stable are its selectors, how has it behaved historically, and how old is it.

**Why it matters.** A green tick tells you the steps ran. It doesn't tell you the test is any
good. A test that clicks through a flow and checks nothing will pass forever while the app burns.
The grade says so out loud.

**How to run it.** Look at any saved test in the library — the grade is on the row. Hover it for
the factor breakdown.

### Dead-assertion detector

**What it does.** Statically finds checks that can never fail — "contains empty string", a
trivial URL check, re-checking a value you just typed in, "is visible" on the element you just
clicked. Marks them ⚠ with a hint on how to fix.

**Why it matters.** This is the most common way a suite quietly becomes worthless.

**How to run it.** Open a saved test — weak checks are flagged per step, with a count in the header.

### Flaky / stable / newly-broken tagging

**What it does.** From the run history, each test gets one word: **stable**, **flaky**,
**now-failing**, **failing** or **new**. "Flaky" is used conservatively — only for tests that
flip-flop with *timing* failures. An assertion that fails is treated as a real bug, not flakiness.

**Why it matters.** "Flaky" is the label teams use to ignore failures. Being strict about it means
it stays meaningful.

**How to run it.** Visible on each library row.

### Self-healing selectors

**What it does.** When a selector breaks, instead of dying it tries to re-find the element using
several signals at once: accessible name, role, the visible text it remembers, the position it
sat in during the last green run, and a small screenshot fingerprint. If it's confident *and*
unambiguous *and* the re-run confirms it, it heals itself and carries on — and stamps the step
with a 🤖 "fixed by AI" badge so you know it happened. If it isn't confident it stops and asks.

**Why it matters.** A changed id is the single most common reason suites rot.

**How to run it.**
1. Record on `the-internet.herokuapp.com`: click **Dynamic Controls**, then add a check that
   **Remove** is visible. Save it.
2. Open the saved `.json` in Notepad and change `Dynamic Controls` to `Dynamic Controlz`.
3. **▶ Replay** → it pauses at the broken step → **Re-pick** → click the real link → it heals and
   continues.
4. Try pointing at the *wrong* element first — you'll get a "this looks different from the
   original — heal anyway?" warning.

### "What changed" page diff

**What it does.** On a failure, compares the page against how it looked during the last *green*
run, and shows what moved: text gone or added, elements missing or new, and renamed ids shown as
`id: old → new`.

**Why it matters.** It turns "element not found" into "here is what the developers changed".

**How to run it.** Run a saved test successfully once, change the site or break something, replay,
then click **🔀 What changed** on the failure.

### Smart waits

**What it does.** Instead of `sleep(3000)`, you can add a wait for **network to go idle** or for
**specific text to appear**.

**How to run it.** **＋** in the steps panel → **⏳ Wait** → pick the kind.

### Optional steps

**What it does.** Mark a step with the ◇ toggle and it's allowed to be missing. If the element
isn't there, the step is skipped instead of failing. But it still fails properly if the element
*is* there and is broken — so this can't be used to fake a passing test.

**How to run it.** Click the ◇ icon on any step. Try it on a cookie banner that only sometimes
appears.

---

# 3. When something fails

### AI failure triage ("Explain")

**What it does.** On a failure, click **💡 Explain**. It reads the failing step, the console
errors, the network errors and the screenshot, and gives you: a **verdict** (app bug / test bug /
timing / environment), a finer **category** (stale selector, stale data, authoring, …), a
plain-English explanation, a suggested next action, and an **impact** line — "blocked at step 4 of
8; these 4 never ran".

**Why it matters.** It answers the question that actually matters at 9am: *is this my problem or
the developer's?*

**Note:** the category is genuinely evidence-based, not keyword matching. The same error message
gets classified differently depending on whether the page also logged console or network errors —
"element not found" on a clean page is a stale selector; the same message on a page throwing
JavaScript errors is an app bug.

**How to run it.** Cause a real failure — e.g. `the-internet.herokuapp.com/dynamic_loading/1`,
record clicking **Start** and immediately checking the result is visible, with no wait. Replay →
it fails → **💡 Explain**.

### Deep root-cause analysis

**What it does.** A **🔬 Deep RCA** button feeds the *entire* run — every step's screenshot,
console and network — to the AI, to find a cause that started *earlier* than where the failure was
reported. Opt-in, never automatic, because it's expensive.

**How to run it.** In the Explain panel, click **🔬 Deep RCA**.

### Bug reports, three ways

**What it does.** From a failure, generate a complete bug report — repro steps, environment,
console and network evidence, screenshot, and the AI verdict. Output it as **📋 Copy**,
**Save .md**, or **📄 Save HTML** (a self-contained page with the screenshot embedded, ready to
print to PDF).

**How to run it.** After a failure → **🐞 Bug report** → pick your output.

### Jira

**What it does.** Same report, pushed straight into Jira Cloud as a ticket — or copied with the
Jira create page opened for you if you'd rather not store a token.

**How to run it.** In the bug report modal → **🎫 Jira** tab → enter your site, email, project key
and API token → **Push**.

### Version history

**What it does.** Every save snapshots the previous version of the test. **🕘 History** shows past
edits with a git-style diff of what steps changed, and one-click restore.

**How to run it.** Save a test, edit it, save again → **🕘 History**.

### Full run trace

**What it does.** Records a per-step screenshot plus the console and network activity for the
whole run, so you can step back through what happened.

**How to run it.** Set the trace dropdown to on, then replay, then open the trace viewer.

---

# 4. Checking more than "did it click"

A normal test tells you the flow worked. These tell you it also *looks* right, is *accessible*,
and is *fast*.

### Visual regression

**What it does.** Takes a screenshot baseline and compares later runs pixel by pixel. You can
**mask** regions that always change (timestamps, ads), **freeze animations**, set a threshold, and
capture the **full page** rather than just the visible part. There's also an absolute pixel floor,
so a small but real change on a huge page can't be diluted below a percentage threshold.

**How to run it.** **📸 Snapshot** on the toolbar → set masks/threshold → **Add**. Replay once to
set the baseline, then again to compare.

### Accessibility scan

**What it does.** Runs axe-core against the page and reports WCAG A/AA violations grouped by
severity with how to fix each one. You can also add it as a *gate step* with a severity budget, so
a replay fails if accessibility regresses.

**How to run it.** **♿ A11y** on the toolbar. (On SauceDemo it finds a genuine critical issue —
the unlabelled sort dropdown.)

### Performance / Core Web Vitals

**What it does.** Measures LCP, CLS, FCP and TTFB on the real session and grades them against
Google's thresholds. Also available as a gate step with a budget.

**How to run it.** **⚡ Perf** on the toolbar.

### Unified verdict

**What it does.** One report band answering four questions at once: **⚙️ does it work · 📸 does it
look right · ♿ is it accessible · ⚡ is it fast** — each pass / fail / incomplete / not-checked.

**Why it matters.** No other tool bundles these into a single run and a single answer.

**How to run it.** After a run, open **📄 Report** — the band is at the top.

### Cross-browser

**What it does.** Runs the same test on **Chromium, Firefox and WebKit** and shows ✓/✗ per engine.
The embedded browser is Chromium-only, so this shells out to real Playwright.

**How to run it.** **🧭 Cross-browser** → pick engines → run.

*Honest limit:* no visual comparison across engines, and WebKit is not literally Safari.

### Real device emulation

**What it does.** Runs the test as an actual device — **iPhone 13, iPhone SE, Pixel 7, Galaxy S9+,
iPad** — carrying the real user-agent, touch support and pixel density, not just a narrow window.

**Why it matters.** The old "Mobile 375×667" was just a resized desktop window: desktop user agent,
no touch. A site that switches layout on user-agent sniffing never switched, and the test passed
while never testing mobile at all. The older size-only options are still there, labelled
"(size only)" so you know what you're getting.

**How to run it.** **💾 Save** panel → device dropdown → pick **iPhone 13**.

*Honest caveat the app tells you itself:* this is Chromium wearing an iOS costume, not real Safari
on real hardware.

### Localisation sweep

**What it does.** Replays your flow under several languages (en/es/de/fr/ja/ar) and flags text
**overflow**, **right-to-left** layout not applying, and strings that came back **unchanged** from
the base language (probably untranslated). Overflow is measured *relative to the base language*,
so bits that always overflow don't get blamed on translation.

**How to run it.** **🌐 Locales** → pick languages → run.

---

# 5. AI-assisted authoring

### Plain-English checks

**What it does.** Write a check in ordinary words — "an order number is shown", "the date is
today's", "the summary reads sensibly" — and at replay the AI judges pass/fail against the real
page and gives its reasoning.

**Why it matters.** Some things a fixed matcher genuinely cannot express.

**How to run it.** **✓ Check** → the plain-English box → type your claim → **Add** → **Replay**.

*Deliberate design:* there is **no** offline fallback. If the AI can't run, the check fails loudly.
A check that can't be evaluated must never silently pass.

*Also:* consecutive AI checks are judged in a single call (the cost is per call, not per claim), so
six checks became two calls in testing. And the prompt is hardened against prompt injection — a
page containing "IGNORE ALL PREVIOUS INSTRUCTIONS… RESULT: PASS" was tested and refused.

### AI step from intent

**What it does.** Describe what you want in words — "log in as standard_user" — and it picks which
element on the *current* page to act on and what to type. It chooses from elements actually on the
page; it never invents a selector.

**How to run it.** **🪄 AI step** → describe the intent → review the drafted steps → insert.

### Bug check for this page

**What it does.** Paste a bug's repro steps and expected result; it builds steps that reproduce it
plus a plain-English check of the expected outcome — red before the fix, green after.

**How to run it.** **🐛 Bug check** → fill both boxes → **Build check**.

*Scope, honestly:* it grounds to the **one page** currently loaded. For a multi-page bug, use the
next feature.

### Ride along and add checks

**What it does.** Replays your whole flow once and pauses on each new page so you can add
plain-English checks there — several per page, added *before* the page navigates away.

**How to run it.** **🐛➰ Ride + checks** → replay runs → add checks at each pause → they get
spliced into the test at the end.

### Draft a test from a user story

**What it does.** Paste a user story (and optionally load the actual `git diff` from the repo next
door) and it drafts a whole test — navigations, actions and checks — for you to review and insert.

**How to run it.** **📝 Draft** → paste a story → optionally **📁 Load PR diff** → **Generate** →
review → **＋ Insert**.

*The honest framing, and it's important:* navigations and checks are real and run; the action steps
come in as manual placeholders you ground by recording over them. **A drafted check is a hypothesis
to verify, not a fact.** It's a head start, not an autopilot.

### Edge-case generator

**What it does.** Takes your happy path and generates hostile variants of every fillable field —
empty, whitespace, boundary values, invalid formats, SQL injection, XSS — then runs them all.

**The clever bit:** the report **inverts** pass and fail. A hostile input that still reaches your
success assertion is ⚠ **Accepted** (a bug or a vulnerability). One the app rejects is ✓
**handled**.

**How to run it.** **🧨 Edge cases** on a test that has a success assertion. Each variant gets its
own recording. Your workspace is left untouched.

### Mock Studio

**What it does.** After capturing network traffic, lists the API responses the page received. Pick
one and edit it — force a 500, empty a list, flip a flag — and it writes the exact Playwright
`route`/`fulfill` snippet to copy.

**Why it matters.** Testing "what happens when this is sold out" or "when the API 500s" normally
means hand-writing Playwright. This does it from a UI.

**How to run it.** Load a site that makes real API calls (`demoqa.com` works; SauceDemo has no API
so it'll show nothing) → **🌐 Net** to capture → **🎭 Mock** → pick a response → edit → **📋 Copy**.

---

# 6. API testing

This one grew well beyond "fire a request" once it met real-world use, so it gets its own section.

**What it does.** A **🔌 API request** step fires an HTTP call from the app's backend — independent
of the embedded browser, so it works on any page and never fights the page's own traffic.

- **Request** — method, URL, headers, body, with `{{env:NAME}}` resolving everywhere.
- **Assertions** — exact status, family (`2xx`), or a list (`204,404` — the "gone is gone"
  idempotent-delete form). Plus 16 real operators: `id not-empty`, `items count-gt 0`,
  `total gt 100`, type checks, header checks, nested and array paths.
- **Contract checking** — capture a known-good response's *shape*, and later runs fail if a field
  is renamed, dropped, or changes type. An *added* field is deliberately not a failure. This is the
  one check no value assertion can replace.
- **Response time budget** and a hard per-step timeout. (Node's fetch has *no* default timeout, so
  before this a dead endpoint hung the whole suite forever.)
- **Evidence on pass as well as fail** — a `↩ 201 · 142 ms` chip opens a Postman-style panel with
  what was sent and received. Secrets are masked in *both* directions, because a login request
  answers *with* a token.
- **Re-runnable data** — `{{uuid}}`, `{{timestamp}}`, `{{randomInt}}` are fresh per run but stable
  within one. And `{{saved:name}}` lifts a value *out* of a response, which is what makes
  create → verify → delete possible at all (the server invents the id, so you can't type it).
- **🧹 Teardown** — a step marked as teardown runs *even if an earlier step failed*, so a broken
  test still deletes what it created. Exports as a real `try { … } finally { … }`.
- **🔑 API login → browser session** — an API step hands its auth to the browser, so UI tests start
  already logged in. It walks the redirect chain by hand, because a form login answers with a 302
  plus Set-Cookie and plain fetch silently swallows it. And it fails *loudly* if it can't work — a
  silent "login" that leaves you logged out makes every later step fail for reasons that look
  nothing like the cause.

**How to run it.** On the welcome screen or in an empty workspace, click
**🔌 …or start with an API request**. Try `https://jsonplaceholder.typicode.com/users/1` with a
check that `id` is not empty. Then hit **📐** in the response panel to capture the contract.

---

# 7. Coverage, data and environments

### Environments

**What it does.** Named **{ base URL + credentials }** environments — dev, staging, prod — with one
active at a time. Switching re-points every navigation and fills every `{{env:NAME}}` credential,
on a *copy* of the steps. Your saved tests are never rewritten.

**Why it matters.** One click runs the entire suite against staging with no test edits. And the
exported spec honours `BASE_URL` too, so CI can do the same.

**There's a guard worth seeing.** If your test calls an API on a host the environment doesn't
cover, it warns you and names the host. That's the trap: `api.shop.com` sitting next to
`www.shop.com` never gets re-pointed, so a "staging" run quietly writes to the production
database — and every page went to staging, so nothing looks wrong.

**How to run it.** Welcome screen → **Manage…** next to "Run against" → add an environment → select
it → run any test.

### Data-driven tests

**What it does.** Put `{{tokens}}` in your steps and attach a table of rows; the test runs once per
row, each row getting its own named result.

**How to run it.** Record a login with `{{username}}` / `{{password}}` → open the data table → add
rows → replay.

### Coverage gap map

**What it does.** Crawls your site from the current page and overlays which pages your saved tests
actually visit or verify — giving you a tested-vs-untested map and a covered-% figure. It crawls
using your live logged-in session, so pages behind a login are reachable.

**How to run it.** Log in to a site → **🗺️ Coverage** → let it crawl.

### Living documentation and AC checklist

**What it does.** **📖 Suite docs** turns your whole library into a plain-English coverage document
grouped by suite — each test's actions and the checks it makes. Dead checks are struck through and
*not* counted as coverage. **✅ AC checklist** lets you paste acceptance criteria and have the AI map
each one to the tests that cover it; an uncovered AC is a visible gap.

**How to run it.** Both are on the welcome screen.

### Test-data tracking

**What it does.** Mark a step as "creates data" and name the entity. Suite docs then flags "N tests
create data but have no teardown" — the orphan-records risk.

**How to run it.** 🗃️ toggle on any step.

### Chaos: slow network

**What it does.** A **🐢 Slow net** toggle replays under a throttled (~Slow 3G) connection to surface
timing flakiness. The failure explainer knows about it, too — it won't tell you to go restart a
server that was never down.

**How to run it.** Toggle **🐢 Slow net** next to the trace dropdown, then replay.

### Wait for a human

**What it does.** A **🙋 Wait for me (manual)** step pauses the replay for 2FA, a CAPTCHA or a manual
eyeball, then continues when you click.

**How to run it.** **＋** → **🙋 Wait for me (manual)** → set the message.

### Loops and branching

**What it does.** **🔁 Repeat N times**, **🔁 Repeat for each element**, and **🔀 If / Otherwise** —
real control flow that works the same in the app and in the exported Playwright.

**One nice touch:** if a branch's checks all sat in the path that *wasn't* taken, the report says so
in an amber note — because a green run where nothing was checked looks identical to one where
everything was.

**How to run it.** **＋** → **🔁 Repeat** or **🔀 If…**.

---

# 8. Working at scale, and as a team

### Reusable blocks

**What it does.** Save a run of steps as a named block and link it into many tests. Editing the
block updates every test that links it.

**And it shows you the blast radius:** each block shows "used by N", hovering names them, and
deleting warns "breaks N linked tests".

**How to run it.** **🧩 Blocks** → save a range as a block → link it into another test.

### Tags

**What it does.** A test lives in one suite folder but can carry many tags — `@smoke`, `@auth`,
`@critical`. Filter by them, and they carry into the export as Playwright's own tag option so
`--grep @smoke` selects the same set in CI.

**How to run it.** Add tags in the save panel → click a tag chip in the library to filter.

Note that the search box, the status filters (Failing/Passing/Flaky) and the tag chips all narrow
*together* — and **▶ select all shown** follows whatever's currently filtered, not the whole library.

### Run all, and run in parallel

**What it does.** Run a whole suite sequentially in the embedded browser, or **⚡ Run in parallel**,
which hands every selected test to real headless Playwright with multiple workers.

**Why sequential exists at all:** there is exactly *one* embedded browser, so two tests genuinely
can't drive it at once. Parallel isn't a missing feature in-app; it's architecturally impossible,
which is why parallel runs go out to headless Playwright instead.

Tests that can't run headless (ones with a manual-wait step, for instance) are held back and told
to you, rather than silently failing.

**How to run it.** Library → tick some tests → **▶ Run selected** or **⚡ Run in parallel**.

### Scheduled monitors

**What it does.** Promote a saved test to a monitor that runs on a schedule (5 minutes to 4 hours),
with its own pinned environment and alerts on failure. Failures retry up to 3 times before alerting
— one transient blip shouldn't wake you — and alerts go to a desktop notification and optionally a
Slack/Discord/Teams webhook.

**How to run it.** Welcome screen **or the workspace toolbar** → **📡 Monitors** → promote a test →
set interval → enable.

**Editing one afterwards.** Both the **schedule** and the **environment** are dropdowns on the
monitor's own card, so you can change either in place. Neither used to be editable — changing a
monitor's cadence meant deleting it and building a new one, which threw away its entire run history.
A monitor whose environment has since been deleted shows an amber **⚠ deleted environment** rather
than looking like a normal setting: with no environment pinned, *none* of its variables are applied.

**When a variable is missing.** If the test uses `{{env:NAME}}` and nothing supplies a value, the
monitor refuses to run and says so — *"1 environment variable had no value: `{{env:SAUCE_PW}}`"* —
recorded as **⚠ Can't run** rather than ✗ Failing. The two mean different things: your setup is
broken, not the site. (Before this, the run went ahead with the raw token as a password, stayed on
the login page, and reported a failed URL assertion — an error that says nothing about the cause.)

**Watching one mid-run.** The dashboard opens from the workspace as well as the welcome screen, and
stays available while a batch is running. While it's open you'll see an amber note that the page is
hidden — any open dialog hides the embedded browser, and a screenshot taken then would come back
blank. Close it to bring the page back.

*Honest scope:* this runs while the app is open. It's a strong local "is my test still green while
I work" watchdog, not 24/7 synthetic monitoring. A scheduled monitor also waits for any batch you're
running (suite, data-driven, locales or edge cases) to finish before it starts, so a background run
can never gatecrash your foreground work.

### CI export

**What it does.** A checkbox in the export modal writes a ready-to-use GitHub Actions workflow next
to your spec, with any `{{env:NAME}}` values wired to repo secrets.

**How to run it.** Export → tick **⚙️ CI workflow**.

### Sharing your library

**What it does.** **📦 Export bundle** packages your tests, blocks, upload files and tags into one
file with a README. **📥 Import bundle** brings them in, with a keep-both option so nothing is
overwritten.

**Passwords are stripped on the way out** — they become `{{env:PASSWORD}}` references, and any
password columns in a data table are scrubbed. Run history, trust scores and sessions are stripped
too, since those are personal to your machine.

**How to run it.** Welcome screen → **📦 Export bundle**. The button tells you what it will take —
it reads *(all)*, *(shown)* if a filter is active, or *(N ticked)* if you've selected some. It
follows whatever's on screen, so you can't accidentally ship the whole library when you meant three
tests.

### Secrets

**What it does.** Passwords marked secret are stored outside the test file entirely, in your user
profile. The test keeps only a reference. This closed a real hole — masked passwords used to still
be sitting in plain text inside files designed to be shared and committed.

---

# Known limits — stated up front

Rather than let you find these the hard way:

- **Network replay from a HAR** works in the *exported* test but is disabled inside the app — the
  low-level interception crashed the embedded browser and couldn't be stabilised. Mock Studio is
  the useful version of this.
- **Error injection (forced 500s)** is deferred for the same reason. Slow-network chaos works.
- **Cross-browser** has no visual comparison, and WebKit isn't literally Safari.
- **Device emulation** is Chromium emulating a device, not real hardware.
- **Monitors** only run while the app is open.
- **Bug check** grounds to one page at a time; ride-along covers multi-page.
- **Drafted tests** need their action steps grounded by recording over them.
- **Mock Studio** shows nothing on a static site — it needs a site that makes real API calls.

---

# How the app itself is tested

A testing tool that isn't tested is a bad joke, so here's the honest picture.

**Unit tests — 66 of them, ~0.4 seconds.** They cover the four modules where this project has
actually shipped bugs: the `{{token}}` engine, the control-flow pairing that matches `repeat` with
`endRepeat`, the failure classifier for headless runs, and the list of environment-variable names
the operating system already defines. They were chosen by bug history, not by what was easy to
reach.

**The suite was mutation-tested.** The source was broken on purpose, four different ways, to check
the tests noticed. Three were caught immediately. The fourth wasn't — a test that was passing for
the wrong reason — and chasing that turned up a piece of dead code in the failure classifier, which
is now documented rather than quietly tested into a false green.

**A pre-commit hook runs the suite**, so a commit that breaks any of it is refused rather than
merely discouraged.

*Honest scope:* this covers pure logic only. Anything needing a real window — recording, replay, the
embedded browser, IPC between processes — is still verified by hand and by running exported specs
for real. That last technique is what found most of the serious bugs in this project: the in-app
engine is lenient, real Playwright is not, and comparing the two is what exposed exports that had
never compiled and tests that passed while checking nothing.

*(These are developer tests. They run from the project folder with `npm test`; they are not part of
the installed app, which ships compiled and has no source to test.)*

---

# If you want the short version

Three things are worth your time above the rest:

1. **Record → replay → export** (Section 1) — the foundation, ~3 minutes.
2. **Self-healing and the failure explainer** (Sections 2 and 3) — the actual differentiator.
3. **The unified verdict** (Section 4) — one run answering works / looks right / accessible / fast.

And if you only try one thing that shows what the app is *for*: open a saved test with a good
grade, then look at one with a **D or F**, and see why it's rated that way. That gap — between "the
test passed" and "the test is worth having" — is what the whole thing is built around.
