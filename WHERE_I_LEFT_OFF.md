# Where I left off — AP Macro VC project

_Last updated: 2026-05-16_

## TL;DR
Website is built, live, and fully functional with a **live AI-powered flow**: user uploads a product photo + types the name → Cloudflare Worker calls Gemini to look up global prices AND AI-removes the logo → shows country price ranking. No more curated database or local images.

## Live + repo
- **Live site:** https://kyle1-2-3.github.io/Ap-macro/
- **Repo:** https://github.com/Kyle1-2-3/Ap-macro
- **Worker (deployed):** https://ap-macro-lookup.bridge11korea.workers.dev

## How the site works now
1. User picks "shopping from" country (sets display currency)
2. Uploads a photo of any branded product + types the product name
3. Worker fires two parallel requests:
   - `/` endpoint → Gemini (with Google Search grounding) returns brand/origin/category/blurb/per-country prices/sources
   - `/debrand` endpoint → AI removes the logo from the uploaded photo
4. De-branded image shown: "Without the logo — would you still buy it?"
5. After answering → country price ranking (bar chart + table + verdict + macro explanation)
6. Four macro explainer cards: exchange rates, PPP/law of one price, taxes & tariffs, shopping tourism

## Key files
- `index.html` — the entire frontend (HTML + inline CSS + inline JS)
- `worker/worker.js` — Cloudflare Worker backend (Gemini API + image debranding)
- `worker/wrangler.toml` — Worker config
- `worker/DEPLOY.md` — deploy instructions
- `PROJECT_LOG.md` — daily log + proposal text (share with Ms. Napier)
- `PROMPT_LOG.md` — AI prompt/iteration log (for Executive Summary)
- `CLAUDE.md` — notes for the AI assistant
- `DevLog` — development log

## TODO (remaining for submission)
1. Replace placeholder/estimated exchange rates with current central-bank rates
2. Fill in PROMPT_LOG.md with 3-5 real iterations (rubric requirement)
3. User-flow diagram (visual, not just text)
4. 5-min presentation slides
5. One-page Executive Summary
6. Send proposal to Ms. Napier if not already done
7. Practice the live demo
