const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'cardzip-wb-2024';

// ─── Chrome-like профили ────────────────────────────────────────────────────

const CHROME_VERSIONS = [
  '136.0.7103.92', '136.0.7103.113', '135.0.7049.84',
  '134.0.6998.166', '133.0.6943.127',
];

const PLATFORMS = [
  { platform: '"Windows"', ua: 'Windows NT 10.0; Win64; x64' },
  { platform: '"Windows"', ua: 'Windows NT 11.0; Win64; x64' },
  { platform: '"macOS"', ua: 'Macintosh; Intel Mac OS X 10_15_7' },
];

function createSession() {
  const chrome = CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)];
  const majorVer = chrome.split('.')[0];
  const plat = PLATFORMS[Math.floor(Math.random() * PLATFORMS.length)];

  return {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'cache-control': 'no-cache',
      'pragma': 'no-cache',
      'sec-ch-ua': `"Chromium";v="${majorVer}", "Google Chrome";v="${majorVer}", "Not-A.Brand";v="8"`,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': plat.platform,
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
      'origin': 'https://www.wildberries.ru',
      'referer': 'https://www.wildberries.ru/',
      'user-agent': `Mozilla/5.0 (${plat.ua}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`,
    },
    createdAt: Date.now(),
  };
}

// ─── Throttle ───────────────────────────────────────────────────────────────

let lastRequestTime = 0;

function randomThrottle() {
  return 700 + Math.floor(Math.random() * 800);
}

async function throttle() {
  const now = Date.now();
  const delay = randomThrottle();
  const wait = Math.max(0, delay - (now - lastRequestTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();
}

// ─── WB Fetch ───────────────────────────────────────────────────────────────

async function fetchWb(query, maxResults, session) {
  const encoded = encodeURIComponent(query);
  const url = `https://search.wb.ru/exactmatch/ru/common/v7/search?appType=1&curr=rub&dest=-1257786&query=${encoded}&resultset=catalog&sort=popular&spp=30`;

  const fetchOpts = {
    headers: session.headers,
    signal: AbortSignal.timeout(10000),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    try {
      const response = await fetch(url, fetchOpts);

      if (response.status === 429) {
        const base = (attempt + 1) * 2500;
        const jitter = Math.floor(Math.random() * 2000);
        const delay = base + jitter;
        console.warn(`[search] 429 rate limit, retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!response.ok) {
        console.warn(`[search] WB API HTTP ${response.status}`);
        return [];
      }

      const data = await response.json();
      return (data?.products ?? []).slice(0, maxResults);
    } catch (e) {
      console.warn(`[search] Attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
    }
  }
  return [];
}

// ─── Slim products ──────────────────────────────────────────────────────────

function slimProducts(products, source = 'text', query = '') {
  return products.map((p, index) => ({
    id: p.id,
    nmId: p.id,
    name: p.name || '',
    title: p.name || '',
    brand: p.brand || '',
    price: p.sizes?.[0]?.price?.product ? Math.round(p.sizes[0].price.product / 100) : 0,
    rating: p.reviewRating || 0,
    feedbacks: p.feedbacks || 0,
    wh: p.wh || null,
    time1: p.time1 || null,
    time2: p.time2 || null,
    dist: p.dist || null,
    kindId: p.kindId || null,
    subjectId: p.subjectId || null,
    subjectName: p.subjectName || '',
    seller: p.seller?.name || '',
    supplierId: p.supplierId || null,
    marketType: 'local_wb_market',
    source,
    query,
    queryType: source,
    photoRank: index + 1,
  })).filter(p => p.price > 0 && p.name);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/search-by-text', async (req, res) => {
  const { query, secret, limit } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const maxResults = Math.min(parseInt(limit) || 100, 100);
    const session = createSession();
    console.log(`[search] "${String(query).slice(0, 40)}"`);

    const products = await fetchWb(String(query), maxResults, session);
    const slim = slimProducts(products, 'text', String(query));

    console.log(`[search] ${slim.length} products`);
    res.json({ success: slim.length > 0, total: products.length, count: slim.length, products: slim });
  } catch (e) {
    console.error('[search] Error:', e.message);
    res.json({ success: false, error: e.message, products: [] });
  }
});

app.post('/search-batch', express.json(), async (req, res) => {
  const { queries, secret, limit } = req.body ?? {};
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!queries?.length) return res.status(400).json({ error: 'queries required' });

  const maxResults = Math.min(parseInt(limit) || 100, 100);
  const session = createSession();
  const results = [];

  for (const query of queries.slice(0, 15)) {
    const products = await fetchWb(String(query), maxResults, session);
    const slim = slimProducts(products, 'text', String(query));
    results.push({ query, count: slim.length, products: slim });
  }

  res.json({ success: true, results });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mode: 'text-only direct',
    throttle: '700-1500ms',
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  console.log(`WB Parser (text-only, direct) running on port ${PORT}`);
  console.log(`Throttle: 700-1500ms (random)`);
});
