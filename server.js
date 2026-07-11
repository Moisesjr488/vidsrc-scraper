import express, { json } from "express";
import { chromium } from "playwright";
import cors from "cors";

const app = express();
app.use(cors());
app.use(json());

let browser;

// Configuración ultra-ligera
async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions'
      ]
    });
  }
  return browser;
}

app.get("/extract", async (req, res) => {
  const { tmdb_id, type = "movie" } = req.query;
  if (!tmdb_id) return res.status(400).json({ success: false });

  let context;
  let page;

  try {
    const b = await getBrowser();
    context = await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" });
    page = await context.newPage();

    // BLOQUEAR EL DEBUGGER DE LA WEB
    await page.addInitScript(() => {
      Object.defineProperty(window, 'debugger', { get: () => undefined });
    });

    // BLOQUEAR RECURSOS PESADOS (Ahorro masivo de RAM)
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const url = type === "tv" ? `https://vidsrc.win/embed/tv/${tmdb_id}/${req.query.season}/${req.query.episode}` : `https://vidsrc.win/embed/movie/${tmdb_id}`;
    
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    
    // Esperar a que el iframe aparezca
    await page.waitForSelector("iframe", { timeout: 10000 });
    
    // Extraer src del iframe
    const iframe = page.frameLocator('iframe');
    const hlsUrl = await iframe.locator('video').evaluate(el => el.src).catch(() => null);

    await context.close();
    
    if (hlsUrl) {
      return res.json({ success: true, hls_url: hlsUrl });
    } else {
      return res.json({ success: false, error: "No se pudo extraer" });
    }

  } catch (e) {
    if (context) await context.close();
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(process.env.PORT || 4000);
