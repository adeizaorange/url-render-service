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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render service listening on ${PORT}`));
