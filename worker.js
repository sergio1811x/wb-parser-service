const { createClient } = require('@supabase/supabase-js');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const AdmZip = require('adm-zip');
const fs = require('fs');
const crypto = require('crypto');

chromium.use(stealth);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const ELIM_KEY = process.env.ELIM_KEY;
const POLL_INTERVAL = 5000; // 5 секунд

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_KEY required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

let browser = null;
let warmCtx = null;
let warmPage = null;

// ─── Browser ─────────────────────────────────────────────────────────────────

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
  console.log('[warm] Creating...');
  const br = await getBrowser();
  if (warmCtx) await warmCtx.close().catch(() => {});
  warmCtx = await br.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15',
    locale: 'ru-RU', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  });
  warmPage = await warmCtx.newPage();
  await warmPage.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await warmPage.waitForTimeout(3000);
  console.log('[warm] Ready');
  return warmPage;
}

// ─── URL patterns ────────────────────────────────────────────────────────────

const URL_PATTERNS = [
  { platform: '1688', regex: /detail\.1688\.com\/offer\/(\d+)\.html/ },
  { platform: '1688', regex: /1688\.com\/.*?offerId=(\d+)/ },
  { platform: '1688', regex: /m\.1688\.com\/offer\/(\d+)\.html/ },
  { platform: 'taobao', regex: /item\.taobao\.com\/item\.htm\?.*?id=(\d+)/ },
  { platform: 'taobao', regex: /taobao\.com\/.*?id=(\d+)/ },
  { platform: 'tmall', regex: /detail\.tmall\.com\/item\.htm\?.*?id=(\d+)/ },
];

const SHORT_LINK = /qr\.1688\.com\//;

async function resolveUrl(url) {
  if (!SHORT_LINK.test(url)) return url;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (res.url !== url) return res.url;
    const body = await res.text();
    const m = body.match(/(?:m|detail)\.1688\.com\/offer\/(\d+)\.html/);
    if (m) return `https://detail.1688.com/offer/${m[1]}.html`;
    const m2 = body.match(/offerId[=%]3D(\d+)/);
    if (m2) return `https://detail.1688.com/offer/${m2[1]}.html`;
  } catch {}
  return url;
}

function parseUrl(url) {
  for (const { platform, regex } of URL_PATTERNS) {
    const m = url.match(regex);
    if (m?.[1]) return { productId: m[1], platform };
  }
  return null;
}

// ─── Elim API ────────────────────────────────────────────────────────────────

async function fetchProduct(url) {
  const resolved = await resolveUrl(url);
  const parsed = parseUrl(resolved);
  if (!parsed) throw new Error('Invalid URL');

  const { productId, platform } = parsed;
  const elimPlatform = platform === '1688' ? 'alibaba' : 'taobao';

  const res = await fetch('https://openapi.elim.asia/v1/products/find', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ELIM_KEY },
    body: JSON.stringify({ id: productId, platform: elimPlatform, lang: 'en' }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`Elim HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success || !json.title) throw new Error('Elim: product not found');

  const images = (json.img_urls ?? []).slice(0, 15);
  let weightKg = json.shipping_info?.[0]?.weight ?? 0;
  const price = json.promotion_price ?? json.price ?? json.price_range?.[0]?.price ?? 0;

  // Вес из атрибутов
  const wAttrs = (json.attributes ?? []).filter(a => a.name && /重量|净重|weight/i.test(a.name));
  if (wAttrs.length) {
    const raw = wAttrs[0].value ?? '';
    const kgM = raw.match(/([\d.]+)\s*(kg|千克|公斤)/i);
    const gM = raw.match(/([\d.]+)\s*(g|克)/i);
    const numM = raw.match(/^([\d.]+)$/);
    if (kgM) weightKg = parseFloat(kgM[1]);
    else if (gM) weightKg = parseFloat(gM[1]) / 1000;
    else if (numM) { const v = parseFloat(numM[1]); weightKg = v >= 100 ? v / 1000 : v; }
  }

  if (weightKg > 50 || (weightKg > 5 && price < 200)) weightKg = 0;

  return {
    productId: String(json.id ?? productId),
    platform,
    titleCn: json.title,
    titleEn: json.titleEn,
    description: json.description,
    priceYuan: price,
    moq: json.moq ?? 1,
    weightKg,
    images,
    mainImageUrl: images[0] ?? '',
    supplierName: json.shop_name ?? '',
    supplierRating: json.level,
    supplierType: json.seller_type,
    sold: json.sold,
    stock: json.quantity,
    categoryName: json.category_name,
    attributes: (json.attributes ?? []).filter(a => a.name && a.value).map(a => ({ name: a.name, value: a.value })),
    priceRange: (json.price_range ?? []).filter(r => r.price != null && r.min_quantity > 0).map(r => ({ minQty: r.min_quantity, maxQty: r.max_quantity, price: r.price })),
  };
}

// ─── AI ──────────────────────────────────────────────────────────────────────

const MODELS = ['deepseek/deepseek-v4-flash', 'xiaomi/mimo-v2.5', 'google/gemini-2.5-flash-lite-preview-09-2025'];

async function generateSeo(product) {
  let info = `Название: ${product.titleCn}`;
  if (product.titleEn) info += `\nАнгл.: ${product.titleEn}`;
  if (product.categoryName) info += `\nКатегория: ${product.categoryName}`;
  info += `\nЦена: ${product.priceYuan}¥, MOQ: ${product.moq}, Вес: ${product.weightKg || '?'}кг`;
  if (product.attributes?.length) {
    info += '\nХарактеристики:';
    product.attributes.slice(0, 15).forEach(a => info += `\n- ${a.name}: ${a.value}`);
  }

  const prompt = `Ты SEO-копирайтер для Wildberries. Данные товара:\n${info}\n\nВерни ТОЛЬКО JSON:\n{"titleRu":"название для WB","description":"SEO описание 1000-2000 символов","bullets":["5 тезисов для инфографики"],"keywords":["до 10 поисковых фраз"],"characteristics":{"ключ":"значение"}}`;

  for (const model of MODELS) {
    try {
      console.log(`[ai] ${model}...`);
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, max_tokens: 4000, temperature: 0.7,
          messages: [
            { role: 'system', content: 'Отвечай ТОЛЬКО JSON. Никакого Markdown.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const raw = (data.choices?.[0]?.message?.content ?? '').replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(raw);
      if (parsed.titleRu && parsed.description) {
        // Coerce numbers to strings in characteristics
        if (parsed.characteristics) {
          for (const k of Object.keys(parsed.characteristics)) {
            parsed.characteristics[k] = String(parsed.characteristics[k]);
          }
        }
        console.log(`[ai] Success: ${model}`);
        return parsed;
      }
    } catch (e) { console.warn(`[ai] ${model} failed:`, e.message); }
  }
  return { titleRu: product.titleEn || product.titleCn, description: '', bullets: [], keywords: [], characteristics: {}, isFallback: true };
}

// ─── WB поиск по фото ───────────────────────────────────────────────────────

async function searchWb(imageUrl) {
  if (!imageUrl) return null;

  let page = null;
  try {
    await ensureWarmPage();
    page = await warmCtx.newPage();

    // Скачиваем фото
    const imgResp = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
    if (!imgResp.ok) throw new Error(`img ${imgResp.status}`);
    const imgBuf = Buffer.from(await imgResp.arrayBuffer());
    fs.writeFileSync('/tmp/wb_img.jpg', imgBuf);

    // Перехват API
    const apiProducts = [];
    page.on('response', async (r) => {
      try {
        const u = r.url();
        if ((u.includes('__internal') || u.includes('card.wb.ru')) && u.includes('list') && r.status() === 200) {
          const d = await r.json();
          const p = d?.data?.products ?? d?.products ?? [];
          if (p.length) apiProducts.push(...p);
        }
      } catch {}
    });

    await page.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Ищем file input
    let fi = await page.$('input[type="file"]');
    if (!fi) {
      await page.evaluate(() => {
        const el = document.querySelector('[data-wba-header-name="Search_photo"]');
        if (el) el.click();
      });
      await page.waitForTimeout(1500);
      fi = await page.$('input[type="file"]');
    }
    if (!fi) { await page.close(); return null; }

    await fi.setInputFiles('/tmp/wb_img.jpg');
    await page.waitForTimeout(2000);

    // Найти товар
    try {
      const btn = await page.waitForSelector('button#searchGoodsButton, button[aria-label="Найти товар"]', { timeout: 5000 });
      await btn.click();
    } catch {}

    try {
      await page.waitForSelector('.product-card, [data-nm-id]', { timeout: 15000 });
    } catch {}
    await page.waitForTimeout(2000);

    let products = apiProducts;
    if (!products.length) {
      products = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('.product-card, article').forEach(card => {
          const link = card.querySelector('a[href*="/catalog/"]');
          const idMatch = link?.getAttribute('href')?.match(/\/catalog\/(\d+)/);
          if (!idMatch) return;
          const allText = card.textContent || '';
          const pm = allText.match(/\d[\d\s]*₽/g) || [];
          const prices = pm.map(p => parseInt(p.replace(/\s/g, '').replace('₽', ''))).filter(p => p > 10);
          items.push({ id: parseInt(idMatch[1]), name: card.querySelector('.product-card__name, p')?.textContent?.trim() || '', salePriceU: prices.length ? Math.min(...prices) * 100 : 0 });
        });
        return items;
      });
    }

    await page.close();
    fs.unlinkSync('/tmp/wb_img.jpg');

    if (!products.length) return null;

    const prices = products.map(p => {
      const pr = p.sizes?.[0]?.price?.product;
      return pr ? Math.round(pr / 100) : (p.salePriceU ? Math.round(p.salePriceU / 100) : (p.price || 0));
    }).filter(p => p > 0);

    if (!prices.length) return null;

    return {
      avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
      minPrice: Math.min(...prices),
      maxPrice: Math.max(...prices),
      totalCards: products.length,
      topExamples: products.filter(p => (p.sizes?.[0]?.price?.product || p.salePriceU || p.price)).slice(0, 3).map(p => ({
        title: p.name || '',
        price: p.sizes?.[0]?.price?.product ? Math.round(p.sizes[0].price.product / 100) : (p.salePriceU ? Math.round(p.salePriceU / 100) : p.price),
        url: `https://www.wildberries.ru/catalog/${p.id}/detail.aspx`,
      })),
    };
  } catch (e) {
    console.error('[wb] Error:', e.message);
    if (page) await page.close().catch(() => {});
    return null;
  }
}

// ─── Экономика ───────────────────────────────────────────────────────────────

let cachedRate = null;
async function getYuanRate() {
  if (cachedRate && Date.now() - cachedRate.at < 3600000) return cachedRate.v;
  try {
    const r = await fetch('https://www.cbr-xml-daily.ru/daily_json.js', { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const rate = d.Valute?.CNY?.Value / d.Valute?.CNY?.Nominal;
    if (rate > 0) { cachedRate = { v: rate, at: Date.now() }; return rate; }
  } catch {}
  return cachedRate?.v ?? 11.8;
}

function calcEconomics(priceYuan, weightKg, wbAvgPrice, yuanToRub) {
  const cost = Math.round(priceYuan * yuanToRub + Math.max(weightKg * 400, 100));
  const avg = wbAvgPrice ? Math.round(wbAvgPrice) : cost * 3;
  const fee = Math.round(avg * 0.2);
  return { yuanToRub, costRub: cost, avgSaleRub: avg, grossProfitRub: avg - cost - fee - 100, disclaimer: '⚠️ Расчёт предварительный.' };
}

function buildVerdict(economics, wbData, sold) {
  const reasons = [];
  let score = 0;
  const margin = economics.avgSaleRub > 0 ? (economics.grossProfitRub / economics.avgSaleRub) * 100 : 0;
  if (margin >= 30) { reasons.push('Маржа: высокая'); score += 2; }
  else if (margin >= 15) { reasons.push('Маржа: средняя'); score += 1; }
  else { reasons.push('Маржа: низкая'); score -= 1; }
  if (wbData) {
    if (wbData.totalCards < 500) { reasons.push('Конкуренция: низкая'); score += 2; }
    else if (wbData.totalCards < 2000) { reasons.push('Конкуренция: средняя'); score += 1; }
    else { reasons.push('Конкуренция: высокая'); score -= 1; }
  }
  if (economics.costRub < 300) { reasons.push('Цена закупки: низкая'); score += 1; }
  else if (economics.costRub < 1000) { reasons.push('Цена закупки: средняя'); }
  else { reasons.push('Цена закупки: высокая'); score -= 1; }
  if (sold > 1000) { reasons.push('Спрос: высокий'); score += 1; }
  const signal = score >= 3 ? 'green' : score >= 1 ? 'yellow' : 'red';
  const label = signal === 'green' ? '🟢 Можно тестировать' : signal === 'yellow' ? '🟡 Требует анализа' : '🔴 Не рекомендовано';
  return { signal, label, reasons };
}

// ─── ZIP ─────────────────────────────────────────────────────────────────────

async function buildZip(imageUrls) {
  const zip = new AdmZip();
  let total = 0;
  for (let i = 0; i < Math.min(imageUrls.length, 15); i += 5) {
    const batch = imageUrls.slice(i, i + 5);
    const buffers = await Promise.all(batch.map(async url => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
        return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
      } catch { return null; }
    }));
    for (const buf of buffers) {
      if (!buf || total + buf.length > 20 * 1024 * 1024) continue;
      zip.addFile(`image_${String(total + 1).padStart(2, '0')}.jpg`, buf);
      total++;
    }
  }
  return zip.toBuffer().toString('base64');
}

// ─── Job processor ───────────────────────────────────────────────────────────

async function processJob(job) {
  console.log(`[job] Processing ${job.id}: ${job.input_url}`);
  const startTime = Date.now();

  // Update progress
  if (job.tg_message_id) {
    // Можем обновлять прогресс через Supabase → Vercel cron, но для MVP просто логируем
  }

  // 1. Fetch product
  const product = await fetchProduct(job.input_url);
  console.log(`[job] Product: ${product.titleCn?.slice(0, 30)}`);

  // 2. Parallel: AI + WB + ZIP + Economics
  const [seoContent, wbData, zipBase64, yuanToRub] = await Promise.all([
    generateSeo(product),
    searchWb(product.mainImageUrl),
    buildZip(product.images),
    getYuanRate(),
  ]);

  const economics = calcEconomics(product.priceYuan, product.weightKg, wbData?.avgPrice, yuanToRub);
  const verdict = buildVerdict(economics, wbData, product.sold);

  const fullProduct = {
    ...product,
    titleRu: seoContent.titleRu,
    seoContent,
    wbData,
    economics,
    verdict,
  };

  const durationMs = Date.now() - startTime;
  console.log(`[job] Done in ${durationMs}ms`);

  return { product: fullProduct, zipBase64, durationMs };
}

// ─── Poll loop ───────────────────────────────────────────────────────────────

async function pollOnce() {
  const { data, error } = await supabase
    .from('jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1)
    .select()
    .single();

  if (error || !data) return;

  const job = data;
  try {
    const result = await processJob(job);
    await supabase.from('jobs').update({
      status: 'done',
      result_json: result,
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  } catch (e) {
    console.error(`[job] Failed:`, e.message);
    await supabase.from('jobs').update({
      status: 'failed',
      error: e.message,
      finished_at: new Date().toISOString(),
    }).eq('id', job.id);
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

console.log('Worker starting...');
ensureWarmPage().then(() => {
  console.log('Worker ready, polling...');
  setInterval(() => pollOnce().catch(e => console.error('[poll]', e.message)), POLL_INTERVAL);
}).catch(e => {
  console.error('Warm page failed:', e.message);
  process.exit(1);
});

// Refresh cookies every 30 min
setInterval(async () => {
  try {
    if (warmPage && !warmPage.isClosed()) {
      await warmPage.goto('https://www.wildberries.ru/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else { warmPage = null; await ensureWarmPage(); }
  } catch { warmPage = null; }
}, 30 * 60 * 1000);
