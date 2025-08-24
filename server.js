const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const dotenv = require('dotenv');
const cheerio = require('cheerio');

dotenv.config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10-minute cache

// Logger setup - Console only for Vercel
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

app.use(cors());
app.use(express.json());

// Rate limiting: 100 requests per 15 minutes
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', limiter);

// Function to scrape Google Trends directly (from working version)
async function scrapeTrends(countryCode, countryName) {
    try {
        logger.info(`Scraping trends for ${countryName}...`);
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive'
        };

        // Google Trends daily trends URL
        const url = `https://trends.google.com/trends/trendingsearches/daily?geo=${countryCode}`;
        
        const response = await axios.get(url, { 
            headers,
            timeout: 15000,
            maxRedirects: 5
        });

        const html = response.data;
        const $ = cheerio.load(html);
        
        // Try to extract trending searches from the page
        const trends = [];
        
        // Look for different possible selectors where trends might be
        const selectors = [
            '.trending-searches-item .title',
            '.trending-search .title', 
            '[data-ved] .title',
            '.trending-searches .title',
            '.search-item .title',
            'h3',
            '.title'
        ];

        for (const selector of selectors) {
            $(selector).each((i, element) => {
                const text = $(element).text().trim();
                if (text && text.length > 0 && text.length < 100) {
                    trends.push(text);
                }
            });
            
            if (trends.length > 0) break;
        }

        // Remove duplicates and limit to 10
        const uniqueTrends = [...new Set(trends)].slice(0, 10);
        
        if (uniqueTrends.length > 0) {
            logger.info(`Found ${uniqueTrends.length} trends for ${countryName}`);
            return uniqueTrends;
        }

        logger.warn(`No trends found in HTML for ${countryName}`);
        return [];

    } catch (error) {
        logger.error(`Scraping failed for ${countryName}: ${error.message}`);
        return [];
    }
}

// Alternative: Use RSS feeds from Google News (more reliable)
async function getNewsTopics(countryCode, countryName) {
    try {
        logger.info(`Getting news topics for ${countryName}...`);
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (compatible; TrendScope/1.0)',
            'Accept': 'application/rss+xml, application/xml, text/xml'
        };

        // Google News RSS URLs for different countries
        const rssUrls = {
            'KE': 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pMUlNnQVAB?hl=en-KE&gl=KE&ceid=KE:en',
            'US': 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en',
            'GB': 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pIVWlnQVAB?hl=en-GB&gl=GB&ceid=GB:en'
        };

        const url = rssUrls[countryCode];
        if (!url) return [];

        const response = await axios.get(url, { 
            headers,
            timeout: 10000
        });

        const $ = cheerio.load(response.data, { xmlMode: true });
        const topics = [];

        $('item title').each((i, element) => {
            const title = $(element).text().trim();
            if (title && i < 10) {
                // Extract main topic/keyword from news title
                const cleanTitle = title
                    .replace(/\s*-\s*.+$/, '') // Remove " - Source" 
                    .replace(/^\w+:\s*/, '') // Remove "Breaking:" etc
                    .trim();
                
                if (cleanTitle.length > 5 && cleanTitle.length < 60) {
                    topics.push(cleanTitle);
                }
            }
        });

        if (topics.length > 0) {
            logger.info(`Found ${topics.length} news topics for ${countryName}`);
            return topics;
        }

        return [];

    } catch (error) {
        logger.error(`News topics failed for ${countryName}: ${error.message}`);
        return [];
    }
}

// Fetch NewsAPI topics (no fallbacks) - UNCHANGED
async function getNewsAPITopics(category, categoryName) {
    try {
        const apiKey = process.env.NEWSAPI_KEY;
        if (!apiKey) {
            logger.error(`NEWSAPI_KEY not configured for ${categoryName}`);
            return [];
        }
        
        const response = await axios.get(`https://newsapi.org/v2/top-headlines`, {
            params: {
                category: category,
                language: 'en',
                pageSize: 20,
                apiKey: apiKey
            },
            timeout: 8000
        });
        
        if (response.data && response.data.articles && response.data.articles.length > 0) {
            const trends = response.data.articles
                .map(article => {
                    if (!article.title) return null;
                    return article.title.split(' - ')[0].trim();
                })
                .filter(title => title && title.length > 5 && title.length < 80)
                .slice(0, 10);
            
            logger.info(`NewsAPI ${categoryName}: ${trends.length} trends returned`);
            return trends;
        }
        
        logger.warn(`NewsAPI ${categoryName}: No articles returned`);
        return [];
        
    } catch (error) {
        logger.error(`NewsAPI ${categoryName} failed: ${error.message}`);
        return [];
    }
}

// Fetch RSS feeds from various sources
async function fetchRSSFeed(url, feedName) {
    try {
        const response = await axios.get(url, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TrendScope/1.0)',
                'Accept': 'application/rss+xml, application/xml, text/xml'
            }
        });
        
        const xml = response.data;
        const $ = cheerio.load(xml, { xmlMode: true });
        const trends = [];
        
        // Extract titles from RSS feeds
        $('item title, entry title').each((i, element) => {
            const title = $(element).text().trim();
            if (title && title.length > 5 && title.length < 100 && !trends.includes(title)) {
                trends.push(title);
            }
        });

        logger.info(`RSS ${feedName}: ${trends.length} items fetched`);
        return trends.slice(0, 10);

    } catch (error) {
        logger.error(`RSS feed ${feedName} failed: ${error.message}`);
        return [];
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    try {
        res.status(200).json({
            success: true,
            message: 'TrendScope server - Live data only',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            data_sources: {
                google_trends: 'Direct scraping + Google News RSS',
                news: 'NewsAPI',
                rss: 'Various RSS feeds'
            },
            policy: 'No fallbacks - real data or empty results'
        });
    } catch (error) {
        logger.error(`Health check failed: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Health check failed'
        });
    }
});

// API endpoint to get trends
app.get('/api/trends', async (req, res) => {
    try {
        // Check cache first
        const cached = cache.get('trends');
        if (cached) {
            logger.info('Returning cached trends');
            return res.status(200).json(cached);
        }

        logger.info('Fetching fresh trends - no fallbacks...');

        const categories = [
            { key: 'kenya', code: 'KE', name: 'Kenya', type: 'google_trends' },
            { key: 'worldwide', code: 'US', name: 'Worldwide', type: 'google_news' },
            { key: 'googletrends', code: 'GB', name: 'Google Trends', type: 'google_news' },
            { key: 'news', code: 'general', name: 'News', type: 'newsapi' },
            { key: 'technology', code: 'technology', name: 'Technology', type: 'newsapi' },
            { key: 'entertainment', code: 'entertainment', name: 'Entertainment', type: 'newsapi' },
            { key: 'sports', code: 'sports', name: 'Sports', type: 'newsapi' },
            { key: 'lifestyle', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', name: 'BBC Health RSS', type: 'rss' },
            { key: 'business', code: 'business', name: 'Business', type: 'newsapi' },
            { key: 'health', url: 'https://rss.cnn.com/rss/edition.rss', name: 'CNN RSS', type: 'rss' },
            { key: 'science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', name: 'BBC Science RSS', type: 'rss' },
            { key: 'fashion', url: 'https://www.wired.com/feed/rss', name: 'Wired RSS', type: 'rss' }
        ];

        const results = {};
        
        for (const category of categories) {
            try {
                let trends = [];
                
                if (category.type === 'google_trends') {
                    trends = await scrapeTrends(category.code, category.name);
                } else if (category.type === 'google_news') {
                    trends = await getNewsTopics(category.code, category.name);
                } else if (category.type === 'newsapi') {
                    trends = await getNewsAPITopics(category.code, category.name);
                } else if (category.type === 'rss') {
                    trends = await fetchRSSFeed(category.url, category.name);
                }
                
                results[category.key] = trends;
                logger.info(`${category.name}: ${trends.length} items fetched`);
                
                // Wait between requests to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (error) {
                logger.error(`${category.name} failed: ${error.message}`);
                results[category.key] = [];
            }
        }

        const response = {
            success: true,
            timestamp: new Date().toISOString(),
            cached: false,
            sources_used: {
                google_trends_scraping: ['kenya'],
                google_news_rss: ['worldwide', 'googletrends'],
                newsapi: ['news', 'technology', 'entertainment', 'sports', 'business'],
                rss_feeds: ['lifestyle', 'health', 'science', 'fashion']
            },
            no_fallbacks: true,
            ...results
        };

        // Cache the results
        cache.set('trends', response);
        logger.info('All trend sources processed - real data only');
        
        res.status(200).json(response);
    } catch (error) {
        logger.error(`Critical error in /api/trends: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Trend fetching failed',
            no_fallbacks: true
        });
    }
});

// Export trends as CSV
app.get('/api/export', async (req, res) => {
    try {
        const trends = cache.get('trends');
        
        if (!trends || !trends.success) {
            return res.status(404).json({ 
                success: false, 
                error: 'No trends data available. Please fetch trends first.' 
            });
        }

        const records = Object.entries(trends)
            .filter(([key]) => !['success', 'timestamp', 'cached', 'sources_used', 'no_fallbacks'].includes(key))
            .flatMap(([category, keywords]) => {
                if (Array.isArray(keywords)) {
                    return keywords.map(keyword => ({ 
                        category: category.charAt(0).toUpperCase() + category.slice(1), 
                        keyword: keyword.replace(/,/g, ';')
                    }));
                }
                return [];
            });

        if (records.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'No trend data to export' 
            });
        }

        const csv = [
            'Category,Keyword,Timestamp',
            ...records.map(record => 
                `"${record.category}","${record.keyword}","${trends.timestamp}"`
            )
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="trendscope-live-data.csv"');
        res.status(200).send(csv);
        
        logger.info(`CSV export: ${records.length} records from live sources`);
    } catch (error) {
        logger.error(`Export failed: ${error.message}`);
        res.status(500).json({ 
            success: false, 
            error: 'Export generation failed' 
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    try {
        res.status(200).json({
            success: true,
            message: 'TrendScope server - Live data with working scraper',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            data_sources: {
                google_trends: 'Direct scraping (proven method)',
                google_news: 'RSS feeds',
                news: 'NewsAPI',
                rss: 'BBC, CNN, Wired feeds'
            },
            regions: { kenya: 'KE', worldwide: 'US', uk: 'GB' },
            policy: 'Zero fallbacks - live or empty'
        });
    } catch (error) {
        logger.error(`Health check failed: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Health check failed'
        });
    }
});

// Serve static files for non-API routes
app.get('*', (req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Route not found',
        available: ['/api/health', '/api/trends', '/api/export']
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// Only listen on port when not in production
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        logger.info(`TrendScope server running on port ${PORT} - Working scraper method`);
    });
}

module.exports = app;