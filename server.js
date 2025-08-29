const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const stringSimilarity = require('string-similarity');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // cache articles for 10 minutes

// Setup logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
  transports: [new winston.transports.Console()],
});

// Rate limiter to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);
app.use(express.json());

// Utility: Normalize strings for deduplication comparisons
function normalizeText(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').trim();
}

// Deduplicate articles by URL and fuzzy title comparison
function removeDuplicates(articles) {
  const seenTitles = new Set();
  const seenUrls = new Set();
  const unique = [];

  for (const article of articles) {
    if (!article.title || !article.link) continue;

    if (seenUrls.has(article.link)) continue;

    const normTitle = normalizeText(article.title);
    let isDuplicate = false;
    for (const existingTitle of seenTitles) {
      if (stringSimilarity.compareTwoStrings(existingTitle, normTitle) > 0.85) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    seenUrls.add(article.link);
    seenTitles.add(normTitle);
    unique.push(article);
  }
  return unique;
}

// ------------------ Site-specific scrapers ------------------

// Scrape kenyans.co.ke (general news)
async function scrapeKenyansCo() {
  try {
    const res = await axios.get('https://www.kenyans.co.ke/news', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const articles = [];
    // Article selector and title/link selectors may need adjustment
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

// Scrape mpasho.co.ke (entertainment)
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
    logger.error('Mpasho.co.ke scraping error: ' + err.message);
    return [];
  }
}

// Scrape ghafla.com (entertainment)
async function scrapeGhafla() {
  try {
    const res = await axios.get('https://www.ghafla.com/entertainment', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const articles = [];
    $('article.post').each((i, el) => {
      const title = $(el).find('h3.entry-title a').text().trim();
      const link = $(el).find('h3.entry-title a').attr('href');
      const image = $(el).find('img').attr('src');
      if (title && link) {
        articles.push({
          title,
          link,
          source: 'ghafla.com',
          image: image || null,
          category: 'entertainment',
          pubDate: new Date().toISOString(),
          region: 'kenyan',
        });
      }
    });
    return articles;
  } catch (err) {
    logger.error('Ghafla.com scraping error: ' + err.message);
    return [];
  }
}

// Scrape pulsesports.co.ke (sports)
async function scrapePulseSports() {
  try {
    const res = await axios.get('https://www.pulsesports.co.ke', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const articles = [];
    $('.article').each((i, el) => {
      const title = $(el).find('.post-title a').text().trim();
      const link = $(el).find('.post-title a').attr('href');
      const image = $(el).find('img').attr('src');
      if (title && link) {
        articles.push({
          title,
          link,
          source: 'pulsesports.co.ke',
          image: image || null,
          category: 'sports',
          pubDate: new Date().toISOString(),
          region: 'kenyan',
        });
      }
    });
    return articles;
  } catch (err) {
    logger.error('PulseSports.co.ke scraping error: ' + err.message);
    return [];
  }
}

// Scrape businessdailyafrica.com (business)
async function scrapeBusinessDaily() {
  try {
    const res = await axios.get('https://www.businessdailyafrica.com', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const articles = [];
    // General selector for news cards on homepage businessdaily
    $('.headline-list a').each((i, el) => {
      const title = $(el).text().trim();
      const link = $(el).attr('href');
      if (title && link) {
        articles.push({
          title,
          link: link.startsWith('http') ? link : `https://www.businessdailyafrica.com${link}`,
          source: 'businessdailyafrica.com',
          image: null,
          category: 'business',
          pubDate: new Date().toISOString(),
          region: 'kenyan',
        });
      }
    });
    return articles;
  } catch (err) {
    logger.error('BusinessDailyAfrica.com scraping error: ' + err.message);
    return [];
  }
}

// Scrape standardmedia.co.ke (news + business)
async function scrapeStandardMedia() {
  try {
    const res = await axios.get('https://www.standardmedia.co.ke', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const articles = [];
    $('.flexible-teaser a.title-link').each((i, el) => {
      const title = $(el).text().trim();
      const link = $(el).attr('href');
      if (title && link) {
        articles.push({
          title,
          link: link.startsWith('http') ? link : `https://www.standardmedia.co.ke${link}`,
          source: 'standardmedia.co.ke',
          image: null,
          category: 'news',
          pubDate: new Date().toISOString(),
          region: 'kenyan',
        });
      }
    });
    return articles;
  } catch (err) {
    logger.error('StandardMedia scraping error: ' + err.message);
    return [];
  }
}

// Scrape royalmedia.co.ke (news)
async function scrapeRoyalMedia() {
  try {
    const res = await axios.get('https://www.royalmedia.co.ke', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const articles = [];
    $('.article-card a.article-title-link').each((i, el) => {
      const title = $(el).text().trim();
      const link = $(el).attr('href');
      if (title && link) {
        articles.push({
          title,
          link: link.startsWith('http') ? link : `https://www.royalmedia.co.ke${link}`,
          source: 'royalmedia.co.ke',
          category: 'news',
          pubDate: new Date().toISOString(),
          region: 'kenyan',
        });
      }
    });
    return articles;
  } catch (err) {
    logger.error('RoyalMedia scraping error: ' + err.message);
    return [];
  }
}

// Scrape mediamaxnetwork.co.ke (news)
async function scrapeMediaMax() {
  try {
    const res = await axios.get('https://mediamaxnetwork.co.ke/news/', { timeout: 10000 });
    const $ = cheerio.load(res.data);
    const articles = [];
    $('article.post').each((i, el) => {
      const title = $(el).find('.entry-title a').text().trim();
      const link = $(el).find('.entry-title a').attr('href');
      if (title && link) {
        articles.push({
          title,
          link,
          source: 'mediamaxnetwork.co.ke',
          category: 'news',
          pubDate: new Date().toISOString(),
          region: 'kenyan',
        });
      }
    });
    return articles;
  } catch (err) {
    logger.error('MediaMax scraping error: ' + err.message);
    return [];
  }
}

// ------------------ GNews API fetch ------------------
async function fetchGNewsKenyan(categoryQuery) {
  if (!process.env.GNEWS_API) {
    logger.warn('GNEWS_API key not set');
    return [];
  }
  try {
    const response = await axios.get('https://gnews.io/api/v4/search', {
      params: {
        q: categoryQuery,
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
      category: categoryQuery.includes('politics') ? 'politics' : 'general',
      image: art.image,
      from: 'gnews',
      region: 'kenyan',
    }));
  } catch (err) {
    logger.error('GNews API fetch error: ' + err.message);
    return [];
  }
}


// ------------------ Category mapping ------------------

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

// Scrape all sites and return combined articles
async function scrapeAllSites() {
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

// Main aggregation function filtered by category
async function getNewsByCategory(category) {
  const query = CATEGORY_QUERIES[category] || 'Kenya';

  const [scrapedArticles, gnewsArticles] = await Promise.all([
    scrapeAllSites(),
    fetchGNewsKenyan(query),
  ]);

  // Combine and filter by category (some scraper categories may be generic - add flexible check)
  const combinedArticles = [...scrapedArticles, ...gnewsArticles].filter((article) => {
    if (!article.category) return false;
    return article.category.toLowerCase().includes(category.toLowerCase());
  });

  const uniqueArticles = removeDuplicates(combinedArticles);

  // Sort newest first
  uniqueArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  // Limit to top 30 articles per category
  return uniqueArticles.slice(0, 30);
}

// API to get news by category
app.get('/api/news/:category', async (req, res) => {
  const category = req.params.category.toLowerCase();

  if (!Object.keys(CATEGORY_QUERIES).includes(category)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid category',
      validCategories: Object.keys(CATEGORY_QUERIES),
    });
  }

  const cacheKey = `news-category-${category}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    logger.info(`Serving cached news for category: ${category}`);
    return res.status(200).json(cached);
  }

  try {
    const articles = await getNewsByCategory(category);

    const response = {
      success: true,
      category,
      count: articles.length,
      items: articles,
      lastUpdated: new Date().toISOString(),
    };

    cache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    logger.error('Error fetching news category:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API to get all news combined across categories deduplicated
app.get('/api/news', async (req, res) => {
  const cacheKey = 'news-all';
  const cached = cache.get(cacheKey);
  if (cached) {
    logger.info('Serving cached combined news');
    return res.json(cached);
  }

  try {
    const categories = Object.keys(CATEGORY_QUERIES);
    const promises = categories.map((cat) => getNewsByCategory(cat));
    const results = await Promise.all(promises);

    // Flatten all articles and deduplicate globally
    const allArticles = results.flat();
    const uniqueArticles = removeDuplicates(allArticles);

    uniqueArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    const response = {
      success: true,
      count: uniqueArticles.length,
      items: uniqueArticles,
      lastUpdated: new Date().toISOString(),
    };

    cache.set(cacheKey, response);

    res.json(response);
  } catch (err) {
    logger.error('Error fetching all news:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Kenyan news aggregator API is running',
    categories: Object.keys(CATEGORY_QUERIES),
    lastUpdated: new Date().toISOString(),
  });
});

// Server startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

module.exports = app;
