const express = require('express');
const { chromium } = require('playwright');
const Vibrant = require('node-vibrant');
const sharp = require('sharp');

const app = express();
app.use(express.json());

const AUTH_TOKEN = process.env.RENDER_AUTH_TOKEN;

app.post('/render', async (req, res) => {
  if (AUTH_TOKEN && req.headers['x-auth-token'] !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { url, wait_ms } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url is required' });

  let browser;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    });
    const page = await context.newPage();

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await page.waitForTimeout(2000 * attempt);
      }
    }

    if (lastErr) {
      if (browser) await browser.close();
      return res.status(500).json({ error: lastErr.message, status: 'failed' });
    }

    // Cloudflare's JS challenge needs a few seconds to resolve and redirect.
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (wait_ms) await page.waitForTimeout(wait_ms);

    const html = await page.content();
    const finalUrl = page.url();
    await browser.close();
    return res.json({ html, final_url: finalUrl, status: 'ok' });
  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: err.message, status: 'failed' });
  }
});

app.post('/extract-color', async (req, res) => {
  if (AUTH_TOKEN && req.headers['x-auth-token'] !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { image_url } = req.body || {};
  if (!image_url) return res.status(400).json({ error: 'image_url is required' });

  try {
    const imageResponse = await fetch(image_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
      }
    });
    if (!imageResponse.ok) throw new Error(`Image fetch failed: ${imageResponse.status}`);

    const arrayBuffer = await imageResponse.arrayBuffer();
    const rawBuffer = Buffer.from(arrayBuffer);

    // Normalize ANY input format (webp, svg, avif, gif, whatever) to PNG
    // so node-vibrant always gets something it can read reliably.
    const pngBuffer = await sharp(rawBuffer).png().toBuffer();
    const palette = await Vibrant.from(pngBuffer).getPalette();

    const toHex = (swatch) => swatch ? swatch.getHex() : null;

    return res.json({
      primary: toHex(palette.Vibrant) || toHex(palette.DarkVibrant) || toHex(palette.Muted) || '#2c3e50',
      secondary: toHex(palette.LightVibrant) || toHex(palette.Muted) || '#7f8c8d',
      neutral: toHex(palette.DarkMuted) || toHex(palette.LightMuted) || '#f5f5f5',
      status: 'ok'
    });
  } catch (err) {
    return res.json({
      primary: '#2c3e50',
      secondary: '#7f8c8d',
      neutral: '#f5f5f5',
      status: 'failed',
      error: err.message
    });
  }
});

app.post('/login-check', async (req, res) => {
  if (AUTH_TOKEN && req.headers['x-auth-token'] !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const {
    login_url,
    username,
    password,
    username_selector,
    password_selector,
    submit_selector,
    success_check,   // e.g. { type: 'url_not_contains', value: '/login' }
    wait_ms
  } = req.body || {};

  if (!login_url || !username || !password) {
    return res.status(400).json({ error: 'login_url, username, and password are required' });
  }
  if (!username_selector || !password_selector || !submit_selector) {
    return res.status(400).json({ error: 'username_selector, password_selector, and submit_selector are required' });
  }

  let browser;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    });
    const page = await context.newPage();

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(login_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await page.waitForTimeout(2000 * attempt);
      }
    }

    if (lastErr) {
      await browser.close();
      return res.status(500).json({ username, success: false, error: lastErr.message, status: 'failed' });
    }

    await page.evaluate(({ sel, val }) => {
  const el = document.querySelector(sel);
  if (el) {
    el.removeAttribute('readonly');
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, { sel: username_selector, val: username });

await page.evaluate(({ sel, val }) => {
  const el = document.querySelector(sel);
  if (el) {
    el.removeAttribute('readonly');
    el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}, { sel: password_selector, val: password });

    // await Promise.all([
    //   page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
    //   page.click(submit_selector)
    // ]);

    const frames = page.frames();
    const debugHtml = await page.content();
    return res.json({
      frame_count: frames.length,
      frame_urls: frames.map(f => f.url()),
      debug_html: debugHtml.substring(0, 8000)
    });

    if (wait_ms) await page.waitForTimeout(wait_ms);

    const finalUrl = page.url();
    const html = await page.content();

    let success = false;
    if (success_check?.type === 'url_not_contains') {
      success = !finalUrl.includes(success_check.value);
    } else if (success_check?.type === 'url_contains') {
      success = finalUrl.includes(success_check.value);
    } else if (success_check?.type === 'text_absent') {
      success = !html.includes(success_check.value);
    } else if (success_check?.type === 'text_present') {
      success = html.includes(success_check.value);
    }

    await browser.close();
    return res.json({
      username,
      success,
      final_url: finalUrl,
      status: 'ok'
    });
  } catch (err) {
    if (browser) await browser.close();
    return res.json({ username, success: false, error: err.message, status: 'failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render service listening on ${PORT}`));


