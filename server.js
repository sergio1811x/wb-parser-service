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

// ─── Поиск по фото ──────────────────────────────────────────────────────────

app.get('/search-by-image', async (req, res) => {
  const { image_url, secret, limit = '50' } = req.query;

  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!image_url) return res.status(400).json({ error: 'image_url param required' });

  let context = null;
  try {
    const br = await getBrowser();
    context = await br.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      locale: 'ru-RU',
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();

    // Скачиваем фото товара
    console.log(`[wb-img] Downloading: ${image_url}`);
    const imgResp = await fetch(String(image_url), { signal: AbortSignal.timeout(15000) });
    if (!imgResp.ok) throw new Error(`Image download failed: ${imgResp.status}`);
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
    console.log(`[wb-img] Image size: ${imgBuffer.length} bytes`);

    // Перехватываем API-ответы
    const apiResponses = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if ((url.includes('search.wb.ru') || url.includes('catalog.wb.ru') || url.includes('similar') || url.includes('imagesearch')) && response.status() === 200) {
          const text = await response.text();
          if (text.includes('"products"') || text.includes('"data"')) {
            apiResponses.push(text);
          }
        }
      } catch {}
    });

    // Открываем WB
    console.log('[wb-img] Opening WB...');
    await page.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Ищем кнопку поиска по фото
    console.log('[wb-img] Looking for image search button...');
    const cameraBtn = await page.waitForSelector(
      'button[class*="search-catalog__btn--photo"], button[aria-label*="фото"], [class*="photo-search"], [class*="camera"], button.search-catalog__btn--photo',
      { timeout: 10000 }
    ).catch(() => null);

    if (!cameraBtn) {
      // Пробуем найти по иконке камеры
      const btns = await page.$$('button');
      let found = null;
      for (const btn of btns) {
        const html = await btn.innerHTML();
        if (html.includes('camera') || html.includes('photo') || html.includes('svg')) {
          const rect = await btn.boundingBox();
          // Кнопка камеры обычно рядом с поиском, справа
          if (rect && rect.x > 500 && rect.width < 60) {
            found = btn;
            break;
          }
        }
      }
      if (!found) {
        console.log('[wb-img] Camera button not found, falling back to text search');
        await context.close();
        return res.json({ success: false, error: 'Camera button not found', fallback: true });
      }
      await found.click();
    } else {
      await cameraBtn.click();
    }

    await page.waitForTimeout(1500);

    // Загружаем фото через file input
    console.log('[wb-img] Uploading image...');
    const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 5000 }).catch(() => null);

    if (!fileInput) {
      console.log('[wb-img] File input not found');
      await context.close();
      return res.json({ success: false, error: 'File input not found', fallback: true });
    }

    // Сохраняем буфер во временный файл и загружаем
    const fs = require('fs');
    const tmpPath = '/tmp/wb_search_img.jpg';
    fs.writeFileSync(tmpPath, imgBuffer);
    await fileInput.setInputFiles(tmpPath);

    console.log('[wb-img] Waiting for results...');

    // Ждём результаты
    try {
      await page.waitForSelector('.product-card, [data-nm-id], .j-card-item', { timeout: 20000 });
      console.log('[wb-img] Cards found!');
    } catch {
      console.log('[wb-img] No cards after image upload');
    }

    await page.waitForTimeout(3000);

    const title = await page.title();
    const currentUrl = page.url();
    console.log(`[wb-img] Title: "${title}" URL: ${currentUrl}`);

    // Парсим API
    let products = [];
    let total = 0;

    for (const text of apiResponses) {
      try {
        const data = JSON.parse(text);
        const prods = data?.data?.products;
        if (prods?.length) {
          products = prods;
          total = data.data.total ?? prods.length;
          console.log(`[wb-img] API: ${prods.length} products`);
          break;
        }
      } catch {}
    }

    // DOM fallback
    if (!products.length) {
      const domProducts = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('.product-card, article, [data-nm-id]').forEach((card) => {
          const link = card.querySelector('a[href*="/catalog/"]');
          const href = link?.getAttribute('href') || '';
          const idMatch = href.match(/\/catalog\/(\d+)/);
          const nmId = card.getAttribute('data-nm-id');
          const id = nmId || (idMatch ? idMatch[1] : null);
          if (!id) return;

          const nameEl = card.querySelector('.product-card__name, .goods-name, [class*="ProductCardBody"] span, p');
          const brandEl = card.querySelector('.product-card__brand, [class*="brand"]');
          const name = nameEl?.textContent?.trim() || '';
          const brand = brandEl?.textContent?.trim() || '';

          const allText = card.textContent || '';
          const priceMatches = allText.match(/\d[\d\s]*₽/g) || [];
          const prices = priceMatches
            .map((p) => parseInt(p.replace(/\s/g, '').replace('₽', '')))
            .filter((p) => p > 10 && p < 1000000);
          const price = prices.length ? Math.min(...prices) : 0;

          items.push({ id: parseInt(id), name: brand ? `${brand} / ${name}` : name, price });
        });
        return items;
      });

      if (domProducts.length) {
        console.log(`[wb-img] DOM: ${domProducts.length} cards`);
        products = domProducts.map((p) => ({ id: p.id, name: p.name, salePriceU: p.price * 100 }));
        total = domProducts.length;
      }
    }

    // Cleanup
    try { fs.unlinkSync(tmpPath); } catch {}
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
    console.error('[wb-img] Error:', e.message);
    if (context) await context.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Поиск по тексту (fallback) ─────────────────────────────────────────────

app.get('/search', async (req, res) => {
  const { query, secret, limit = '50' } = req.query;

  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!query) return res.status(400).json({ error: 'query param required' });

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
          if (text.includes('"products"')) apiResponses.push(text);
        }
      } catch {}
    });

    const searchUrl = `https://www.wildberries.ru/catalog/0/search.aspx?search=${encodeURIComponent(query)}`;
    console.log(`[wb] Searching: ${query}`);
    await page.goto(searchUrl, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(5000);

    const currentUrl = page.url();
    if (!currentUrl.includes('search')) {
      try {
        const searchInput = await page.waitForSelector('#searchInput, input[name="search"], .search-catalog__input', { timeout: 5000 });
        await searchInput.click();
        await searchInput.fill(String(query));
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000);
      } catch {}
    }

    try {
      await page.waitForSelector('.product-card, [data-nm-id]', { timeout: 15000 });
    } catch {}
    await page.waitForTimeout(2000);

    let products = [];
    let total = 0;

    for (const text of apiResponses) {
      try {
        const data = JSON.parse(text);
        const prods = data?.data?.products;
        if (prods?.length) {
          products = prods;
          total = data.data.total ?? prods.length;
          break;
        }
      } catch {}
    }

    if (!products.length) {
      const domProducts = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('.product-card, article, [data-nm-id]').forEach((card) => {
          const link = card.querySelector('a[href*="/catalog/"]');
          const href = link?.getAttribute('href') || '';
          const idMatch = href.match(/\/catalog\/(\d+)/);
          const nmId = card.getAttribute('data-nm-id');
          const id = nmId || (idMatch ? idMatch[1] : null);
          if (!id) return;
          const nameEl = card.querySelector('.product-card__name, .goods-name, p');
          const brandEl = card.querySelector('.product-card__brand, [class*="brand"]');
          const name = nameEl?.textContent?.trim() || '';
          const brand = brandEl?.textContent?.trim() || '';
          const allText = card.textContent || '';
          const priceMatches = allText.match(/\d[\d\s]*₽/g) || [];
          const prices = priceMatches.map((p) => parseInt(p.replace(/\s/g, '').replace('₽', ''))).filter((p) => p > 10 && p < 1000000);
          const price = prices.length ? Math.min(...prices) : 0;
          items.push({ id: parseInt(id), name: brand ? `${brand} / ${name}` : name, price });
        });
        return items;
      });
      if (domProducts.length) {
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
    console.error('[wb] Error:', e.message);
    if (context) await context.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => console.log(`WB Parser running on port ${PORT}`));

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
