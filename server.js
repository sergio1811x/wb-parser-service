const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'cardzip-wb-2024';

// Rate limit: не больше 3 запросов в секунду к WB
let lastRequestTime = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, 350 - (now - lastRequestTime));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();
}

async function fetchWb(query, maxResults) {
  const encoded = encodeURIComponent(query);
  const url = `https://search.wb.ru/exactmatch/ru/common/v7/search?appType=1&curr=rub&dest=-1257786&query=${encoded}&resultset=catalog&sort=popular&spp=30`;

  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (response.status === 429) {
        const delay = (attempt + 1) * 2000;
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
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return [];
}

app.get('/search-by-text', async (req, res) => {
  const { query, secret, limit } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const maxResults = Math.min(parseInt(limit) || 100, 100);
    console.log(`[search] "${String(query).slice(0, 40)}"`);

    const products = await fetchWb(String(query), maxResults);

    const slim = products.map(p => ({
      id: p.id,
      name: p.name || '',
      brand: p.brand || '',
      price: p.sizes?.[0]?.price?.product ? Math.round(p.sizes[0].price.product / 100) : 0,
      rating: p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
      wh: p.wh || null,
      time1: p.time1 || null,
      time2: p.time2 || null,
      dist: p.dist || null,
      kindId: p.kindId || null,
      seller: p.seller?.name || '',
      supplierId: p.supplierId || null,
    })).filter(p => p.price > 0);

    console.log(`[search] ${slim.length} products`);
    res.json({ success: slim.length > 0, total: products.length, count: slim.length, products: slim });
  } catch (e) {
    console.error('[search] Error:', e.message);
    res.json({ success: false, error: e.message, products: [] });
  }
});

// ─── Batch search: несколько запросов с throttling ───────────────────────────

app.post('/search-batch', express.json(), async (req, res) => {
  const { queries, secret, limit } = req.body ?? {};
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!queries?.length) return res.status(400).json({ error: 'queries required' });

  const maxResults = Math.min(parseInt(limit) || 100, 100);
  const results = [];

  for (const query of queries.slice(0, 15)) {
    const products = await fetchWb(String(query), maxResults);
    const slim = products.map(p => ({
      id: p.id,
      name: p.name || '',
      brand: p.brand || '',
      price: p.sizes?.[0]?.price?.product ? Math.round(p.sizes[0].price.product / 100) : 0,
      rating: p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
      wh: p.wh || null,
      time1: p.time1 || null,
      time2: p.time2 || null,
      dist: p.dist || null,
      seller: p.seller?.name || '',
      supplierId: p.supplierId || null,
    })).filter(p => p.price > 0);
    results.push({ query, count: slim.length, products: slim });
  }

  res.json({ success: true, results });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mode: 'text-only', uptime: process.uptime() });
});

app.listen(PORT, () => console.log(`WB Parser (text-only) running on port ${PORT}`));
