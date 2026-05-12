# Deploying the product-lookup Worker (no terminal needed)

This is the little "backend" that lets the website look up any product live. The
website talks to this Worker; the Worker talks to Gemini (with Google Search);
your Gemini API key stays hidden inside Cloudflare.

## Phase 1 — make two free accounts (do this first)

### A. Gemini API key
1. Go to **https://aistudio.google.com/apikey**
2. Sign in with a Google account.
3. Click **Create API key** (in a new or existing project — either is fine).
4. Copy the key. **Keep it somewhere private — do NOT paste it into the chat.** You'll paste it into Cloudflare in Phase 2.

### B. Cloudflare account
1. Go to **https://dash.cloudflare.com/sign-up** and create a free account (email + password, verify email). No credit card needed for the free Workers tier.

Tell Claude when both accounts exist — then do Phase 2.

## Phase 2 — create the Worker (all in the browser)

1. In the Cloudflare dashboard, left sidebar → **Workers & Pages**.
2. Click **Create application** → **Create Worker**.
3. Name it something like `ap-macro-lookup` → **Deploy** (it deploys a hello-world placeholder).
4. Click **Edit code**. Select ALL the placeholder code and delete it. Open `worker/worker.js` from this project, copy everything, paste it in. Click **Deploy** (top right).
5. Go back to the Worker's page → **Settings** → **Variables and Secrets** (or "Variables").
6. Under **Secrets** (or "Environment Variables", choose the *encrypt*/secret option), click **Add** :
   - Name: `GEMINI_API_KEY`
   - Value: *(paste your Gemini key from Phase 1A)*
   - Make sure it's marked as a **Secret** (encrypted), not a plain text variable.
   - **Save** / **Deploy**.
7. Copy your Worker's URL — it looks like `https://ap-macro-lookup.YOURNAME.workers.dev`. Give that URL to Claude.

## Phase 3 — Claude wires the website to it
Claude edits `index.html` so the search box calls your Worker URL, then pushes to
GitHub. The live site updates within a minute.

## Test it
Open your Worker URL with `?q=` and a product, e.g.:
`https://ap-macro-lookup.YOURNAME.workers.dev/?q=Prada%20Brera%20bag`
You should get a JSON blob with brand, prices, image_url, sources, etc.

## Free-tier limits (plenty for a school project)
- Cloudflare Workers free: 100,000 requests/day.
- Gemini API free tier: generous per-minute/per-day request limits — fine for a demo and testing.

## If something breaks
- Worker returns `{"error":"Server missing GEMINI_API_KEY secret"}` → the secret wasn't saved correctly (re-do Phase 2 step 6, make sure the name is exactly `GEMINI_API_KEY`).
- Worker returns `Gemini API error 400/403` → the API key is wrong/disabled, or the model name in `worker.js` (`MODEL = "gemini-2.5-flash"`) isn't available — check aistudio.google.com for current model names and update that line.
- Worker returns `Gemini did not return parseable data` → Gemini answered in prose instead of JSON; just retry, or tell Claude and we'll tighten the prompt.
