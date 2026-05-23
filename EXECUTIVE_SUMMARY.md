# EXECUTIVE SUMMARY — "Should You Buy It Here?"

*AP Macroeconomics · Independent Project 2026 · Mao Tabata · bridge11korea@gmail.com*

**Live site:** https://kyle1-2-3.github.io/Ap-macro/
**Repo:** https://github.com/Kyle1-2-3/Ap-macro

---

## The Why
I started from a personal annoyance: when I buy something with a designer logo, am I paying for the *object* or the *name*? That pulled me into a bigger macro question — even if the object is identical, the price isn't, because exchange rates, VAT and import duties warp the cost across borders. So I picked an idea that lets both questions meet on one screen: a website where you upload a photo of any branded product, an AI strips the logo so you can judge the object on its own merits, and another AI looks up its current price in every major country and shows you where it's actually cheapest. That ties straight into the open-economy unit — **exchange rates, purchasing power parity, tariffs/VAT, and shopping tourism as a form of net exports** — through something I genuinely think about every time I shop.

## The How (Process)
**Stack** — Front-end: HTML / JavaScript / HTML Canvas API. Back-end: a **Cloudflare Worker** (JavaScript) acting as a secure proxy. AI: **Google Gemini 2.5 Flash** (price search with Google grounding) + **Gemini 2.5 Flash Image** (logo removal). Hosting: **GitHub Pages**. Build tool: **Claude Code** (CLI).
**Learning stack** — I learned by directing Claude Code conversationally and asking it to explain anything I didn't get (CORS, why API keys leak from static sites, how Gemini grounding returns sources, how to position a CSS blur in % coordinates). I also used the Cloudflare Workers docs and the Google AI Studio docs to deploy the Worker and create my Gemini key.

## The What — Prompt Log (5 real iterations)

**Iteration 1 — Initial build**
*Prompt:* "Build a site where the user searches a product, AI removes the logo, AI looks up prices in different countries considering exchange rate, then ranks where to buy it cheapest."
*Code:* Single-file `index.html` with embedded CSS/JS. Hardcoded 8-product JS database with per-country local-currency prices. Static `RATES` object for FX conversion to a user-selected home currency. Pure DOM rendering, no framework.
*Design:* Clean "shopping from" locale picker, click-to-pick product cards, a "would you still buy it without the logo?" reveal panel, a horizontal CSS bar chart for the country ranking, and a comparison table with VAT/tourist notes.
*What worked:* Math was right (rates, rankings, "you'd save X%"); the de-brand → reveal → ranking flow read clearly even in v1.
*What didn't:* Only 8 products. "Live AI search" was fake — the database was static.
*Next move:* Realised a static GitHub Pages site can't safely call an AI API → drove Iteration 4 later.

**Iteration 2 — Editorial redesign**
*Prompt:* "I don't like the emojis. Remove them. Make the font and design more 洗練された、高級感あふれる — like a luxury magazine."
*Code:* Loaded **Playfair Display** + **Inter** via Google Fonts. Restyled with CSS custom properties (ivory `#f7f4ee` background, antique-gold `#8a6d33` accent). Replaced every emoji with HTML: flag emoji → country-code badges (`US`, `FR`, `JP`); category emoji → italic serif names.
*Design:* Warm ivory + gold palette, hairline rules between sections, generous whitespace, numbered overlines ("01 — Locale"). Felt like a Vogue / Cereal magazine spread instead of a tech demo.
*What worked:* Visual identity shifted from "student tech demo" to "editorial luxury" in one pass. Country-code badges read cleaner than emoji at small sizes.
*What didn't:* Playfair body weight was a little thin on phones — had to bump size. The first gold accent was over-saturated; toned down to muted antique gold.
*Next move:* Photo blur was way too strong — I couldn't see the product itself.

**Iteration 3 — Logo-only blur**
*Prompt:* "The mosaic is too strong and I can't see the product. Can you only hide the logo?"
*Code:* Added an optional `logoBox: {x, y, w, h}` per product (percentages of the image, top-left origin). CSS `backdrop-filter: blur(16px)` on an absolutely-positioned div sized to the box, sitting on top of an otherwise-sharp `<img>`. Removed the previous global `filter: blur()` on the whole image. Soft fallback blur for products without a `logoBox`.
*Design:* Bag silhouettes now visible; logos cleanly mushed. The reveal moment is more satisfying because only the logo flips from blurred to sharp. LV's monogram covers the whole canvas (~74×48% box); Chanel's CC clasp is a tiny pinpoint (~16×11%); Gucci's GG is medium (~25×19%).
*What worked:* Visibility + concealment at once. Per-product coordinates give precise control.
*What didn't:* Every new product needs me to eyeball four coordinates — doesn't scale. Tech products (iPhone, MacBook) don't have a single censor-able logo, so the concept partially breaks down there.
*Next move:* Wanted to handle ANY product, not just my 8 — needed a real backend.

**Iteration 4 — Cloudflare Worker backend (security & architecture)**
*Prompt:* "I want users to type any product — Prada bracelet, Thom Browne belt, anything — and the site looks it up. Use the Gemini API? I'll give you the key."
*Code:* Claude **refused to take the key in chat** and explained why no API key can live in a public GitHub Pages site. Wrote `worker/worker.js` for a free **Cloudflare Worker** with two endpoints — `GET /?q=<product>` (Gemini 2.5 Flash with Google Search grounding → JSON of brand / origin / per-country prices / image URL / sources) and `POST /debrand` (Gemini 2.5 Flash Image edit → base64 image with the logo removed). CORS headers configured. I created a Gemini key in Google AI Studio and stored it as the Worker secret `GEMINI_API_KEY`.
*Design:* Added a clean text-input search box ("Name the product…") next to the upload zone, plus a real "Analysing…" loading state that streams in actual data.
*What worked:* The site can now look up *any* product live. Sources are displayed so users can verify. The key stays hidden server-side, not in the page source.
*What didn't:* Gemini's price data isn't always accurate — sometimes it guesses or returns stale numbers. Image URLs from Gemini sometimes 404 or aren't direct image links. The round-trip was 20–30s when run sequentially.
*Next move:* Latency killed the UX — needed to parallelise.

**Iteration 5 — Combined parallel flow (the final UX)**
*Prompt:* "Right now the customer has to do two different procedures. I want removing the logo and searching the price + exchange rate to happen at the same time. User uploads the image AND types the product name, then the AI does both."
*Code:* Restructured Section 02 to take **both** an image upload (A) and a product name (B). The single Analyze button fires `/?q=` and `/debrand` **in parallel** via `Promise.all`, so total wait = `max(priceCall, imageCall)` instead of `priceCall + imageCall`. The uploaded image is downsampled with HTML Canvas API before being sent to Gemini, to stay under the request-size limit.
*Design:* One action instead of two. The reveal shows "your photo (original) → your photo (logo erased)" **side-by-side**, with the country price chart underneath. Feels like one cohesive moment, not two separate ones.
*What worked:* Perceived latency roughly halved. UX is much cleaner; the demo lands in one beat.
*What didn't:* Still 15–20 seconds total — Gemini Image is the bottleneck. If one of the two calls fails, the other doesn't gracefully fall back (would need more error handling). If your product name doesn't match the photo, the site happily shows mismatched output — no consistency check.
*Next move:* Shipped — this is what's live at kyle1-2-3.github.io/Ap-macro/.
