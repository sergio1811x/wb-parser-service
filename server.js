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

// Прогреть: открыть WB, получить cookies
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

// Прогрев при старте + обновление каждые 30 мин
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
  const { image_url, secret } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!image_url) return res.status(400).json({ error: 'image_url required' });

  let page = null;
  try {
    // Скачиваем фото
    console.log(`[img] Downloading: ${String(image_url).slice(0, 60)}...`);
    const imgResp = await fetch(String(image_url), { signal: AbortSignal.timeout(10000) });
    if (!imgResp.ok) throw new Error(`Image download: ${imgResp.status}`);
    const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
    const tmpPath = '/tmp/wb_search_img.jpg';
    fs.writeFileSync(tmpPath, imgBuffer);
    console.log(`[img] Downloaded: ${imgBuffer.length} bytes`);

    // Используем новую страницу в тёплом контексте (cookies уже есть)
    await ensureWarmPage();
    page = await warmCtx.newPage();

    // Перехватываем API-ответы
    const apiProducts = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if ((url.includes('__internal') || url.includes('card.wb.ru')) && url.includes('list') && response.status() === 200) {
          const data = await response.json();
          const prods = data?.data?.products ?? data?.products ?? [];
          if (prods.length) apiProducts.push(...prods);
        }
      } catch {}
    });

    // Открываем страницу поиска
    await page.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Ищем file input для фото
    let fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      // Кликаем на камеру
      const clicked = await page.evaluate(() => {
        const el = document.querySelector('[data-wba-header-name="Search_photo"], label[for*="image"], .search-catalog__photo');
        if (el) { el.click(); return true; }
        const search = document.querySelector('input[type="search"], #searchInput');
        if (!search) return false;
        const sr = search.getBoundingClientRect();
        const btns = document.querySelectorAll('button, label');
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          if (r.x > sr.right - 50 && Math.abs(r.y - sr.y) < 20 && r.width < 60) { b.click(); return true; }
        }
        return false;
      });
      if (clicked) await page.waitForTimeout(1500);
      fileInput = await page.$('input[type="file"]');
    }

    if (!fileInput) {
      await page.close();
      return res.json({ success: false, error: 'File input not found' });
    }

    // Загружаем фото
    console.log('[img] Uploading...');
    await fileInput.setInputFiles(tmpPath);
    await page.waitForTimeout(2000);

    // Нажимаем "Найти товар"
    try {
      const findBtn = await page.waitForSelector(
        'button#searchGoodsButton, button[aria-label="Найти товар"], .popup-crop-search-image__button, button.btn-main',
        { timeout: 5000 }
      );
      await findBtn.click();
      console.log('[img] Clicked "Найти товар"');
    } catch {
      console.log('[img] No find button, may auto-search');
    }

    // Ждём результаты
    try {
      await page.waitForSelector('.product-card, [data-nm-id]', { timeout: 15000 });
      console.log('[img] Cards found');
    } catch {
      console.log('[img] No cards');
    }
    await page.waitForTimeout(2000);

    // Парсим: приоритет API-перехват, потом DOM
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
    try { fs.unlinkSync(tmpPath); } catch {}

    const slim = products.slice(0, 50).map(p => ({
      id: p.id,
      name: p.name || '',
      brand: p.brand || '',
      price: p.sizes?.[0]?.price?.product ? Math.round(p.sizes[0].price.product / 100)
        : (p.salePriceU ? Math.round(p.salePriceU / 100) : (p.price || 0)),
      rating: p.reviewRating || 0,
      feedbacks: p.feedbacks || 0,
    }));

    res.json({ success: slim.length > 0, total, count: slim.length, products: slim });

  } catch (e) {
    console.error('[img] Error:', e.message);
    if (page) await page.close().catch(() => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, () => console.log(`WB Parser running on port ${PORT}`));

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
