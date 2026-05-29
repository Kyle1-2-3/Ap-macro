# URL-Based International Price Comparison

**Date:** 2026-05-29
**Status:** Approved

## Summary

Replace the current photo-upload + product-name-input flow with a single URL input. Users paste a product URL from an official brand website; the system scrapes name, image, and price via Firecrawl, then automatically finds the same product on the brand's other country sites to compare prices across 8 markets.

## Current State

- User uploads a product photo + types product name
- Worker calls Gemini (with Google Search grounding) to look up global prices
- Worker calls Gemini to AI-remove logos from the uploaded photo
- Curated products bypass AI with hardcoded prices
- Frontend supports EN/JA i18n

## New Flow

```
User: pastes official brand URL (e.g. prada.com/kr/ko/product/xxx)
  |
Frontend: validates URL against official-site rules
  |
Worker POST /scrape:
  1. Firecrawl scrapes input URL -> product name, image, price, currency
  2. Detect brand domain + product path from URL
  3. Generate 8-country URLs (mapping table + AI fallback)
  4. Parallel Firecrawl scrape all 8 country URLs
  5. For each country: extract price or mark "unavailable"
  |
Worker POST /debrand: (existing, unchanged)
  Uses scraped product image for AI logo removal
  |
Frontend: displays results
  - Debranded image -> "Would you still buy it without the logo?"
  - Price table: found countries show price, missing show message
  - Bar chart (priced countries only)
  - Verdict + macro insight
```

## Official Site Validation (Hybrid)

Three-layer check, evaluated in order:

### 1. Whitelist (instant accept)
Known official brand domains:
```
prada.com, louisvuitton.com, gucci.com, chanel.com, hermes.com,
dior.com, balenciaga.com, bottegaveneta.com, ysl.com (saintlaurent.com),
burberry.com, fendi.com, loewe.com, celine.com, moncler.com,
cartier.com, tiffany.com, rolex.com, omega.com, tagheuer.com,
iwc.com, nike.com, adidas.com, newbalance.com
```

### 2. Blacklist (instant reject)
Known multi-brand retailers:
```
farfetch.com, ssense.com, net-a-porter.com, mytheresa.com,
matchesfashion.com, nordstrom.com, saksfifthavenue.com,
bloomingdales.com, selfridges.com, harrods.com, amazon.com,
ebay.com, stockx.com, grailed.com, vestiairecollective.com
```

### 3. Heuristic fallback
If domain is in neither list: reject with message suggesting the user find the product on the brand's official site.

Rejection message (EN): "Please use an official brand website (e.g. prada.com, louisvuitton.com). Third-party retailers like [domain] are not supported."

Rejection message (JA): "公式ブランドサイトのURLを使用してください（例：prada.com、louisvuitton.com）。[domain] などのセレクトショップには対応していません。"

## Country URL Generation (Hybrid)

### Mapping Table
Hardcoded patterns for major brands. The product path segment is extracted from the input URL and inserted into each country template.

Example for Prada:
```
Input:  prada.com/kr/ko/women/bags/shoulder-bags/product.1BH204.html
Extract: women/bags/shoulder-bags/product.1BH204.html

US:  prada.com/us/en/{path}
CA:  prada.com/ca/en/{path}
FR:  prada.com/fr/fr/{path}
IT:  prada.com/it/it/{path}
GB:  prada.com/gb/en/{path}
CH:  prada.com/ch/en/{path}
JP:  prada.com/jp/ja/{path}
KR:  prada.com/kr/ko/{path}
```

Each brand has its own pattern. The mapping table stores:
```js
{
  "prada.com": {
    pathRegex: /^\/[a-z]{2}\/[a-z]{2}\/(.+)$/,
    countries: {
      "United States": "/us/en/{path}",
      "Canada": "/ca/en/{path}",
      "France": "/fr/fr/{path}",
      "Italy": "/it/it/{path}",
      "United Kingdom": "/gb/en/{path}",
      "Switzerland": "/ch/en/{path}",
      "Japan": "/jp/ja/{path}",
      "South Korea": "/kr/ko/{path}"
    }
  }
}
```

### AI Fallback
For brands not in the mapping table, send the input URL to Gemini and ask it to generate the 8 country variant URLs. Gemini has knowledge of brand site structures and can infer patterns.

## Data Extraction

After Firecrawl returns page markdown for each country URL, use Gemini to extract structured data:

```json
{
  "product_name": "Printed leather card holder with shoulder strap",
  "brand": "PRADA",
  "price": 2150,
  "currency": "CAD",
  "image_url": "https://www.prada.com/.../product.jpg",
  "origin_country": "Italy",
  "category": "card holder"
}
```

The initial scrape (user's URL) extracts all fields. Subsequent country scrapes only need price + currency (other fields reuse the initial scrape).

## "Unable to Compare" Handling

When a country's official site doesn't have the product (404, redirect to homepage, or no price found), the table row shows:

```
CA  Canada  |  Not available on prada.com/ca  |
```

- Row is included in the table but excluded from the bar chart
- Price columns show the unavailable message instead of a number
- Row is visually muted (lighter text color)

## Features Removed

- Photo upload UI (upload zone, preview, reset button)
- Product name text input
- Curated products mode (`CURATED` array, `matchCurated()`)
- Gemini direct price lookup (`buildPrompt` for price search)
- Example product chips ("Try one of these")

## Features Retained

- AI debranding (using scraped product image)
- "Would you still buy it without the logo?" flow
- Bar chart + table + verdict
- ECB live exchange rate conversion
- EN/JA i18n
- Macro insight (generated from price comparison data)

## Worker Changes

### New endpoint: `POST /scrape`
Request:
```json
{
  "url": "https://www.prada.com/kr/ko/women/bags/.../product.html",
  "homeCurrency": "CAD"
}
```

Response:
```json
{
  "found": true,
  "product": {
    "name": "Printed leather card holder",
    "brand": "PRADA",
    "origin": "Italy",
    "category": "card holder",
    "image_url": "https://...",
    "blurb": "..."
  },
  "prices": {
    "South Korea": { "price": 2050000, "currency": "KRW", "url": "https://prada.com/kr/..." },
    "United States": { "price": 1550, "currency": "USD", "url": "https://prada.com/us/..." },
    "Canada": { "available": false, "reason": "Product not listed on prada.com/ca" }
  },
  "home_prices": { ... },
  "home_currency": "CAD",
  "fx_date": "2026-05-29",
  "macro_insight": "..."
}
```

### Modified: `POST /debrand`
Unchanged — receives base64 image, returns debranded image.

### Removed endpoints
- `GET /?q=<product name>` — replaced by `/scrape`

### New secret
- `FIRECRAWL_API_KEY` — added as Cloudflare Worker secret

## Frontend Changes

### Input UI
Replace upload zone + text input with a single URL input field:
```
[Paste a product URL from any official brand website]  [Compare Prices]
```

Placeholder: "e.g. https://www.prada.com/us/en/women/bags/..."

### Validation
Client-side pre-check before calling Worker:
- Must be a valid URL (starts with https://)
- Domain checked against whitelist/blacklist
- Instant error message if rejected

### Results Table
- Rows with prices: normal display
- Rows without prices: muted row, message in price column like "Not available on prada.com/ca"
- Bar chart only includes countries with prices

## i18n Additions

New strings needed for EN and JA:
- URL input placeholder
- Validation error messages (not official site, invalid URL)
- "Not available on [brand] [country]" template
- Loading messages for scraping flow
