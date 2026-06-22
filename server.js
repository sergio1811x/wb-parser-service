const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Apply stealth to avoid bot detection
chromium.use(stealth);

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

    // Mask webdriver detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });

    // Collect API responses
    const apiResponses = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if ((url.includes('search.wb.ru') || url.includes('catalog.wb.ru')) && response.status() === 200) {
          const text = await response.text();
          if (text.includes('"products"')) {
            apiResponses.push(text);
          }
        }
      } catch {}
    });

    // First visit main page to get cookies
    console.log('[wb] Visiting main page for cookies...');
    await page.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Now search
    const searchUrl = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(query)}`;
    console.log(`[wb] Searching: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 45000 });

    // Wait for cards
    let hasCards = false;
    try {
      await page.waitForSelector('.product-card, [data-nm-id], .j-card-item, .product-card-list', { timeout: 15000 });
      hasCards = true;
      console.log('[wb] Cards found!');
    } catch {
      console.log('[wb] No cards found');
    }

    await page.waitForTimeout(2000);

    const title = await page.title();
    const finalUrl = page.url();
    console.log(`[wb] Title: "${title}" URL: ${finalUrl}`);

    // Parse API responses
    let products = [];
    let total = 0;

    for (const text of apiResponses) {
      try {
        const data = JSON.parse(text);
        const prods = data?.data?.products;
        if (prods?.length) {
          products = prods;
          total = data.data.total ?? prods.length;
          console.log(`[wb] Got ${prods.length} products from API, total: ${total}`);
          break;
        }
      } catch {}
    }

    // DOM fallback
    if (!products.length && hasCards) {
      console.log('[wb] DOM fallback...');
      const domProducts = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('[data-nm-id], .product-card, .j-card-item').forEach((card) => {
          const id = card.getAttribute('data-nm-id') || card.querySelector('[data-nm-id]')?.getAttribute('data-nm-id');
          const nameEl = card.querySelector('[class*="goods-name"], [class*="Name"], .goods-name');
          const priceEl = card.querySelector('ins, [class*="lower-price"], [class*="price-now"], .price__lower');
          const price = parseInt((priceEl?.textContent || '0').replace(/\D/g, ''));
          if (id) items.push({ id: parseInt(id), name: nameEl?.textContent?.trim() || '', price });
        });
        return items;
      });

      if (domProducts.length) {
        console.log(`[wb] DOM: ${domProducts.length} cards`);
        products = domProducts.map((p) => ({ id: p.id, name: p.name, salePriceU: p.price * 100 }));
        total = domProducts.length;
      }
    }

    await context.close();
    context = null;

    const slim = products.slice(0, parseInt(limit)).map((p) => ({
      id: p.id,
      name: p.name || '',
      brand: p.brand || '',
      price: p.salePriceU ? Math.round(p.salePriceU / 100) : (p.price || 0),
      rating: p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
    }));

    res.json({
      success: products.length > 0,
      total,
      count: slim.length,
      products: slim,
      debug: { title, finalUrl, hasCards, apiResponseCount: apiResponses.length },
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

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
