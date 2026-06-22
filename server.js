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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
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

  try {
    const br = await getBrowser();
    context = await br.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      locale: 'ru-RU',
      viewport: { width: 1920, height: 1080 },
      extraHTTPHeaders: {
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    });

    const page = await context.newPage();

    // Собираем все API-ответы от WB
    const apiResponses = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('search.wb.ru') || url.includes('catalog.wb.ru')) {
          const text = await response.text();
          if (text.includes('"products"')) {
            apiResponses.push(text);
          }
        }
      } catch {}
    });

    const searchUrl = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(query)}`;
    console.log(`[wb] Opening: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Ждём появления товаров на странице
    try {
      await page.waitForSelector('[class*="product-card"], [class*="ProductCard"], [data-nm-id]', { timeout: 15000 });
      console.log('[wb] Product cards found on page');
    } catch {
      console.log('[wb] No product cards found, waiting extra...');
      await page.waitForTimeout(5000);
    }

    // Даём время на догрузку API-ответов
    await page.waitForTimeout(2000);

    // Парсим API-ответы
    let products = [];
    let total = 0;

    for (const text of apiResponses) {
      try {
        const data = JSON.parse(text);
        const prods = data?.data?.products;
        if (prods?.length) {
          products = prods;
          total = data.data.total ?? prods.length;
          console.log(`[wb] API response: ${prods.length} products, total: ${total}`);
          break;
        }
      } catch {}
    }

    // Fallback: парсим DOM если API не перехватили
    if (!products.length) {
      console.log('[wb] API interception failed, trying DOM parsing...');
      const domProducts = await page.evaluate(() => {
        const cards = document.querySelectorAll('[data-nm-id]');
        return Array.from(cards).slice(0, 50).map((card) => {
          const id = card.getAttribute('data-nm-id');
          const nameEl = card.querySelector('[class*="goods-name"], [class*="product-card__name"], span[class*="Name"]');
          const priceEl = card.querySelector('[class*="price-now"], [class*="lower-price"], ins');
          const priceText = priceEl?.textContent?.replace(/\D/g, '') || '0';
          return {
            id: parseInt(id) || 0,
            name: nameEl?.textContent?.trim() || '',
            price: parseInt(priceText) || 0,
          };
        }).filter((p) => p.id && p.price > 0);
      });

      if (domProducts.length) {
        console.log(`[wb] DOM parsed: ${domProducts.length} products`);
        products = domProducts.map((p) => ({
          id: p.id,
          name: p.name,
          salePriceU: p.price * 100,
        }));
        total = domProducts.length;
      }
    }

    const currentUrl = page.url();
    console.log(`[wb] Final URL: ${currentUrl}, products: ${products.length}`);

    await context.close();
    context = null;

    if (!products.length) {
      return res.json({ success: false, total: 0, count: 0, products: [] });
    }

    const slim = products.slice(0, parseInt(limit)).map((p) => ({
      id: p.id,
      name: p.name || '',
      brand: p.brand || '',
      price: p.salePriceU ? Math.round(p.salePriceU / 100) : (p.price || 0),
      rating: p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
    }));

    res.json({ success: true, total, count: slim.length, products: slim });

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

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
