const express = require('express');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

const app = express();
const PORT = process.env.PORT || 3001;
const SECRET = process.env.SECRET || 'cardzip-wb-2024';

let browser = null;
let warmCtx = null;
let warmPage = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  return browser;
}

async function ensureWarmPage() {
  if (warmPage && !warmPage.isClosed()) return warmPage;

  console.log('[warm] Creating warm page...');
  const br = await getBrowser();
  if (warmCtx) await warmCtx.close().catch(() => {});

  warmCtx = await br.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
    locale: 'ru-RU',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  warmPage = await warmCtx.newPage();
  await warmPage.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await warmPage.waitForTimeout(3000);
  console.log('[warm] Ready');
  return warmPage;
}

setTimeout(() => ensureWarmPage().catch(e => console.error('[warm]', e.message)), 2000);
setInterval(async () => {
  try {
    if (warmPage && !warmPage.isClosed()) {
      await warmPage.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      console.log('[warm] Cookies refreshed');
    } else {
      warmPage = null;
      await ensureWarmPage();
    }
  } catch { warmPage = null; }
}, 30 * 60 * 1000);

// ─── Поиск по фото через браузер ────────────────────────────────────────────

app.get('/search-by-image', async (req, res) => {
  const { image_url, secret, query } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!image_url && !query) return res.status(400).json({ error: 'image_url or query required' });

  let page = null;
  try {
    await ensureWarmPage();
    page = await warmCtx.newPage();

    // Перехватываем API-ответы WB
    const apiProducts = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('/catalog') && url.includes('search') && response.status() === 200) {
          const data = await response.json();
          const prods = data?.data?.products ?? [];
          if (prods.length) apiProducts.push(...prods);
        }
        if ((url.includes('__internal') || url.includes('card.wb.ru')) && url.includes('list') && response.status() === 200) {
          const data = await response.json();
          const prods = data?.data?.products ?? data?.products ?? [];
          if (prods.length) apiProducts.push(...prods);
        }
      } catch {}
    });

    let photoSearchConfirmed = false;

    if (image_url) {
      // === ПОИСК ПО ФОТО ===
      console.log(`[img] Downloading: ${String(image_url).slice(0, 60)}...`);
      const imgResp = await fetch(String(image_url), { signal: AbortSignal.timeout(10000) });
      if (!imgResp.ok) throw new Error(`Image download: ${imgResp.status}`);
      const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
      const tmpPath = '/tmp/wb_search_img.jpg';
      fs.writeFileSync(tmpPath, imgBuffer);
      console.log(`[img] Downloaded: ${imgBuffer.length} bytes`);

      await page.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

      // Попытка загрузки фото — до 2 полных циклов
      for (let cycle = 0; cycle < 2 && !photoSearchConfirmed; cycle++) {
        if (cycle > 0) {
          console.log(`[img] Retry cycle ${cycle + 1}`);
          await page.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(2000);
        }

        // Найти file input
        let fileInput = await page.$('input[type="file"]');
        if (!fileInput) {
          const clicked = await page.evaluate(() => {
            const selectors = [
              '[data-wba-header-name="Search_photo"]',
              'label[for*="image"]',
              '.search-catalog__photo',
              '[class*="photo-search"]',
              '[class*="camera"]',
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) { el.click(); return true; }
            }
            const search = document.querySelector('input[type="search"], #searchInput, [class*="search__input"]');
            if (!search) return false;
            const sr = search.getBoundingClientRect();
            const btns = document.querySelectorAll('button, label, span, div');
            for (const b of btns) {
              const r = b.getBoundingClientRect();
              if (r.x > sr.right - 60 && Math.abs(r.y - sr.y) < 30 && r.width < 60 && r.width > 10) {
                b.click();
                return true;
              }
            }
            return false;
          });
          if (clicked) await page.waitForTimeout(1500);
          fileInput = await page.$('input[type="file"]');
        }

        if (!fileInput) {
          console.log(`[img] Cycle ${cycle + 1}: file input not found`);
          continue;
        }

        // Загружаем фото
        console.log('[img] Uploading...');
        await fileInput.setInputFiles(tmpPath);

        // Ждём модалку crop — увеличенный таймаут
        let findBtnClicked = false;
        for (let attempt = 0; attempt < 4 && !findBtnClicked; attempt++) {
          try {
            await page.waitForSelector(
              '#cropPopupSuccess, .popup-crop-search-image, button#searchGoodsButton, [class*="crop"]',
              { timeout: 8000 }
            );
            await page.waitForTimeout(800);

            // Ищем кнопку по нескольким стратегиям
            findBtnClicked = await page.evaluate(() => {
              // 1. По ID
              const byId = document.querySelector('button#searchGoodsButton');
              if (byId) { byId.click(); return true; }

              // 2. По aria-label
              const byAria = document.querySelector('button[aria-label="Найти товар"]');
              if (byAria) { byAria.click(); return true; }

              // 3. По тексту кнопки
              const buttons = document.querySelectorAll('button');
              for (const btn of buttons) {
                const text = btn.textContent?.trim().toLowerCase() || '';
                if (text.includes('найти товар') || text.includes('найти') || text === 'поиск') {
                  btn.click();
                  return true;
                }
              }

              // 4. Кнопка внутри crop popup
              const popup = document.querySelector('#cropPopupSuccess, .popup-crop-search-image, [class*="crop"]');
              if (popup) {
                const popupBtn = popup.querySelector('button');
                if (popupBtn) { popupBtn.click(); return true; }
              }

              return false;
            });

            if (findBtnClicked) {
              console.log('[img] Clicked "Найти товар"');
            } else {
              console.log(`[img] Attempt ${attempt + 1}: modal visible but button not found`);
              await page.waitForTimeout(2000);
            }
          } catch {
            console.log(`[img] Attempt ${attempt + 1}: no modal yet`);
          }
        }

        if (findBtnClicked) {
          photoSearchConfirmed = true;
        }
      }

      // Ждём результаты
      if (photoSearchConfirmed) {
        try {
          await page.waitForSelector('.product-card, [data-nm-id], .product-card-list', { timeout: 15000 });
          console.log('[img] Cards appeared');
        } catch {
          console.log('[img] Timeout waiting for cards');
        }
        await page.waitForTimeout(3000);
      } else {
        console.log('[img] Photo search not confirmed, falling back to text search');
      }

      try { fs.unlinkSync(tmpPath); } catch {}

      // Если фото-поиск не сработал и есть текстовый запрос — fallback
      if (!photoSearchConfirmed && query && apiProducts.length === 0) {
        await doTextSearch(page, String(query));
        await page.waitForTimeout(3000);
      }
    } else if (query) {
      // === ТЕКСТОВЫЙ ПОИСК (fallback) ===
      await page.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
      await doTextSearch(page, String(query));
      await page.waitForTimeout(3000);
    }

    // Собираем продукты: приоритет API-перехват, потом DOM
    let products = [];
    let total = 0;

    if (apiProducts.length) {
      products = apiProducts;
      total = apiProducts.length;
      console.log(`[img] API intercepted: ${products.length} products`);
    }

    if (!products.length) {
      products = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('.product-card, article, [data-nm-id]').forEach((card) => {
          const link = card.querySelector('a[href*="/catalog/"]');
          const href = link?.getAttribute('href') || '';
          const idMatch = href.match(/\/catalog\/(\d+)/);
          const id = idMatch?.[1] || card.getAttribute('data-nm-id');
          if (!id) return;
          const nameEl = card.querySelector('.product-card__name, .goods-name, p');
          const brandEl = card.querySelector('.product-card__brand, [class*="brand"]');
          const allText = card.textContent || '';
          const priceMatches = allText.match(/\d[\d\s]*₽/g) || [];
          const prices = priceMatches.map(p => parseInt(p.replace(/\s/g, '').replace('₽', ''))).filter(p => p > 10 && p < 1000000);
          items.push({
            id: parseInt(id),
            name: (brandEl?.textContent?.trim() || '') + ' ' + (nameEl?.textContent?.trim() || ''),
            salePriceU: prices.length ? Math.min(...prices) * 100 : 0,
          });
        });
        return items;
      });
      total = products.length;
      console.log(`[img] DOM parsed: ${products.length} products`);
    }

    await page.close();

    const slim = products.slice(0, 50).map(p => ({
      id: p.id,
      name: p.name || '',
      brand: p.brand || '',
      price: p.sizes?.[0]?.price?.product ? Math.round(p.sizes[0].price.product / 100)
        : (p.salePriceU ? Math.round(p.salePriceU / 100) : (p.price || 0)),
      rating: p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
    }));

    res.json({
      success: slim.length > 0,
      total,
      count: slim.length,
      products: slim,
      photoSearchConfirmed,
    });

  } catch (e) {
    console.error('[img] Error:', e.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message, photoSearchConfirmed: false });
  }
});

// Текстовый поиск в строку WB
async function doTextSearch(page, query) {
  console.log(`[txt] Text search: "${query}"`);
  const searchInput = await page.$('input[type="search"], #searchInput, [class*="search__input"]');
  if (!searchInput) {
    console.log('[txt] Search input not found');
    return;
  }
  await searchInput.click();
  await searchInput.fill(query);
  await page.keyboard.press('Enter');
  try {
    await page.waitForSelector('.product-card, [data-nm-id]', { timeout: 12000 });
    console.log('[txt] Results appeared');
  } catch {
    console.log('[txt] No results');
  }
}

// ─── Получить цены по ID ─────────────────────────────────────────────────────

app.get('/prices', async (req, res) => {
  const { ids, secret } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!ids) return res.status(400).json({ error: 'ids required' });

  try {
    const page = await ensureWarmPage();
    const nmList = String(ids).split(',').slice(0, 100).join(';');
    const apiUrl = `https://www.wildberries.ru/__internal/u-card/cards/v4/list?appType=1&curr=rub&dest=-1257786&spp=30&lang=ru&ab_testing=false&nm=${nmList}`;

    console.log(`[prices] Fetching ${nmList.split(';').length} products...`);
    const data = await page.evaluate(async (url) => {
      const r = await fetch(url, { headers: { 'x-requested-with': 'XMLHttpRequest' } });
      return r.json();
    }, apiUrl);

    const products = data?.data?.products ?? data?.products ?? [];
    console.log(`[prices] Got ${products.length} products`);

    const slim = products.map(p => ({
      id: p.id,
      name: p.name || '',
      brand: p.brand || '',
      price: p.sizes?.[0]?.price?.product ? Math.round(p.sizes[0].price.product / 100) : 0,
      rating: p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
    }));

    res.json({ success: slim.length > 0, count: slim.length, products: slim });
  } catch (e) {
    console.error('[prices] Error:', e.message);
    warmPage = null;
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Текстовый поиск через WB API (без Playwright) ──────────────────────────

app.get('/search-by-text', async (req, res) => {
  const { query, secret, limit } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    const encoded = encodeURIComponent(String(query));
    const maxResults = Math.min(parseInt(limit) || 100, 100);
    const url = `https://search.wb.ru/exactmatch/ru/common/v7/search?appType=1&curr=rub&dest=-1257786&query=${encoded}&resultset=catalog&sort=popular&spp=30`;

    console.log(`[search] Text: "${String(query).slice(0, 40)}"`);

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

    console.log(`[search] Found ${slim.length} products for "${String(query).slice(0, 30)}"`);
    res.json({ success: slim.length > 0, total: products.length, count: slim.length, products: slim });
  } catch (e) {
    console.error('[search] Error:', e.message);
    res.json({ success: false, error: e.message, products: [] });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), hasBrowser: !!browser?.isConnected(), hasWarmPage: !!warmPage && !warmPage?.isClosed() });
});

app.listen(PORT, () => console.log(`WB Parser running on port ${PORT}`));

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
