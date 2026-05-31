# Layer 0: Platform-aware price extraction (Salesforce Commerce Cloud / Demandware)

Date: 2026-05-31
Status: Design — awaiting user review before plan/implementation

## Problem

The current extractor reads the **rendered consumer PDP HTML** and tries, in order: JSON-LD →
meta → embedded JS → SPA state → visible-text frequency heuristic. When a site exposes clean
structured data (Prada, Bottega, Gucci) this is accurate. When it does **not** (Rimowa: zero
JSON-LD on the PDP), the pipeline falls through to the Layer-4 text heuristic, which **guesses**
and picks wrong numbers.

### Verified evidence (live, 2026-05-31)

- **Prada** crop-top `P29C26_195X_F0442_S_OOO` → 7/8 correct (US $1,920 … JP ¥374,000 …),
  Canada fails. Clean JSON-LD, no guessing.
- **Rimowa** check-in L `83273171` → only 4/8, and 2 of those are **wrong**: UK picked
  £250 (an accessory; real bag ≈ £850) and JP picked ¥50,000 (accessory). Cause: the PDP has
  **no JSON-LD**, so Layer 4's frequency heuristic (a) picks a repeated 9-digit internal ID that
  happens to follow a `$` (US: `$417924513 ×13`), and (b) on a tie picks the *cheaper* number
  (`a[0]-b[0]` tiebreak at scrape-core.mjs:241) → the accessory.
- **Root cause confirmed:** the price exists as *data* somewhere the page fetches it from; we
  were reading *displayed text* instead, which carries no "which price is this" signal.

### Platform discovery (the breakthrough)

Rimowa is built on **Salesforce Commerce Cloud (Demandware)** — fingerprints `demandware.store`
and `demandware.static` present in the PDP; the page even exposes a controller URL:
`https://www.rimowa.com/on/demandware.store/Sites-Rimowa-Site/en_GB/Wishlist-Add?pid=83273171`.

Demandware exposes a **standard server-rendered product controller**. Hitting it directly
returned the correct price **without guessing**:

| Controller | Country | price (salesVal) | currency |
|---|---|---|---|
| `Product-Show?pid=83273171` | US | **1225** | USD ✅ |
| `Product-Show?pid=83273171` | KR | **1700000** | KRW ✅ |

This is the same product the text heuristic mangled — now exact. Because the controller path is a
**platform standard**, not a Rimowa-specific hack, the same code path should serve every
Demandware-hosted brand (per memory, **Loewe is also Demandware** — a previously "structural
limit" brand).

### Honest limits found in the same probe

- **GB returned Akamai "Access Denied"**, **JP returned 408 timeout.** Hitting the controller is
  still subject to per-country bot-blocking / transient timeouts. Retry recovers some; not all.
- Controller responses are large (US ≈ 1.16 MB). We must pick the lightest controller that still
  carries price+currency and parse defensively.
- This does **nothing** for hard bot-blocked brands (LV, Hermès) — out of scope, stays blank.

## Goal / success criteria

1. Rimowa `83273171`: the wrong prices (UK £250, JP ¥50,000) are **eliminated** — either
   corrected to the real bag price via Layer 0, or honestly dropped. **Zero wrong prices.**
2. Rimowa coverage improves vs current 4/8 (target: the countries the controller can reach).
3. **Prada must not regress** (still 7/8) — Layer 0 only activates for Demandware pages.
4. No per-brand hardcoding: detection + controller path are platform-generic.

Non-goals: LV/Hermès bot-block, sub-second speed, 100% coverage.

## Design

### Where it plugs in

`scrapeCountry(candidateUrls, country, code, fcKey, fetchImpl, visionFn)` in `scrape-core.mjs`
already tries candidate URLs then falls back to vision. We insert **Layer 0 as the first attempt**,
ahead of the text candidates:

```
scrapeCountry:
  1. (NEW) if platform == Demandware: try Demandware controller for this country → verify → return if ok
  2. existing: for each candidate URL → scrapeOne (text layers) → return if ok
  3. existing: vision fallback
  4. return last failure (honest blank)
```

Platform is detected **once** in `scrapeAll` (it already fetches the input page for hreflang) and
passed down, so we don't re-fetch.

### New pure functions (scrape-core.mjs, all unit-testable, no globals)

- `detectDemandware(html, inputUrl) -> { siteId, origin } | null`
  Finds `on/demandware.store/Sites-<X>-Site` in the page (or the `demandware.store`/
  `demandware.static` fingerprint). Returns the site id `<X>` and origin. `null` → not Demandware,
  Layer 0 is skipped entirely (this is the Prada-safety guarantee).

- `demandwareUrl(origin, siteId, dwLocale, sku) -> string`
  Builds `${origin}/on/demandware.store/Sites-${siteId}-Site/${dwLocale}/Product-Show?pid=${sku}`.

- `DW_LOCALE` map: country → Demandware `lang_COUNTRY` code
  `US:en_US, CA:en_CA, FR:fr_FR, IT:it_IT, UK:en_GB, CH:de_CH, JP:ja_JP, KR:ko_KR`.
  (CA also tries `fr_CA`; CH also `fr_CH`/`it_CH`/`en_CH` — same "first that verifies wins" pattern
  the codebase already uses for locale variants.)

- `parseDemandware(html, wantCur) -> { price, currency } | null`
  Parse the controller response. Priority: (1) `itemprop="price"` / `priceCurrency`; (2) the
  Demandware price JSON shape `"sales": { "value": N, "currency": "XXX" }` and `"list"`; choose
  **sales** if present else **list** (consistent sale-vs-regular policy across countries — fixes
  the apples-vs-oranges problem too). Reject anything that isn't a formatted price (dodges the
  10.0 / shipping noise seen in the probe).

### Reuse the existing safety gates

The Demandware result passes through the **same** verification already in `scrapeOne`/`scrapeAll`:
currency must equal the country currency, USD-equivalent sanity range [20, 1,000,000], and
cross-country median outlier rejection. So a mis-parse can only **fail** (→ honest blank), never
emit a wrong number. This is the same discipline that makes the vision fallback safe.

### Fetch + resilience

Reuse `fcGetHtml` (Firecrawl, stealth proxy, geo location, the existing 408/429/5xx
exponential-backoff retry). The controller URL is just another URL fed to it. GB Access-Denied /
JP timeout will sometimes still fail after retries → that country falls through to the text layer,
then vision, then honest blank. **No new failure mode is introduced; Layer 0 can only add coverage.**

## Risks & mitigations

- **Regression on working brands** → `detectDemandware` returns null for non-Demandware pages, so
  Layer 0 is inert for Prada/Bottega/etc. Verified by the no-regression test below.
- **Wrong controller price leaking** → blocked by the existing currency + sanity + outlier gates.
- **`Sites-<X>-Site` id not in the page** → detection returns null; we lose nothing (fall back to
  today's behavior). We do NOT guess the site id.
- **Speed** → controller responses are large; only fetched when Demandware is detected, and the
  24h cache + refresh button already absorb cold-fetch latency.

## Test plan (write BEFORE implementing — per the false-"7 brands" lesson)

Offline (saved HTML fixtures, no network):
- `detectDemandware` returns siteId `Rimowa` for the Rimowa PDP; returns null for the Prada PDP.
- `parseDemandware` on the saved US controller HTML → 1225 USD; KR → 1700000 KRW.
- `parseProductHtml` (Prada) unchanged — exact same numbers as today (regression lock).

Live (deployed worker / local node with Firecrawl key):
- Rimowa `83273171`: **no** £250 / ¥50,000 in output; US ≈ $1,225, KR ≈ ₩1,700,000 present;
  coverage ≥ today's 4/8; every emitted price passes the currency+range+outlier gate.
- Prada `P29C26_195X_F0442_S_OOO`: still 7/8, identical values (no regression).
- One more Demandware brand if a real product URL is available (e.g. Loewe) — measure honestly,
  report per-country, do not extrapolate.

## Rollback

Pure-additive on branch; stable checkpoint is git `f127c6c` / worker `3fe1fac4` (per memory).
If Layer 0 misbehaves, `detectDemandware` can be forced to return null to disable it instantly.
