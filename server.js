const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'cardzip-wb-2024';

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

app.get('/search', async (req, res) => {
  const { query, secret, limit = '50' } = req.query;

  if (secret !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!query) {
    return res.status(400).json({ error: 'query param required' });
  }

  let context = null;
  let page = null;

  try {
    const br = await getBrowser();
    context = await br.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      locale: 'ru-RU',
      viewport: { width: 1920, height: 1080 },
    });
    page = await context.newPage();

    // Перехватываем API-ответ WB
    let wbData = null;
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('search.wb.ru') && url.includes('search')) {
        try {
          const text = await response.text();
          wbData = JSON.parse(text);
        } catch {}
      }
    });

    // Открываем поиск WB
    const searchUrl = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Ждём чтобы API-ответ точно пришёл
    if (!wbData) {
      await page.waitForTimeout(3000);
    }

    await context.close();
    context = null;

    if (!wbData || !wbData.data?.products?.length) {
      return res.json({
        success: false,
        total: 0,
        count: 0,
        products: [],
      });
    }

    const products = wbData.data.products.slice(0, parseInt(limit));
    const total = wbData.data.total ?? products.length;

    const slim = products.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      price: p.salePriceU ? Math.round(p.salePriceU / 100) : null,
      rating: p.reviewRating,
      feedbacks: p.feedbacks,
    }));

    res.json({
      success: true,
      total,
      count: slim.length,
      products: slim,
    });

  } catch (e) {
    console.error('[wb-parser] Error:', e.message);
    if (context) await context.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => {
  console.log(`WB Parser running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
