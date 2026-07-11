import express, { json } from "express";
import cors from "cors";
import { chromium } from "playwright";
import pLimit from "p-limit";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { getTVSubtitleVTT } from "./utils/tvSubtitles.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
export const OPENSUB_API_KEY = process.env.OPENSUB_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;

export const headers = {
  Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
  "Content-Type": "application/json;charset=utf-8",
};

app.use(cors());
app.use(json());

const PROVIDERS = [
  "https://vsembed.ru",
  "https://vsembed.su",
  "https://vidsrcme.ru",
];

export const LANGUAGE_NAMES = { en: "English" };
export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

// Instancia global del navegador
let browser;
const cache = new Map();
const limit = pLimit(2);

// --- SCRAPER ---
async function scrapeProvider(domain, url) {
  console.log(`[${domain}] Iniciando: ${url}`);
  
  if (!browser) throw new Error("Browser not initialized");

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  
  const page = await context.newPage();
  let hlsUrl = null;

  try {
    // Intercepción de red
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url();
      if (!hlsUrl && (reqUrl.includes(".m3u8") || reqUrl.includes("master"))) {
        hlsUrl = reqUrl;
        console.log(`[${domain}] ✅ HLS DETECTADO`);
      }
      route.continue();
    });

    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // Interacción con iframe
    const frameElement = await page.waitForSelector("iframe", { timeout: 15000 });
    const frame = await frameElement.contentFrame();

    if (frame) {
      await frame.mouse.click(300, 200).catch(() => {});
      await frame.click('body').catch(() => {});
    }

    await page.waitForTimeout(8000); // Espera activa para cargar el stream

    if (!hlsUrl) throw new Error("No se pudo obtener el HLS");

    await page.close();
    await context.close();
    return { hls_url: hlsUrl, subtitles: [], error: null };

  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    console.error(`[${domain}] Error: ${error.message}`);
    return { hls_url: null, subtitles: [], error: error.message };
  }
}

// --- ENDPOINTS ---

app.get("/extract", async (req, res) => {
  try {
    const { tmdb_id, type = "movie", season, episode } = req.query;

    if (!tmdb_id) return res.status(400).json({ success: false, error: "tmdb_id requerido" });

    const cacheKey = JSON.stringify(req.query);
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 1000 * 60 * 15) return res.json(cached.response);

    const urls = PROVIDERS.reduce((acc, domain) => {
      acc[domain] = type === "tv" 
        ? `${domain}/embed/tv?tmdb=${tmdb_id}&season=${season}&episode=${episode}` 
        : `${domain}/embed/movie/${tmdb_id}`;
      return acc;
    }, {});

    const resultsArr = await Promise.all(
      Object.entries(urls).map(async ([domain, url]) => {
        try {
          return [domain, await scrapeProvider(domain, url)];
        } catch (e) {
          return [domain, { hls_url: null, subtitles: [], error: e.message }];
        }
      })
    );

    const results = Object.fromEntries(resultsArr);
    const success = Object.values(results).some((r) => r.hls_url);
    const response = { success, results };

    cache.set(cacheKey, { timestamp: Date.now(), response });
    res.json(response);
  } catch (err) {
    console.error("[FATAL] Error en /extract:", err);
    res.status(500).json({ success: false, error: err.message, results: {} });
  }
});

// SUBTITLES
async function getIMDbIdFromTMDB(tmdb_id, type) {
  const res = await fetch(`https://api.themoviedb.org/3/${type}/${tmdb_id}/external_ids?api_key=${TMDB_API_KEY}`, { headers });
  const data = await res.json();
  return data.imdb_id || null;
}

async function searchSubtitles(imdb_id) {
  const res = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdb_id}&per_page=100&page=1`, {
    headers: { "Api-Key": OPENSUB_API_KEY, "User-Agent": "Cinemi v1.0.0" },
  });
  const json = await res.json();
  return (json.data || []).map(i => ({ language: i.attributes.language, file_id: i.attributes.files[0]?.file_id }))
    .filter(i => i.file_id && COMMON_LANGUAGES.includes(i.language)).slice(0, 2);
}

app.get("/movie-subtitles", async (req, res) => {
  try {
    const { tmdb_id, type } = req.query;
    const imdb = await getIMDbIdFromTMDB(tmdb_id, type);
    const subs = await searchSubtitles(imdb);
    res.json({ success: true, subtitles: subs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/tv-subtitles", async (req, res) => {
  try {
    const { title, season, episode, type } = req.query;
    if (type !== "tv") return res.status(400).send("Invalid type");
    const vtt = await getTVSubtitleVTT(title, season, episode);
    if (!vtt) return res.status(404).send("Not found");
    res.set("Content-Type", "text/vtt").send(vtt);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/subtitle-proxy", async (req, res) => {
  try {
    const srt = await (await fetch(req.query.url)).text();
    const vtt = "WEBVTT\n\n" + srt.replace(/\r+/g, "").split("\n").map(l => l.replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g, "$1:$2:$3.$4")).join("\n");
    res.setHeader("Content-Type", "text/vtt").send(vtt);
  } catch (err) {
    res.status(500).send("Error");
  }
});

// App Launch
(async () => {
  browser = await chromium.launch({ 
    headless: true, 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
  });
  app.listen(PORT, () => console.log(`🚀 API en puerto ${PORT}`));
})();

process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(); });

process.on("SIGINT", async () => { if (browser) await browser.close(); process.exit(); });
process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(); });
