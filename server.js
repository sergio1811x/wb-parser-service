const express = require('express');

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'cardzip-wb-2024';

// ─── Текстовый поиск через WB API ──────────────────────────────────────────

app.get('/search-by-text', async (req, res) => {
  const { query, secret, limit } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const encoded = encodeURIComponent(String(query));
    const maxResults = Math.min(parseInt(limit) || 100, 100);
    const url = `https://search.wb.ru/exactmatch/ru/common/v7/search?appType=1&curr=rub&dest=-1257786&query=${encoded}&resultset=catalog&sort=popular&spp=30`;

    console.log(`[search] "${String(query).slice(0, 40)}"`);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      console.warn(`[search] WB API HTTP ${response.status}`);
      return res.json({ success: false, error: `WB API ${response.status}`, products: [] });
    }

    const data = await response.json();
    const products = (data?.products ?? []).slice(0, maxResults);

    const slim = products.map(p => ({
      id: p.id,
      name: p.name || '',
      brand: p.brand || '',
      price: p.sizes?.[0]?.price?.product ? Math.round(p.sizes[0].price.product / 100) : 0,
      rating: p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
    })).filter(p => p.price > 0);

    console.log(`[search] ${slim.length} products`);
    res.json({ success: slim.length > 0, total: products.length, count: slim.length, products: slim });
  } catch (e) {
    console.error('[search] Error:', e.message);
    res.json({ success: false, error: e.message, products: [] });
  }
});

// ─── Health ─────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', mode: 'text-only', uptime: process.uptime() });
});

app.listen(PORT, () => console.log(`WB Parser (text-only) running on port ${PORT}`));
