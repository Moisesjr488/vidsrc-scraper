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

export const LANGUAGE_NAMES = {
  en: "English",
};

export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

// Global browser instance
let browser;
const cache = new Map();
const limit = pLimit(2);

// Scraper util function - OPTIMIZADA
async function scrapeProvider(domain, url) {
  console.log(`\n[${domain}] Iniciando scrape: ${url}`);
  
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });
  
  const page = await context.newPage();
  let hlsUrl = null;
  const subtitles = [];

  try {
    // Intercepción de red para capturar el m3u8
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url();
      if (!hlsUrl && (reqUrl.includes(".m3u8") || reqUrl.includes("master"))) {
        hlsUrl = reqUrl;
        console.log(`[${domain}] ✅ HLS ENCONTRADO: ${hlsUrl}`);
      }
      route.continue();
    });

    // Carga la página
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // Esperar al iframe e interactuar
    const frameElement = await page.waitForSelector("iframe", { timeout: 15000 });
    const frame = await frameElement.contentFrame();

    if (frame) {
      console.log(`[${domain}] Interactuando con el iframe...`);
      // Clic agresivo en el centro para disparar el player
      await frame.mouse.click(300, 200).catch(() => {});
      await frame.click('body').catch(() => {});
    }

    // Esperar a que la red cargue el m3u8 tras el clic
    await page.waitForTimeout(8000);

    if (!hlsUrl) {
      throw new Error("No se pudo detectar la URL del video (.m3u8)");
    }

    await page.close();
    await context.close();
    return { hls_url: hlsUrl, subtitles, error: null };

  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    console.error(`[${domain}] Error: ${error.message}`);
    return { hls_url: null, subtitles: [], error: error.message };
  }
}

// Extract endpoint
app.get("/extract", async (req, res) => {
  const { tmdb_id, type = "movie", season, episode } = req.query;

  if (!tmdb_id) return res.status(400).json({ success: false, error: "tmdb_id is required" });

  const cacheKey = JSON.stringify(req.query);
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < 1000 * 60 * 15) {
    return res.json(cached.response);
  }

  const urls = PROVIDERS.reduce((acc, domain) => {
    acc[domain] = type === "tv" 
      ? `${domain}/embed/tv?tmdb=${tmdb_id}&season=${season}&episode=${episode}` 
      : `${domain}/embed/movie/${tmdb_id}`;
    return acc;
  }, {});

  try {
    const resultsArr = await Promise.all(
      Object.entries(urls).map(([domain, url]) => limit(() => scrapeProvider(domain, url).then(r => [domain, r])))
    );

    const results = Object.fromEntries(resultsArr);
    const success = Object.values(results).some((r) => r.hls_url);
    const response = { success, results };

    cache.set(cacheKey, { timestamp: Date.now(), response });
    res.json(response);
  } catch (err) {
    res.status(500).json({ success: false, error: "Unexpected server error", results: {} });
  }
});

// SUBTITLES LOGIC
async function getIMDbIdFromTMDB(tmdb_id, type = "movie") {
  const url = `https://api.themoviedb.org/3/${type}/${tmdb_id}/external_ids?api_key=${TMDB_API_KEY}`;
  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  const json = await response.json();
  return json.imdb_id || null;
}

async function searchSubtitles(imdb_id) {
  const res = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdb_id}&per_page=100&page=1`, {
    headers: { "Api-Key": OPENSUB_API_KEY, "User-Agent": "Cinemi v1.0.0" },
  });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.data || []).filter(item => item.attributes?.files?.[0]?.file_id && COMMON_LANGUAGES.includes(item.attributes.language))
    .map(item => ({
      language: item.attributes.language,
      file_id: item.attributes.files[0].file_id,
      download_count: item.attributes.download_count || 0,
    })).sort((a, b) => b.download_count - a.download_count).slice(0, 2);
}

async function getSubtitleDownloadUrl(file_id) {
  const res = await fetch("https://api.opensubtitles.com/api/v1/download", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": OPENSUB_API_KEY, "User-Agent": "Cinemi v1.0.0" },
    body: JSON.stringify({ file_id }),
  });
  const json = await res.json();
  return json.link;
}

app.get("/movie-subtitles", async (req, res) => {
  const { tmdb_id, type = "movie" } = req.query;
  try {
    const imdb_id = await getIMDbIdFromTMDB(tmdb_id, type);
    if (!imdb_id) return res.status(404).json({ success: false, error: "IMDb ID not found" });
    const baseList = await searchSubtitles(imdb_id);
    const subtitles = await Promise.all(baseList.map(async (sub) => {
      try { const url = await getSubtitleDownloadUrl(sub.file_id); return { language: sub.language, url }; } catch { return null; }
    }));
    res.json({ success: true, subtitles: subtitles.filter(Boolean) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/tv-subtitles", async (req, res) => {
  const { title, season, episode, type } = req.query;
  try {
    if (type === "tv") {
      const vtt = await getTVSubtitleVTT(title, season, episode);
      if (!vtt) return res.status(404).send("No subtitle found");
      return res.set("Content-Type", "text/vtt").send(vtt);
    }
    res.status(400).send("Invalid type");
  } catch (err) {
    res.status(500).send("Internal server error");
  }
});

app.get("/subtitle-proxy", async (req, res) => {
  const fileUrl = req.query.url;
  if (!fileUrl) return res.status(400).send("Missing URL");
  try {
    const srt = await (await fetch(fileUrl)).text();
    const vtt = "WEBVTT\n\n" + srt.replace(/\r+/g, "").replace(/^\s+|\s+$/g, "").split("\n").map(line => line.replace(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g, "$1:$2:$3.$4")).join("\n");
    res.setHeader("Content-Type", "text/vtt");
    res.send(vtt);
  } catch (err) {
    res.status(500).send("Failed");
  }
});

// App Launch
(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
})();

process.on("SIGINT", async () => { if (browser) await browser.close(); process.exit(); });
process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(); });
