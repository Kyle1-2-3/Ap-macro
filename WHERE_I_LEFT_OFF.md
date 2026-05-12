# Where I left off — AP Macro VC project

_Last updated: 2026-05-11 (evening)_

## TL;DR
The website is built, on GitHub, and **live on the internet**. Core thing left: replace the placeholder prices with researched ones, add the remaining product photos, and do the presentation + executive summary.

## Live + repo
- **Live site:** https://kyle1-2-3.github.io/Ap-macro/  (updates automatically ~30–60s after any push)
- **Repo:** https://github.com/Kyle1-2-3/Ap-macro
- Local copy: `~/Documents/ap-macro-site/` — the whole thing is git-connected now; `gh` is logged in (account Kyle1-2-3), so Claude can push updates on request.

## What the site is now
"Should You Buy It Here? — The Global Price of Brands." Flow: pick your shopping country → search a product → see it de-branded (logo blurred on the photo) and decide if you'd still buy it → see the country-by-country price ranking + chart + table + a macro "verdict" + a 原価 note → read 4 macro explainer cards (exchange rates, PPP/Big Mac index, tariffs & VAT, shopping-tourism-as-exports). Fonts: Playfair Display + Inter. 15 products in the database.

## Photos status (in `images/`)
- ✅ Have real photos: louis vuitton (lv-neverfull), chanel (chanel-flap), gucci (gucci-marmont) — uploaded by me, with logo-only blur boxes. Plus iphone-16-pro, macbook-air, airpods-pro, ps5 — scraped from Wikipedia, shown clean (no visible logo to censor).
- ⬜ Still need a photo (upload into `images/` with the exact filename): rolex-sub.jpg, af1.jpg, lego-falcon.jpg, dyson-airwrap.jpg, moncler-maya.jpg, cartier-love.jpg, burberry-trench.jpg. (Wikimedia doesn't have these; grab from brand sites / Google Images.) After uploading, ask Claude to add a precise `logoBox` for each.
- The iphone photo is just a black-screen front view — fine, but swap it for something nicer if you want.

## ⬜ TODO (rough priority)
1. **Send the proposal to Ms. Napier** if not done — text is in PROJECT_LOG.md ("Phase 2 — DEFINE"). It was due May 11; send it ASAP and note it's a little late.
2. **Replace the placeholder prices & exchange rates** with researched figures. Data lives in a clearly-commented list near the bottom of `index.html` (search "EDIT YOUR DATA HERE"). Sources: brand websites in each region, articles on "cheapest country to buy X", central-bank exchange rates. Claude can web-research specific items and update the data on request.
3. **Add the remaining 7 product photos** (see above).
4. **Keep logging prompts** in PROMPT_LOG.md — every time you direct the AI to build/fix/change something. Rubric wants 3–5 documented iterations.
5. **Update PROJECT_LOG.md** at the end of each class (Ms. Napier checks it).
6. **Make a user-flow diagram** (there's a text version at the bottom of the site to base it on).
7. **Build the 5-min Demo Day presentation + the one-page Executive Summary** (Why / How / What — see PROJECT_LOG.md draft notes).
8. Practice the live demo so nothing breaks on stage.

## Key files
- `index.html` — the website (the data list near the bottom is the main thing you'll edit)
- `images/` — product photos (+ `README.txt` listing the filenames the site looks for)
- `PROJECT_LOG.md` — daily log + the proposal text (share with Ms. Napier)
- `PROMPT_LOG.md` — log of AI prompts/iterations (for the Executive Summary)
- `WHERE_I_LEFT_OFF.md` — this file
- `CLAUDE.md` — notes for the AI assistant
- `style.css`, `script.js` — unused leftovers from the very first version; safe to ignore/delete
