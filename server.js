import express, { json } from "express";
import cors from "cors";
import { chromium } from "playwright";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(json());

let browser;

// Inicialización del navegador con flags de optimización extrema
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
        '--disable-extensions',
        '--disable-software-rasterizer'
      ]
    });
  }
  return browser;
}

app.get("/extract", async (req, res) => {
  const { tmdb_id, type = "movie", season, episode } = req.query;

  if (!tmdb_id) {
    return res.status(400).json({ success: false, error: "tmdb_id requerido" });
  }

  let context;
  try {
    const b = await getBrowser();
    context = await b.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    
    const page = await context.newPage();

    // Bloqueo agresivo de recursos innecesarios para ahorrar RAM
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'stylesheet', 'media', 'script'].includes(type) && !route.request().url().includes('vidsrc')) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const targetUrl = type === "tv" 
      ? `https://vidsrc.win/embed/tv/${tmdb_id}/${season}/${episode}` 
      : `https://vidsrc.win/embed/movie/${tmdb_id}`;

    console.log(`[SCRAPER] Navegando a: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 20000 });

    // Filtrado inteligente de Frames: Ignoramos trackers y iframes vacíos
    const frames = page.frames().filter(f => {
      const url = f.url();
      return !url.includes('t.dtscout.com') && 
             !url.includes('push-sdk') && 
             !url.includes('about:blank') &&
             url.length > 0;
    });

    // Intentamos extraer el src del video directamente
    let hlsUrl = null;
    
    // Buscamos en el frame principal o en los sub-frames filtrados
    for (const frame of frames) {
      const src = await frame.evaluate(() => {
        const video = document.querySelector('video');
        return video ? video.src : null;
      }).catch(() => null);
      
      if (src) {
        hlsUrl = src;
        break;
      }
    }

    await context.close();

    if (hlsUrl) {
      res.json({ success: true, hls_url: hlsUrl });
    } else {
      res.status(404).json({ success: false, error: "No se encontró el reproductor de video" });
    }

  } catch (err) {
    if (context) await context.close();
    console.error("[ERROR] Extracción fallida:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Limpieza al cerrar
process.on("SIGTERM", async () => {
  if (browser) await browser.close();
  process.exit();
});

app.listen(PORT, () => console.log(`🚀 API activa en puerto ${PORT}`));
