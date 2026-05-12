# Where I left off — AP Macro VC project

_Last updated: 2026-05-11 (end of session)_

## TL;DR
I picked my project, built a working first version of the website on this Mac, and made a GitHub repo — but I have NOT pushed the website to GitHub yet (the GitHub login didn't finish). The site only exists on this computer right now.

---

## ✅ Done so far
- **Project folder:** `~/Documents/ap-macro-site`
- **Idea chosen:** "Should You Buy It Here? — The Global Price of Brands" (see PROJECT_LOG.md for the full proposal)
- **Website v1 built:** `index.html` — a working interactive site. To see it: open Finder → Documents → ap-macro-site → double-click `index.html` (opens in your browser). Has: a "shopping from" country picker, 8 products, the "logo blurred — would you still buy it?" question, a country price-comparison chart + table, the 原価 note, and 4 macro explainer cards (exchange rates, PPP/Big Mac index, tariffs & VAT, shopping-tourism-as-exports).
  - ⚠️ The prices in it are PLACEHOLDER ESTIMATES I made up. There's a red banner saying so. Replacing them with researched numbers is part of the grade.
- **GitHub repo created:** https://github.com/Kyle1-2-3/Ap-macro  (right now it only has a README — the website is not on it yet)
- **Tools installed on this Mac:** `git` (already had it), `gh` (GitHub CLI — installed via Homebrew this session)

## ❌ Not done / what broke
- **GitHub CLI login never completed.** `gh auth status` shows "not logged in." So nothing has been committed or pushed to the repo.
- **GitHub Pages not turned on** → there's no live website link yet.
- **Proposal not sent to Ms. Napier yet.** It was "due May 11." The proposal text is drafted in PROJECT_LOG.md — copy it into a Google Doc, share with her, and apologize for being a bit late. Better late than not at all.

---

## ⬜ TODO when I come back (in order)
1. **Finish the GitHub login.** Open Terminal (⌘+Space → type "Terminal") and run:
   `gh auth login --hostname github.com --git-protocol https --web`
   → copy the one-time code it prints → press Enter → in the browser that opens, paste the code → click the green **Authorize github** button. It should end with "✓ Logged in as Kyle1-2-3".
   (Or just ask Claude to run the login command and give you a code to enter.)
2. **Ask Claude to push the site to GitHub** — Claude will connect this folder to the `Ap-macro` repo, commit `index.html` (+ the log files), and push. The repo already has a README, so Claude needs to merge with it (`git pull origin main --allow-unrelated-histories` first, or fetch + reset).
3. **Turn on GitHub Pages** for the live link: in the repo on github.com → **Settings** → **Pages** (left menu) → Source: "Deploy from a branch" → Branch: **main**, folder **/ (root)** → **Save**. Wait ~1 min → it shows `https://kyle1-2-3.github.io/Ap-macro/`. That's the live app link for the assignment.
4. **Send the proposal** to Ms. Napier (text is in PROJECT_LOG.md, "Phase 2 — DEFINE").
5. **Research real data** to replace the placeholder prices and exchange rates. The data is a clearly-commented list near the bottom of `index.html` (look for "EDIT YOUR DATA HERE"). Sources: brand websites in each region, news articles on luxury pricing / "cheapest country to buy X", central-bank exchange rates. Claude can help you edit it.
6. **Keep logging prompts** in PROMPT_LOG.md every time you direct the AI to build/fix/change something — the rubric wants 3–5 documented iterations.
7. **Update PROJECT_LOG.md** at the end of every class (the Double Diamond daily log Ms. Napier checks).

## Key files in this folder
- `index.html` — the website (open it to preview; edit the data list near the bottom)
- `PROJECT_LOG.md` — the daily log + the proposal text (share with Ms. Napier)
- `PROMPT_LOG.md` — log of AI prompts/iterations (for the Executive Summary)
- `WHERE_I_LEFT_OFF.md` — this file
- `CLAUDE.md` — notes for the AI assistant
- `style.css`, `script.js` — leftover empty scaffolding from the very first version; not used by the current site, safe to ignore or delete later
