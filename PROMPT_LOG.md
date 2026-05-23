# Prompt Log — Vibe Coding Project

**Owner:** Mao Tabata · bridge11korea@gmail.com
**Class:** AP Macroeconomics — Independent Project 2026
**Purpose:** Required for the Executive Summary. 3–5 iterations where I directed an AI tool (Claude Code) to build, fix, or change something. Each iteration is logged from BOTH a coding perspective and a design perspective, with what worked and what didn't — to show the real Research Loop, not a polished after-the-fact story.

**Tool used:** Claude Code (CLI), powered by Anthropic Claude (Opus 4.7, 1M-token context).
**Learning stack:** direct conversation with Claude (it explained concepts I didn't know — CORS, API key security, Gemini grounding, CSS blur coordinates) · Cloudflare Workers docs · Google AI Studio docs.

---

## Iteration 1 — Initial build

- **Goal:** Stand up the first version of the site.
- **My prompt:**
  > "I need to build a website for my AP Macro project. User searches a product, AI removes the logo of that product and shows the image, AI searches the price for it in different countries, considers exchange rate and the product's value in each country, and shows me a ranking of where I can buy it the cheapest."
- **What it did (code):** Single-file `index.html` with embedded CSS/JS. Hardcoded a JS database of 8 products (LV Neverfull, Chanel Classic Flap, Rolex Submariner, etc.) with per-country prices in local currency. Static `RATES` object for FX conversion to a user-selected home currency. Pure DOM rendering — no framework, no build step. Math for "% spread", "you'd save X% buying from cheapest country" all in vanilla JS.
- **What it did (design):** Clean "shopping from" locale picker. Click-to-pick product cards. A "would you still buy it without the logo?" reveal panel. Horizontal CSS bar chart for the country ranking, with a colour highlight on the cheapest country. Comparison table underneath with VAT and tourist-refund notes per country.
- **What worked:** The math and the UX flow worked correctly in v1. The de-brand → reveal → ranking storyline read clearly even with no styling effort. Local-first meant I could iterate fast.
- **What didn't work:** "Live AI search" was a lie — the database was static and capped at 8 products. The visual felt like a generic school project. No way to scale to "any product."
- **What I changed next:** Realised a static GitHub Pages site can't safely call an AI API without exposing the key — set that aside for later (Iteration 4).

---

## Iteration 2 — Editorial redesign

- **Goal:** Make the site look like a luxury / editorial product, not a generic student demo.
- **My prompt:**
  > "I don't like the emojis. Remove them. Make the font and design more 洗練された、高級感あふれる — like a luxury magazine."
- **What it did (code):** Loaded **Playfair Display** (headings) and **Inter** (body) via Google Fonts `<link>`. Restructured the CSS around custom properties: `--bg:#f7f4ee` (warm ivory), `--gold:#8a6d33` (antique gold), `--ink:#1c1a17` (near-black). Replaced every emoji-using component with proper HTML: flag emoji → small uppercase country-code badges (`US`, `FR`, `JP`); category emoji → italic serif names.
- **What it did (design):** Warm ivory + gold palette throughout. Hairline rules between sections, generous whitespace, numbered overlines on each section ("01 — Locale", "02 — The Product"). Serif headlines paired with a clean sans body. Buttons became underlined link-style instead of solid pill buttons. Read like a Vogue or Cereal magazine spread instead of a tech demo.
- **What worked:** Visual identity shifted from "student tech demo" to "editorial luxury" in a single pass. Country-code badges actually read cleaner than colourful emoji at small sizes. The palette felt cohesive.
- **What didn't work:** Playfair body weight was a touch thin to read comfortably on phones — had to bump the body size and weight slightly. The first gold accent was over-saturated and looked tacky; we toned it down to a muted antique gold. Removing all emoji also stripped a bit of warmth from the "shopping from" selector — replaced with a small flower glyph as a compromise.
- **What I changed next:** Realised the photo blur was way too heavy — I couldn't see the product itself.

---

## Iteration 3 — Logo-only blur (UI fix)

- **Goal:** Show the product clearly while hiding ONLY the logo.
- **My prompt:**
  > "The mosaic is too strong and I can't see the product. Can you only hide the logo?"
- **What it did (code):** Added an optional `logoBox: {x, y, w, h}` field on each product (percentages of the image, top-left origin). The site overlays a `backdrop-filter: blur(16px) brightness(0.97)` on an absolutely-positioned div sized to the box, sitting on top of an otherwise-sharp `<img>`. Removed the previous global `filter: blur()` on the whole image. Soft fallback blur for products without a `logoBox` (e.g. iPhone, MacBook).
- **What it did (design):** Bag silhouettes now visible — you can clearly see "it's a structured tote bag" — but the monogram or clasp is unreadable mush. The reveal moment got more satisfying because only the logo flips from blurred to sharp, rather than the whole image. LV's monogram covers the whole canvas → big box (`{x:13, y:44, w:74, h:48}`); Chanel's "CC" clasp is a pinpoint (`{x:42, y:69, w:16, h:11}`); Gucci's "GG" is medium (`{x:41, y:49, w:25, h:19}`). Claude actually opened each photo and set the four coordinates by eye.
- **What worked:** Visibility + concealment at the same time. The per-product coordinate approach gave precise control. Reveal moment felt deliberate, not "everything un-blurs at once."
- **What didn't work:** Every new product needs me to eyeball four coordinates manually — doesn't scale. The concept partially breaks down for tech products (iPhone, MacBook, AirPods) — they don't have a single, censor-able logo, so the soft-overall-blur fallback is weaker than the precise logo-box approach.
- **What I changed next:** Wanted the site to handle ANY product, not just my 8. That meant a real backend.

---

## Iteration 4 — Cloudflare Worker backend (security & architecture)

- **Goal:** Let visitors type any product (Prada bracelet, Thom Browne belt, anything) and have the site really look up its price live.
- **My prompt:**
  > "I want users to type any product — Prada bracelet, Thom Browne belt, whatever — and the site looks it up. Use the Gemini API? I'll give you the key."
- **What it did (code):** Claude **refused to take the API key in chat** and explained why no API key can live in a public GitHub Pages site (anyone can View Source and steal it). Proposed adding a free **Cloudflare Worker** in front of the site as a server-side proxy. He wrote `worker/worker.js` with two endpoints:
  - `GET /?q=<product>` — calls **Gemini 2.5 Flash** with Google Search grounding, returns structured JSON: brand, origin, category, blurb, per-country prices in local currency, image URL, source URLs, model used.
  - `POST /debrand` — calls **Gemini 2.5 Flash Image** with the uploaded photo and a prompt to remove logos; returns the edited image as base64.
  CORS headers configured so the GitHub Pages site can call it cross-origin. I created the Gemini key in Google AI Studio, made a Cloudflare account, pasted the Worker code into Cloudflare's browser editor, and stored the key as the Worker secret `GEMINI_API_KEY`.
- **What it did (design):** Replaced the click-the-card grid with a real text-input search field ("Name the product…") alongside an upload zone. Added a genuine "Analysing global pricing…" loading state with an animated ellipsis. Source URLs from Gemini's grounding metadata shown beneath the verdict, so users can verify where the price data came from.
- **What worked:** The site now looks up *any* product, live. The key stays server-side, not in the page source. Source citations build trust with the user.
- **What didn't work:** Gemini's price data isn't always accurate — sometimes guessed or stale. Image URLs Gemini returns sometimes 404 or aren't direct image links (had to add an image-proxy endpoint to handle hot-link-protected URLs). The round-trip was 20–30 seconds when run sequentially.
- **What I changed next:** Latency killed the user experience — had to parallelise.

---

## Iteration 5 — Combined parallel flow (the final UX)

- **Goal:** One single action that does both AI logo removal AND live price lookup.
- **My prompt:**
  > "Right now the customer has to do two different procedures. I want removing the logo and searching the price + exchange rate to happen at the same time. User uploads the image AND types the product name, then the AI does both."
- **What it did (code):** Restructured Section 02 to take **both** an image upload (A) and a product name (B). The single Analyze button fires the Worker's `/?q=` (price lookup) and `/debrand` (logo removal on the user's uploaded image) **in parallel** via `Promise.all`, so total wait = `max(priceCall, imageCall)` instead of the sum. The uploaded image is downsampled with the HTML Canvas API (max 1024px on the long edge, JPEG quality 0.85) before being sent to Gemini, to stay under the request-size limit. Graceful fallback: if the `/debrand` call fails or returns nothing, the original image is shown with a soft CSS blur so the de-brand moment still works.
- **What it did (design):** One single action instead of two separate flows. The reveal stage shows **"your photo (original) → your photo (logo erased)" side-by-side**, with the country price chart and Gemini sources underneath. Feels like one cohesive moment, not two separate ones. Loading state reads "Looking up global prices & AI-erasing the logo…" so the user knows both things are happening at once.
- **What worked:** Perceived latency roughly halved. UX is much cleaner; the demo lands in one beat. The "before/after" side-by-side reveal is the strongest visual moment in the whole flow.
- **What didn't work:** Still 15–20 seconds total — Gemini Image is the bottleneck. If one of the two calls fails, the other doesn't gracefully fall back at the *content* level (the page just shows whichever did succeed). If the user's typed product doesn't match their uploaded photo, the site happily shows mismatched data — no consistency check between text and image yet.
- **What I changed next:** Shipped — this is the live UX at https://kyle1-2-3.github.io/Ap-macro/. Open thread: add a "did the photo and the name look like the same product?" sanity check using a third Gemini Vision call.

---

## "Steered the AI to do something it couldn't do on the first try"

The clearest moment was **Iteration 4.** My instinct was "give the AI the key, problem solved." Claude *refused* and explained the security flaw — that any key in a public GitHub Pages page is visible via View Source, can be scraped within hours of going live, and would let a stranger run up charges on my Google account. He steered me toward the correct architecture (a free Cloudflare Worker holding the secret server-side). I had to create two new accounts, paste real code into Cloudflare's web editor, and stand up a Worker myself — but the result was a system where the live site can hit Gemini safely. Without that pushback I'd have shipped a site with an exposed API key.

That iteration also taught me the most: architecture decisions matter more than code. Putting the two API calls in parallel in Iteration 5 cut perceived latency by ~50% without changing a single line of what the AI actually returned.
