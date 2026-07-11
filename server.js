import express, { json } from "express";
import { chromium } from "playwright";
import cors from "cors";

const app = express();
app.use(cors());
app.use(json());

let browser;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
  }
  return browser;
}

app.get("/extract", async (req, res) => {
  const { tmdb_id, type = "movie", season, episode } = req.query;
  if (!tmdb_id) return res.status(400).json({ success: false });

  let context;
  try {
    const b = await getBrowser();
    context = await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36" });
    const page = await context.newPage();

    // INTERCEPTACIÓN: Buscamos la URL del m3u8 mientras la página carga
    let hlsUrl = null;
    page.on('request', request => {
      const url = request.url();
      if (url.includes('.m3u8')) {
        hlsUrl = url;
      }
    });

    const targetUrl = type === "tv" 
      ? `https://vidsrc.win/embed/tv/${tmdb_id}/${season}/${episode}` 
      : `https://vidsrc.win/embed/movie/${tmdb_id}`;

    // Navegamos y esperamos solo a que cargue lo mínimo
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    
    // Damos un pequeño tiempo para que el script interno dispare la petición del video
    await page.waitForTimeout(4000); 

    await context.close();

    if (hlsUrl) {
      return res.json({ success: true, hls_url: hlsUrl });
    } else {
      return res.status(404).json({ success: false, error: "No se pudo detectar el stream" });
    }

  } catch (e) {
    if (context) await context.close();
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(process.env.PORT || 4000);
