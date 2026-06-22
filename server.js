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

    // Собираем все API-ответы
    const apiResponses = [];
    const allUrls = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('.wb.ru')) {
          allUrls.push(url.slice(0, 120));
        }
        if ((url.includes('search.wb.ru') || url.includes('catalog.wb.ru') || url.includes('card.wb.ru')) && response.status() === 200) {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json') || ct.includes('text')) {
            const text = await response.text();
            apiResponses.push({ url: url.slice(0, 150), len: text.length, snippet: text.slice(0, 200) });
            if (text.includes('"products"')) {
              apiResponses.push({ url, full: text });
            }
          }
        }
      } catch {}
    });

    const searchUrl = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(query)}`;
    console.log(`[wb] Opening: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 45000 });

    // Ждём карточки
    let hasCards = false;
    try {
      await page.waitForSelector('.product-card, .product-card-list, [data-nm-id], .j-card-item', { timeout: 10000 });
      hasCards = true;
      console.log('[wb] Cards found');
    } catch {
      console.log('[wb] No cards selector found');
    }

    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const title = await page.title();
    const bodyLen = await page.evaluate(() => document.body.innerText.length);

    console.log(`[wb] Final URL: ${finalUrl}`);
    console.log(`[wb] Title: ${title}`);
    console.log(`[wb] Body text length: ${bodyLen}`);
    console.log(`[wb] WB URLs seen: ${allUrls.length}`);
    console.log(`[wb] API responses: ${apiResponses.length}`);
    apiResponses.forEach((r, i) => {
      if (!r.full) console.log(`[wb] resp[${i}]: ${r.url} len=${r.len} snippet=${r.snippet}`);
    });

    // Парсим API-ответы
    let products = [];
    let total = 0;

    for (const r of apiResponses) {
      if (!r.full) continue;
      try {
        const data = JSON.parse(r.full);
        const prods = data?.data?.products;
        if (prods?.length) {
          products = prods;
          total = data.data.total ?? prods.length;
          console.log(`[wb] Parsed ${prods.length} products from API`);
          break;
        }
      } catch {}
    }

    // Fallback: DOM
    if (!products.length && hasCards) {
      console.log('[wb] Trying DOM fallback...');
      const domProducts = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('[data-nm-id], .product-card, .j-card-item').forEach((card) => {
          const id = card.getAttribute('data-nm-id') || card.querySelector('[data-nm-id]')?.getAttribute('data-nm-id');
          const nameEl = card.querySelector('[class*="goods-name"], [class*="product-card__name"], [class*="Name"], .goods-name');
          const priceEl = card.querySelector('ins, [class*="lower-price"], [class*="price-now"], .price__lower');
          const price = parseInt((priceEl?.textContent || '0').replace(/\D/g, ''));
          if (id) items.push({ id: parseInt(id), name: nameEl?.textContent?.trim() || '', price });
        });
        return items;
      });

      console.log(`[wb] DOM found: ${domProducts.length} cards`);
      if (domProducts.length) {
        products = domProducts.map((p) => ({ id: p.id, name: p.name, salePriceU: p.price * 100 }));
        total = domProducts.length;
      }
    }

    // Последний fallback — скриншот для дебага
    if (!products.length) {
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 50 });
      const b64 = screenshot.toString('base64').slice(0, 500);
      console.log(`[wb] Screenshot b64 (first 500): ${b64}`);
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
      debug: { finalUrl, title, bodyLen, apiResponseCount: apiResponses.length, wbUrlCount: allUrls.length, hasCards },
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
