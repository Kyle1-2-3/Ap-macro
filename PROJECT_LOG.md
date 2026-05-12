# Project Log — Independent Project 2026 (Vibe Coding)

**Owner:** bridge11korea@gmail.com (GitHub: Kyle1-2-3)
**Class:** AP Macroeconomics
**Share with:** Ms. Napier
**Process:** Double Diamond — Discover → Define → Develop → Deliver

> Update this at the end of EVERY class. It feeds your Executive Summary and final presentation. Ms. Napier checks in on it.
> Parts below were drafted with AI help — rewrite them in your own words so they sound like you.

---

## Phase 1 — DISCOVER (Class 1)
**Rule: problem first, not solution first.**

### Ideas I considered
1. **"Allowance vs. Inflation" tracker** — enter your allowance + when you started getting it; the app shows how much purchasing power it's lost. Macro: inflation, CPI, purchasing power. → *Too small / low wow factor.*
2. **"Build-a-Recession" simulator** — sliders for interest rates, government spending, taxes; an AD/AS graph moves in real time. Macro: fiscal & monetary policy, AS/AD. → *Cool, but the AS/AD graphing is risky to get accurate in 6 classes.*
3. **"Should this country raise rates?" central-banker game** — pick a fake country's stats; the app recommends a rate decision. Macro: the Fed, Phillips curve, trade-offs. → *Good, but felt less personal.*
4. **★ CHOSEN: "Should You Buy It Here?" — global price of branded goods** — started from my own frustration with how much designer/brand stuff costs. The first version was "show the real production cost (原価)," but I pivoted because (a) just exposing the markup felt too negative, and (b) the cross-country angle is much more clearly *macro*. Now: pick a branded product → see its logo blurred and decide if you'd still buy it → see which country sells it cheapest, converted to your currency → learn the macro reasons (exchange rates, taxes/tariffs, PPP, shopping tourism).

### Why I chose idea #4 over the others
_(Rewrite in your own words — graded.)_ It has the most "wow" for a Demo Day (instant reaction: "a 30% price difference for the same bag?!"), it's something I genuinely care about, it's buildable in the time I have (no live data feed needed — researched numbers in a list), and it carries real AP Macro content (open-economy unit: exchange rates, net exports, trade barriers, PPP) instead of just micro pricing.

---

## Phase 2 — DEFINE (by May 11)
### My proposal (to submit to Ms. Napier)
- **Project name:** Should You Buy It Here? — The Global Price of Brands
- **One-sentence pitch:** A web app where you pick a famous branded product, decide whether you'd still want it with the logo hidden, then see which country in the world sells it cheapest (in your own currency) — and learn the macroeconomics behind why the price changes at every border.
- **The problem / user pain point:** People (me included) pay huge "brand premiums" without thinking about it, and most don't realize the *exact same product* can cost 20–40% more or less depending on which country they buy it in — because of exchange rates, VAT/sales tax, and import duties. Travelers and online shoppers are basically leaving money on the table, and "shopping abroad" is rarely connected to actual macroeconomic forces.
- **Target user:** Teens / young adults who follow fashion, sneakers, tech, or luxury, and anyone who travels and wonders "should I just buy this overseas?"
- **Core macro economics in it:** exchange rates (appreciation/depreciation, foreign exchange market); purchasing power parity / law of one price ("Big Mac Index" logic); tariffs, import duties, VAT and tax-free shopping for tourists; net exports & the trade balance ("shopping tourism" as an export); GDP.
- **What "done" looks like by May 29:** a live website (GitHub Pages link) with ~15+ researched products, real exchange rates, the de-brand interaction, the country price ranking + chart + table, and the macro explainers; a 5-min Demo Day presentation; a one-page Executive Summary; a Prompt Log with 3–5 iterations; a user-flow diagram.
- **Tool I'll use to build it:** Directing an AI assistant (Claude) to write the HTML/CSS/JavaScript; hosting on GitHub Pages (free). Learning stack: AI explanations + GitHub Pages docs + YouTube as needed.
- **Confirmed no peer duplicate:** ❓ check with Ms. Napier.

> ⚠️ As of 2026-05-11 this proposal is drafted but NOT yet sent to Ms. Napier. Send it ASAP (copy into a Google Doc, share with her, note it's slightly late).

---

## Phase 3 — DEVELOP (May 11–26)

### Class log
**2026-05-11 (Class 1 / proposal day) —**
- Set up the project folder (`~/Documents/ap-macro-site`) and the log files.
- Generated several ideas, weighed feasibility vs. impact, chose the "Should You Buy It Here?" brand-price idea (originally the "原価 / real cost" idea, pivoted to the cross-country exchange-rate angle to make it properly macro).
- Built version 1 of the website (`index.html`) with AI: locale picker, products, the logo-blur "would you still buy it?" interaction, country price comparison chart + table + verdict, 原価 note, 4 macro explainer cards.

**2026-05-11 (evening, same day) —**
- Redesigned for a refined "editorial-luxury" look (Playfair Display headlines + Inter body), removed all emoji, switched from clickable cards to a search box, expanded the database to 15 products.
- Added the "de-brand the photo" feature: product photos blur ONLY the logo region (a `logoBox` per item) so the product stays visible; photos without a visible logo show clean.
- Got product photos: uploaded the 3 luxury bags (LV, Chanel, Gucci) myself; scraped iPhone / MacBook Air / AirPods Pro / PS5 from Wikipedia. 7 products still need a photo.
- **Put it on GitHub and made it live:** repo at github.com/Kyle1-2-3/Ap-macro; live at https://kyle1-2-3.github.io/Ap-macro/ via GitHub Pages. Set up the GitHub CLI so future updates push automatically.
- **Next class:** send the proposal to Ms. Napier; research real prices to replace the placeholder data; add the remaining 7 product photos. (Full checklist in WHERE_I_LEFT_OFF.md.)

**[next date] —**

**[next date] —**

---

## Phase 4 — DELIVER (May 27 – June 4)

### Deliverable checklist
- [x] Project Log kept updated (this file)
- [x] Live app link working: https://kyle1-2-3.github.io/Ap-macro/
- [ ] Prompt Log with 3–5 iterations (see PROMPT_LOG.md) — start filling this in
- [ ] User Flow diagram made (there's a text version at the bottom of the site to base it on)
- [ ] 5-minute presentation slides — "Demo Day" style
- [ ] One-page Executive Summary (Why / How / What)
- [ ] Replace placeholder prices/exchange rates with researched figures
- [ ] Practiced the live demo so it doesn't break on stage

### Executive Summary draft notes
- **The "Why"** (how I found the problem, why I picked this idea): started from my own annoyance at brand markups; refined it (via the design process) from "show the real cost" to "show where in the world it's cheapest," which ties to the open-economy macro unit.
- **The "How"** (which tool, my learning stack): directed an AI assistant to write the code (HTML/CSS/JavaScript); hosted free on GitHub Pages; learning stack = AI explanations + GitHub Pages documentation + YouTube.
- **The "What"** (link + results + the prompt iterations): the live link above + the working app + the 3–5 prompt iterations from PROMPT_LOG.md + the user-flow diagram + the visuals (the price-comparison chart counts; consider adding a real exchange-rate or "luxury price vs. CPI" graph too).
