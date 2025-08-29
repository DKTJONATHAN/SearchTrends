const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const stringSimilarity = require('string-similarity');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const cors = require('cors');
const dotenv = require('dotenv');

// Load env vars from .env if running locally
dotenv.config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10-minute cache

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
  transports: [new winston.transports.Console()],
});

// Log keys availability (helps debug env issues in Vercel logs)
logger.info(`GNEWS_API Available: ${!!process.env.GNEWS_API}`);
logger.info(`NEWSAPI_KEY Available: ${!!process.env.NEWSAPI_KEY}`);

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// CORS for Vercel frontend domain - change to your frontend domain!
const FRONTEND_ORIGIN = process.env.FRONTEND_URL || '*';
app.use(cors({ origin: FRONTEND_ORIGIN }));

app.use(express.json());

// Utilities
function normalizeText(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').trim();
}

function removeDuplicates(articles) {
  const seenTitles = new Set();
  const seenUrls = new Set();
  const unique = [];

  for (const article of articles) {
    if (!article.title || !article.link) continue;
    if (seenUrls.has(article.link)) continue;

    const normTitle = normalizeText(article.title);
    let dup = false;
    for (const t of seenTitles) {
      if (stringSimilarity.compareTwoStrings(t, normTitle) > 0.85) {
        dup = true;
        break;
      }
    }
    if (dup) continue;

    seenUrls.add(article.link);
    seenTitles.add(normTitle);
    unique.push(article);
  }
  return unique;
}

// Scrapers (sample detailed for kenyans.co.ke and mpasho, others simplified similar way)
async function scrapeKenyansCo() {
  try {
    const res = await axios.get('https://www.kenyans.co.ke/news', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const articles = [];

    $('.news-card').each((i, el) => {
      const title = $(el).find('.news-card-title').text().trim();
      const link = $(el).find('a').attr('href');
      const image = $(el).find('img').attr('src');
      if (title && link) {
        articles.push({
          title,
          link: link.startsWith('http') ? link : `https://www.kenyans.co.ke${link}`,
          source: 'kenyans.co.ke',
          image: image || null,
          category: 'general',
          pubDate: new Date().toISOString(),
          region: 'kenyan',
        });
      }
    });
    return articles;
  } catch (err) {
    logger.error('Kenyans.co.ke scraping error: ' + err.message);
    return [];
  }
}

async function scrapeMpasho() {
  try {
    const res = await axios.get('https://mpasho.co.ke/category/entertainment/', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const articles = [];

    $('.td_module_16').each((i, el) => {
      const title = $(el).find('.entry-title a').text().trim();
      const link = $(el).find('.entry-title a').attr('href');
      const image = $(el).find('img').attr('src');
      if (title && link) {
        articles.push({
          title,
          link,
          source: 'mpasho.co.ke',
          image: image || null,
          category: 'entertainment',
          pubDate: new Date().toISOString(),
          region: 'kenyan',
        });
      }
    });

    return articles;
  } catch (err) {
    logger.error('Mpasho scraping error: ' + err.message);
    return [];
  }
}

// TODO: Add other scrapers here following patterns shown - pulsesports, ghafla, etc.
// For brevity, we simulate empty arrays returned.
async function scrapeGhafla() { return []; }
async function scrapePulseSports() { return []; }
async function scrapeBusinessDaily() { return []; }
async function scrapeStandardMedia() { return []; }
async function scrapeRoyalMedia() { return []; }
async function scrapeMediaMax() { return []; }

// GNews API Fetch
async function fetchGNewsKenyan(query) {
  if (!process.env.GNEWS_API) {
    logger.warn('GNEWS_API not configured.');
    return [];
  }
  try {
    const response = await axios.get('https://gnews.io/api/v4/search', {
      params: {
        q: query,
        token: process.env.GNEWS_API,
        lang: 'en',
        country: 'ke',
        max: 20,
        sortby: 'publishedAt',
      },
      timeout: 10000,
    });

    return (response.data.articles || []).map((art) => ({
      title: art.title,
      link: art.url,
      content: art.description,
      pubDate: art.publishedAt,
      source: art.source.name,
      category: query.includes('politics') ? 'politics' : 'general',
      image: art.image,
      from: 'gnews',
      region: 'kenyan',
    }));
  } catch (err) {
    logger.error('GNews API error:', err.message);
    return [];
  }
}

const CATEGORY_QUERIES = {
  general: 'Kenya',
  politics: 'Kenya politics OR government',
  business: 'Kenya business OR economy OR finance',
  sports: 'Kenya sports OR football OR athletics',
  entertainment: 'Kenya entertainment OR music OR movies',
  technology: 'Kenya technology OR digital OR innovation',
  health: 'Kenya health OR healthcare OR medicine',
  lifestyle: 'Kenya lifestyle OR fashion OR culture',
  news: 'Kenya news',
};

async function scrapeAllSources() {
  const [
    kenyaNews,
    mpasho,
    ghafla,
    pulseSports,
    businessDaily,
    standardMedia,
    royalMedia,
    mediaMax,
  ] = await Promise.all([
    scrapeKenyansCo(),
    scrapeMpasho(),
    scrapeGhafla(),
    scrapePulseSports(),
    scrapeBusinessDaily(),
    scrapeStandardMedia(),
    scrapeRoyalMedia(),
    scrapeMediaMax(),
  ]);

  return [].concat(
    kenyaNews,
    mpasho,
    ghafla,
    pulseSports,
    businessDaily,
    standardMedia,
    royalMedia,
    mediaMax
  );
}

async function getNewsByCategory(category) {
  const query = CATEGORY_QUERIES[category] || 'Kenya';

  const [scrapedArticles, gnewsArticles] = await Promise.all([
    scrapeAllSources(),
    fetchGNewsKenyan(query),
  ]);

  // Filter articles by category loosely for scraped data
  const combined = [...scrapedArticles, ...gnewsArticles].filter((a) =>
    a.category && a.category.toLowerCase().includes(category.toLowerCase())
  );

  const unique = removeDuplicates(combined);
  unique.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  return unique.slice(0, 30);
}

// API Routes

app.get('/api/news/:category', async (req, res) => {
  const cat = req.params.category.toLowerCase();
  if (!CATEGORY_QUERIES[cat]) {
    return res.status(400).json({ success: false, error: 'Invalid category', validCategories: Object.keys(CATEGORY_QUERIES) });
  }
  const cacheKey = `news-cat-${cat}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  try {
    const news = await getNewsByCategory(cat);
    const resp = { success: true, category: cat, count: news.length, items: news, lastUpdated: new Date().toISOString() };
    cache.set(cacheKey, resp);
    res.json(resp);
  } catch (err) {
    logger.error('Error /api/news/:category:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/news', async (req, res) => {
  const cacheKey = 'news-all';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const categories = Object.keys(CATEGORY_QUERIES);
    const promises = categories.map((c) => getNewsByCategory(c));
    const newsArrays = await Promise.all(promises);
    const allNews = newsArrays.flat();
    const uniqueAll = removeDuplicates(allNews);
    uniqueAll.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    const result = { success: true, count: uniqueAll.length, items: uniqueAll, lastUpdated: new Date().toISOString() };
    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    logger.error('Error /api/news:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Kenyan news aggregator API running', categories: Object.keys(CATEGORY_QUERIES) });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`News aggregator backend running on port ${PORT}`);
});

module.exports = app;
