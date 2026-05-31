# Layer 0: Demandware Platform Price Extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a product page is hosted on Salesforce Commerce Cloud (Demandware), fetch the standard `Product-Show?pid={SKU}` controller per country and read the SKU-anchored price from its clean JSON-LD, instead of guessing from rendered consumer-PDP text.

**Architecture:** Pure-additive. `scrapeAll` already fetches the input page once (for hreflang); detect Demandware from that same HTML. When detected, prepend per-country controller URLs to each country's candidate list. The existing `scrapeCountry`→`scrapeOne`→`parseProductHtml` path then tries the controller URL first and the verified result passes the existing currency + sanity + outlier gates. No new parser, no signature changes to `scrapeOne`/`scrapeCountry`.

**Tech Stack:** Plain ES modules (`.mjs`), Node's built-in `node:test` + `node:assert` (no deps), Cloudflare Worker runtime, Firecrawl for fetching.

**Key verified facts (live, 2026-05-31):**
- Rimowa consumer PDP has **zero JSON-LD** → text heuristic picks wrong numbers (UK £250 accessory, US a 9-digit ID).
- Rimowa is Demandware (`demandware.store`/`demandware.static` fingerprints; exposes `on/demandware.store/Sites-Rimowa-Site/en_GB/...`).
- `Product-Show?pid=83273171` controller response **contains clean JSON-LD** `"price":"1225.00","priceCurrency":"USD"`; the **existing `parseProductHtml` already returns 1225 USD / 1700000 KRW** from the saved controller fixtures.
- Prada PDP is NOT Demandware (`dw=false`) → Layer 0 stays inert → no regression.

**Fixtures already committed** (`test/fixtures/`):
- `rimowa_pdp_gb.html` (consumer PDP, Demandware, no price in JSON-LD)
- `prada_pdp_jp.html` (NOT Demandware — negative case)
- `rimowa_ctrl_us.html` (controller response, has JSON-LD 1225 USD)
- `rimowa_ctrl_kr.html` (controller response, has JSON-LD 1700000 KRW)

---

### Task 1: `DW_LOCALE` map + `detectDemandware`

**Files:**
- Modify: `worker/scrape-core.mjs` (add near the other `export const` maps, after `LOCALE_VARIANTS` ~line 35)
- Test: `test/layer0.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `test/layer0.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectDemandware } from "../worker/scrape-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(HERE, "fixtures", name), "utf8");

test("detectDemandware finds the site id on a Demandware page", () => {
  const html = fx("rimowa_pdp_gb.html");
  const dw = detectDemandware(html, "https://www.rimowa.com/gb/en/luggage/colour/purple/x/83273171.html");
  assert.ok(dw, "should detect Demandware");
  assert.equal(dw.siteId, "Rimowa");
  assert.equal(dw.origin, "https://www.rimowa.com");
});

test("detectDemandware returns null for a non-Demandware page (Prada)", () => {
  const html = fx("prada_pdp_jp.html");
  const dw = detectDemandware(html, "https://www.prada.com/jp/ja/p/x/P29C26_195X_F0442_S_OOO");
  assert.equal(dw, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/layer0.test.mjs`
Expected: FAIL — `detectDemandware` is not exported / not a function.

- [ ] **Step 3: Write minimal implementation**

In `worker/scrape-core.mjs`, after the `LOCALE_VARIANTS` block (~line 35), add:

```js
// Demandware (Salesforce Commerce Cloud) per-country storefront locale codes (lang_COUNTRY).
// First that verifies wins, same as LOCALE_VARIANTS. CA/CH list their multilingual variants.
export const DW_LOCALE = {
  "United States":  ["en_US"],
  "Canada":         ["en_CA", "fr_CA"],
  "France":         ["fr_FR"],
  "Italy":          ["it_IT"],
  "United Kingdom": ["en_GB"],
  "Switzerland":    ["de_CH", "fr_CH", "it_CH", "en_CH"],
  "Japan":          ["ja_JP"],
  "South Korea":    ["ko_KR"],
};

// Detect a Salesforce Commerce Cloud (Demandware) storefront and extract its site id + origin.
// Looks for the controller path `on/demandware.store/Sites-<ID>-Site` the platform always emits.
// Returns { siteId, origin } or null. Null → Layer 0 is skipped (the no-regression guarantee).
export function detectDemandware(html, inputUrl) {
  if (!html) return null;
  const m = html.match(/demandware\.store\/Sites-([A-Za-z0-9_-]+)-Site/i);
  if (!m) return null;
  let origin;
  try { origin = new URL(inputUrl).origin; } catch { return null; }
  return { siteId: m[1], origin };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/layer0.test.mjs`
Expected: PASS (2 passing).

- [ ] **Step 5: Commit**

```bash
git add worker/scrape-core.mjs test/layer0.test.mjs
git commit -m "feat(scrape-core): detectDemandware + DW_LOCALE map

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `demandwareControllerUrls` builder

**Files:**
- Modify: `worker/scrape-core.mjs` (add after `detectDemandware`)
- Test: `test/layer0.test.mjs` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/layer0.test.mjs`:

```js
import { demandwareControllerUrls } from "../worker/scrape-core.mjs";

test("demandwareControllerUrls builds Product-Show URLs per locale", () => {
  const dw = { siteId: "Rimowa", origin: "https://www.rimowa.com" };
  const us = demandwareControllerUrls(dw, "United States", "83273171");
  assert.deepEqual(us, [
    "https://www.rimowa.com/on/demandware.store/Sites-Rimowa-Site/en_US/Product-Show?pid=83273171",
  ]);
  const ca = demandwareControllerUrls(dw, "Canada", "83273171");
  assert.equal(ca.length, 2); // en_CA, fr_CA
  assert.ok(ca[0].includes("/en_CA/Product-Show?pid=83273171"));
  assert.ok(ca[1].includes("/fr_CA/Product-Show?pid=83273171"));
});

test("demandwareControllerUrls returns [] without a sku", () => {
  const dw = { siteId: "Rimowa", origin: "https://www.rimowa.com" };
  assert.deepEqual(demandwareControllerUrls(dw, "United States", ""), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/layer0.test.mjs`
Expected: FAIL — `demandwareControllerUrls` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `worker/scrape-core.mjs`, immediately after `detectDemandware`, add:

```js
// Build the standard Demandware product controller URLs for a country (one per locale variant).
// The controller response carries clean JSON-LD that parseProductHtml already reads correctly.
export function demandwareControllerUrls(dw, country, sku) {
  if (!dw || !sku) return [];
  const locales = DW_LOCALE[country] || [];
  return locales.map(
    (loc) => `${dw.origin}/on/demandware.store/Sites-${dw.siteId}-Site/${loc}/Product-Show?pid=${sku}`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/layer0.test.mjs`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add worker/scrape-core.mjs test/layer0.test.mjs
git commit -m "feat(scrape-core): demandwareControllerUrls builder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Lock in that `parseProductHtml` reads the controller JSON-LD (regression guard)

This task adds NO production code — it pins the verified fact that the existing parser already
handles controller responses, so a future change to `parseProductHtml` can't silently break Layer 0.

**Files:**
- Test: `test/layer0.test.mjs` (append)

- [ ] **Step 1: Write the test**

Append to `test/layer0.test.mjs`:

```js
import { parseProductHtml } from "../worker/scrape-core.mjs";

test("parseProductHtml reads price from the US Demandware controller response", () => {
  const html = fx("rimowa_ctrl_us.html");
  const p = parseProductHtml(html, "USD", "83273171");
  assert.equal(p.price, 1225);
  assert.equal(p.currency, "USD");
});

test("parseProductHtml reads price from the KR Demandware controller response", () => {
  const html = fx("rimowa_ctrl_kr.html");
  const p = parseProductHtml(html, "KRW", "83273171");
  assert.equal(p.price, 1700000);
  assert.equal(p.currency, "KRW");
});
```

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `node --test test/layer0.test.mjs`
Expected: PASS (6 passing). These pass with NO production change — they pin existing behavior.
If either fails, STOP: the fixtures or parser changed unexpectedly; investigate before continuing.

- [ ] **Step 3: Commit**

```bash
git add test/layer0.test.mjs
git commit -m "test(scrape-core): pin parseProductHtml reading Demandware controller JSON-LD

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire Layer 0 into `scrapeAll` (prepend controller URLs when Demandware detected)

**Files:**
- Modify: `worker/scrape-core.mjs` — `scrapeAll`, the input-page fetch block (~lines 518-538)
- Test: `test/layer0.test.mjs` (append a unit test on a small helper to avoid network)

`scrapeAll` already fetches the input page inside `if (fcKey) { try { ... const got = await fcGetHtml(inputUrl, ...) ... } }` and parses hreflang from `got.html`. We add detection there and, when positive, prepend controller URLs to every country's `targets[country]`.

- [ ] **Step 1: Write the failing test**

We don't want a network call in the unit test. Extract the prepend logic into a pure helper
`applyDemandwareTargets(targets, dw, sku)` and test that. Append to `test/layer0.test.mjs`:

```js
import { applyDemandwareTargets } from "../worker/scrape-core.mjs";

test("applyDemandwareTargets prepends controller URLs ahead of existing candidates", () => {
  const targets = {
    "United States": ["https://www.rimowa.com/us/en/x/83273171.html"],
  };
  const dw = { siteId: "Rimowa", origin: "https://www.rimowa.com" };
  const out = applyDemandwareTargets(targets, dw, "83273171");
  assert.equal(out["United States"][0],
    "https://www.rimowa.com/on/demandware.store/Sites-Rimowa-Site/en_US/Product-Show?pid=83273171");
  assert.equal(out["United States"][1], "https://www.rimowa.com/us/en/x/83273171.html");
});

test("applyDemandwareTargets seeds countries that had no candidates", () => {
  const targets = {}; // locale-less URL case → buildCountryUrls returned {}
  const dw = { siteId: "Rimowa", origin: "https://www.rimowa.com" };
  const out = applyDemandwareTargets(targets, dw, "83273171");
  assert.ok(out["Japan"][0].includes("/ja_JP/Product-Show?pid=83273171"));
});

test("applyDemandwareTargets is a no-op when dw is null", () => {
  const targets = { "United States": ["https://x/y.html"] };
  const out = applyDemandwareTargets(targets, null, "83273171");
  assert.deepEqual(out, targets);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/layer0.test.mjs`
Expected: FAIL — `applyDemandwareTargets` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `worker/scrape-core.mjs`, after `demandwareControllerUrls`, add the pure helper:

```js
// Prepend Demandware controller URLs ahead of each country's existing candidates (deduped).
// Pure (no network) so it's unit-testable. Returns the same targets object, mutated and returned.
export function applyDemandwareTargets(targets, dw, sku) {
  if (!dw || !sku) return targets;
  for (const country of COUNTRIES) {
    const ctrl = demandwareControllerUrls(dw, country, sku);
    if (!ctrl.length) continue;
    const existing = (targets[country] || []).filter((u) => !ctrl.includes(u));
    targets[country] = [...ctrl, ...existing];
  }
  return targets;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/layer0.test.mjs`
Expected: PASS (9 passing).

- [ ] **Step 5: Call the helper inside `scrapeAll`**

In `worker/scrape-core.mjs`, inside `scrapeAll`'s `if (fcKey) { try { ... } }` block, locate where
hreflang targets are applied (right after the `for (const [cc, href] of Object.entries(hl))` loop,
before the closing `} catch`). Add detection + prepend using the already-fetched `got.html`:

```js
        // Layer 0: if this is a Demandware storefront, prepend the standard product controller
        // URLs (which carry clean JSON-LD) ahead of the consumer-PDP candidates. The same
        // currency + sanity + outlier gates still apply, so a bad controller read can only fail.
        const dw = detectDemandware(got.html, inputUrl);
        if (dw) applyDemandwareTargets(targets, dw, code);
```

(`code` is already defined at the top of `scrapeAll` as `extractCode(inputUrl)`; `got.html` is the
input page already fetched for hreflang. This sits BEFORE the `if (!Object.keys(targets).length)`
guard, so a Demandware locale-less URL gets seeded and won't trip the "no URLs" early return.)

- [ ] **Step 6: Verify the full unit suite still passes**

Run: `node --test test/layer0.test.mjs`
Expected: PASS (9 passing). No network in these tests.

- [ ] **Step 7: Commit**

```bash
git add worker/scrape-core.mjs test/layer0.test.mjs
git commit -m "feat(scrape-core): Layer 0 — prepend Demandware controller URLs in scrapeAll

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Live verification (Rimowa fixed, Prada not regressed)

**Files:**
- Create (temporary, NOT committed): `worker/_live.mjs`

This task proves the end-to-end behavior against the real sites. It needs the Firecrawl key in
`worker/.dev.vars` (already present). The script is temporary and removed at the end.

- [ ] **Step 1: Write the live-check script**

Create `worker/_live.mjs`:

```js
import { readFileSync } from "node:fs";
import { scrapeAll } from "./scrape-core.mjs";
const KEY = readFileSync("./.dev.vars", "utf8").split("=")[1].trim();
const ISO = { "United States":"US","Canada":"CA","France":"FR","Italy":"IT","United Kingdom":"UK","Switzerland":"CH","Japan":"JP","South Korea":"KR" };

async function run(label, url) {
  const r = await scrapeAll(url, KEY);
  let line = label + " :: ";
  for (const [c, v] of Object.entries(r.prices)) line += ISO[c] + "=" + v.price + v.currency + "(" + v.via + ") ";
  for (const f of r.failed) line += ISO[f.country] + "=FAIL ";
  line += "| count=" + Object.keys(r.prices).length;
  console.log("LIVE " + line);
}

await run("RIMOWA", "https://www.rimowa.com/kr/ko/luggage/colour/purple/%EC%B2%B4%ED%81%AC%EC%9D%B8-%EB%9D%BC%EC%A7%80/83273171.html");
await run("PRADA",  "https://www.prada.com/jp/ja/p/%E3%82%B3%E3%83%83%E3%83%88%E3%83%B3%E3%83%96%E3%83%BC%E3%82%AF%E3%83%AC-%E3%82%AF%E3%83%AD%E3%83%83%E3%83%97%E3%83%89%E3%83%88%E3%83%83%E3%83%97/P29C26_195X_F0442_S_OOO");
```

- [ ] **Step 2: Run it**

Run: `cd worker && node _live.mjs 2>/dev/null | grep '^LIVE'`
Expected (acceptance criteria):
- **RIMOWA**: NO `£250`/`250GBP` and NO `50000JPY` anywhere in the line. US ≈ `1225USD`, KR ≈
  `1700000KRW` present, several via=`text` from the controller. `count` ≥ 4 (today's baseline).
- **PRADA**: still ≈ 7 countries, values unchanged from baseline (US 1920USD, JP 374000JPY, etc.),
  Canada may still FAIL. `count` ≈ 7. (Confirms Layer 0 is inert for non-Demandware.)

If RIMOWA still shows a wrong price: it passed the gates, so the controller didn't win that country
— inspect which `via` produced it; the controller URL for that locale likely got blocked (GB-style)
and it fell through to text. That is acceptable ONLY if the value is correct; a wrong value is a
fail — capture the country and stop.

- [ ] **Step 3: Remove the temporary script**

```bash
rm worker/_live.mjs
git status --porcelain   # expect: clean (no _live.mjs)
```

- [ ] **Step 4: Record the measured result**

Do NOT commit numbers into code. Report the exact `LIVE` lines back to the user and (if asked)
update memory. Per the false-"7 brands" lesson: report only what the run actually printed; if the
environment garbles output, re-read via a second method before trusting it.

---

### Task 6: Deploy + live re-verify on production worker (optional, gated on user OK)

**Files:** none (deploy only)

- [ ] **Step 1: Deploy the worker**

Run: `cd worker && npx wrangler deploy`
Expected: a new worker version id printed. (wrangler is authed per memory; if OAuth expired, the
user runs `wrangler login`.)

- [ ] **Step 2: Live-test the production endpoint with the Rimowa URL**

Use the deployed worker's `/scrape` with `refresh:true` to bypass the 24h cache, and confirm the
same acceptance criteria as Task 5 Step 2 (no £250/¥50,000; US 1225, KR 1700000).

- [ ] **Step 3: Report + rollback note**

Report the production result. Rollback target (per memory): git `f127c6c` / worker `3fe1fac4`.
Push to GitHub only if the user asks.

---

## Self-Review

**Spec coverage:**
- Detect Demandware platform → Task 1 ✅
- Build controller URL per country → Task 2 ✅
- Reuse existing `parseProductHtml` (no new parser) → Task 3 pins it ✅
- Plug in as Layer 0 ahead of text candidates → Task 4 ✅
- Reuse existing currency/sanity/outlier gates → inherent (controller URL flows through `scrapeOne`/`scrapeAll`, unchanged) ✅
- No per-brand hardcoding → siteId is read from the page, locales are a platform-standard map ✅
- No regression on Prada → Task 4 (detect returns null) + Task 5 Step 2 verifies ✅
- Honest limits (GB block, JP timeout fall through) → covered by existing fallback chain; Task 5 acceptance allows count ≥ 4 ✅

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `detectDemandware → {siteId, origin}` used identically in Tasks 1, 2, 4.
`demandwareControllerUrls(dw, country, sku)` and `applyDemandwareTargets(targets, dw, sku)` signatures
match between definition and call sites. `code` (from `extractCode`) is the `sku` argument — consistent.

**YAGNI check:** dropped `parseDemandware` entirely after verifying the existing parser suffices.
No sale-vs-list policy code (controller JSON-LD gives a single offer price).
