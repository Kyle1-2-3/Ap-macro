import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const KEY = readFileSync("/Users/kyle/Ap-macro/worker/.dev.vars", "utf8").split("=")[1].trim();
mkdirSync("/Users/kyle/Ap-macro/test/fixtures", { recursive: true });

async function fc(url, cc, lang, fmt = "html") {
  const r = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ url, formats: [fmt], location: { country: cc, languages: [lang] }, proxy: "stealth", waitFor: 4000, timeout: 40000 }),
  });
  const d = await r.json();
  return { status: r.status, body: d?.data?.[fmt] || d?.data?.html || d?.data?.rawHtml || "" };
}

const jobs = [
  // PDPs (for detectDemandware + Prada regression lock)
  ["rimowa_pdp_gb.html", "https://www.rimowa.com/gb/en/luggage/colour/purple/x/83273171.html", "GB", "en", "html"],
  ["prada_pdp_jp.html", "https://www.prada.com/jp/ja/p/x/P29C26_195X_F0442_S_OOO", "JP", "ja", "html"],
  // Demandware controller responses (for parseDemandware) — these carry the real price
  ["rimowa_ctrl_us.html", "https://www.rimowa.com/on/demandware.store/Sites-Rimowa-Site/en_US/Product-Show?pid=83273171", "US", "en", "rawHtml"],
  ["rimowa_ctrl_kr.html", "https://www.rimowa.com/on/demandware.store/Sites-Rimowa-Site/ko_KR/Product-Show?pid=83273171", "KR", "ko", "rawHtml"],
];

for (const [name, url, cc, lang, fmt] of jobs) {
  try {
    const r = await fc(url, cc, lang, fmt);
    writeFileSync(`/Users/kyle/Ap-macro/test/fixtures/${name}`, r.body);
    // quick signal
    const sales = r.body.match(/"sales"\s*:\s*\{[^}]*"value"\s*:\s*([\d.]+)/i);
    const cur = r.body.match(/"currency[A-Za-z]*"\s*:\s*"([A-Z]{3})"/i);
    const dw = /demandware\.store|demandware\.static/i.test(r.body);
    console.log(`SAVE ${name} status=${r.status} bytes=${r.body.length} dw=${dw} sales=${sales?sales[1]:"-"} cur=${cur?cur[1]:"-"}`);
  } catch (e) {
    console.log(`ERR ${name}: ${String(e).slice(0, 60)}`);
  }
}
