const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

chromium.use(stealth);

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'cardzip-wb-2024';

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
      ],
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
    });

    const page = await context.newPage();

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

    // Заходим сразу на поиск, ждём загрузки
    const searchUrl = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(query)}`;
    console.log(`[wb] Searching: ${query}`);

    await page.goto(searchUrl, { waitUntil: 'load', timeout: 45000 });

    // Ждём пока страница стабилизируется (возможны редиректы)
    await page.waitForTimeout(5000);

    // Если нас редиректнули на главную — ищем через поисковую строку
    const currentUrl = page.url();
    console.log(`[wb] Current URL: ${currentUrl}`);

    if (!currentUrl.includes('search')) {
      console.log('[wb] Redirected, using search bar...');
      try {
        // Ищем поле поиска и вводим запрос
        const searchInput = await page.waitForSelector('#searchInput, input[name="search"], .search-catalog__input', { timeout: 5000 });
        await searchInput.click();
        await searchInput.fill(query);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000);
        console.log(`[wb] After search: ${page.url()}`);
      } catch (e) {
        console.log(`[wb] Search bar not found: ${e.message}`);
      }
    }

    // Ждём карточки
    try {
      await page.waitForSelector('.product-card, [data-nm-id], .j-card-item', { timeout: 15000 });
      console.log('[wb] Cards found!');
    } catch {
      console.log('[wb] No cards found');
    }

    await page.waitForTimeout(2000);

    const title = await page.title();
    console.log(`[wb] Title: "${title}"`);

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
          console.log(`[wb] API: ${prods.length} products, total: ${total}`);
          break;
        }
      } catch {}
    }

    // DOM fallback
    if (!products.length) {
      const domProducts = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('[data-nm-id], .product-card, .j-card-item').forEach((card) => {
          const id = card.getAttribute('data-nm-id') || card.querySelector('[data-nm-id]')?.getAttribute('data-nm-id');
          const nameEl = card.querySelector('[class*="goods-name"], [class*="Name"]');
          const priceEl = card.querySelector('ins, [class*="lower-price"], [class*="price-now"]');
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

    res.json({ success: products.length > 0, total, count: slim.length, products: slim });

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
