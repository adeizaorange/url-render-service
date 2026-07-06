const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const AUTH_TOKEN = process.env.RENDER_AUTH_TOKEN; // simple shared-secret, set later in Coolify

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

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Render service listening on ${PORT}`));