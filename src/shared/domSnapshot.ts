// =====================================================================
// INERT DOM SNAPSHOTS
// =====================================================================
// A step's page HTML is saved so you can open it later and see the page as it
// was. It was saved as raw outerHTML with a <base href> so the site's CSS and
// images resolve — and that made it a LIVE PAGE, not a snapshot.
//
// On SauceDemo (a React app) the saved file contained:
//
//     <base href="https://www.saucedemo.com/">
//     <script type="module" src="/assets/index-D3OxT1jE.js"></script>
//
// Opening it fetched that bundle from the live site and ran it. React mounted
// onto #root, wiped the captured DOM and rendered a fresh app with no state —
// so the snapshot opened as a BLANK WHITE PAGE while all the evidence sat
// intact in the file. Surbhi hit this checking whether redaction had worked;
// the redaction had worked, and the page threw it away before she could see it.
//
// A snapshot has to be inert. It is a record of something that already
// happened, so nothing in it should be able to change what it shows — or, for
// an evidence file that may be opened months later on a different machine, go
// to the network and act on the user's behalf.
// =====================================================================

/**
 * Stop a saved page's scripts running, without removing them.
 *
 * Neutralised rather than deleted: the presence of a script can itself be
 * evidence (which bundle a page loaded, what an inline tag contained), and
 * deleting it silently rewrites history. An unknown `type` is how HTML says
 * "data, not code" — the browser parses the tag, keeps the text, runs nothing.
 *
 * The `type` is injected as the FIRST attribute on purpose: HTML ignores a
 * duplicate attribute, so ours wins over a `type="module"` already there.
 *
 * NOT a sandbox, and deliberately not described as one. The snapshot keeps its
 * <base href>, so stylesheets and images still load from the live site when it
 * is opened — that is what makes it look like the page it came from. What this
 * removes is the site's own CODE, which is the part that can rewrite the
 * evidence, read storage, or post somewhere.
 */
export function makeInert(html: string): string {
  return html.replace(/<script\b/gi, '<script type="application/qaflow-inert"')
}
