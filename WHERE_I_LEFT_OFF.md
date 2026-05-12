# Where I left off — AP Macro VC project

_Last updated: 2026-05-11 (late evening)_

## TL;DR
Website is built, on GitHub, and **live**. Currently mid-decision on whether to add a live "search any product" feature (needs a small free serverless backend) or keep the curated-database approach. A Cloudflare Worker that does the live lookup is already written but not deployed or wired in.

## Live + repo
- **Live site:** https://kyle1-2-3.github.io/Ap-macro/
- **Repo:** https://github.com/Kyle1-2-3/Ap-macro  (3 commits so far)
- Local: `~/Documents/ap-macro-site/` — git-connected; `gh` CLI installed + logged in (account Kyle1-2-3); `git` + Homebrew already on the Mac. Claude can push updates on request → site auto-redeploys in ~1 min.

## The site as it stands
"Should You Buy It Here? — The Global Price of Brands." Flow: pick shopping country → search a product (curated DB, 15 items) → de-brand step (photo blurs only the logo region via per-item `logoBox`; photos with no visible logo show clean) → country price ranking + chart + table + macro "verdict" + 原価 note → 4 macro explainer cards (exchange rates, PPP/Big Mac index, tariffs & VAT, shopping tourism = exports). Fonts: Playfair Display + Inter. Prices are placeholder estimates pending research.

## Photos (`images/`)
- ✅ Have: lv-neverfull, chanel-flap, gucci-marmont (uploaded by user, with logoBoxes) + iphone-16-pro, macbook-air, airpods-pro, ps5 (scraped from Wikipedia, shown clean).
- ⬜ Still need (upload into `images/` with these exact names): rolex-sub.jpg, af1.jpg, lego-falcon.jpg, dyson-airwrap.jpg, moncler-maya.jpg, cartier-love.jpg, burberry-trench.jpg. After uploading, ask Claude for a `logoBox`.
- iphone photo is a plain black-screen front view — swap if desired.

## OPEN DECISION: live product search ("type any product → site fetches it")
We discussed: a static GitHub Pages site can't safely call Google/Gemini (no server → an API key in the page would be public and get stolen). Real solution = a tiny free **Cloudflare Worker** that holds the Gemini key server-side and relays requests; the site calls the Worker.
- **Worker code is already written:** `worker/worker.js` (calls Gemini 2.5 Flash with Google Search grounding, returns brand/origin/category/blurb/per-country prices/image URL/sources). Deploy steps: `worker/DEPLOY.md`.
- **Status: NOT deployed, NOT wired into the site.** Needs the user to (1) get a free Gemini API key at aistudio.google.com/apikey, (2) make a free Cloudflare account, (3) paste the Worker code into Cloudflare's browser editor and add the key as a secret named `GEMINI_API_KEY`, (4) give Claude the Worker URL → Claude wires `index.html` to it and pushes.
- User was hesitant about the Cloudflare step (wanted to skip the "extra account"). The alternative is to drop the live-search idea and stay with the curated database (Claude expands it on request — name new products, Claude researches + adds them). **Pick one before building further.**
- Note even if built: auto-fetched prices/images for arbitrary products will be inconsistent; keep the 15 curated items as reliable demo fallback.

## Other TODO (rough priority)
1. Send the proposal to Ms. Napier (text in PROJECT_LOG.md → "Phase 2 — DEFINE"). Was due May 11.
2. Resolve the live-search decision (above).
3. Replace placeholder prices/exchange rates with researched figures (data list near bottom of `index.html`, "EDIT YOUR DATA HERE"). Claude can web-research specific items.
4. Add the remaining 7 product photos.
5. Keep `PROMPT_LOG.md` updated (rubric wants 3–5 AI iterations documented).
6. Update PROJECT_LOG.md each class.
7. User-flow diagram; 5-min presentation; one-page Executive Summary.

## Key files
- `index.html` — the website (edit the data list near the bottom)
- `worker/worker.js`, `worker/DEPLOY.md` — the optional live-lookup backend (not deployed yet)
- `images/` — product photos (+ `README.txt` with the filenames the site expects)
- `PROJECT_LOG.md` — daily log + proposal text (share with Ms. Napier)
- `PROMPT_LOG.md` — AI prompt/iteration log (for the Executive Summary)
- `WHERE_I_LEFT_OFF.md` — this file
- `CLAUDE.md` — notes for the AI assistant
- `style.css`, `script.js` — unused leftovers; safe to ignore/delete
