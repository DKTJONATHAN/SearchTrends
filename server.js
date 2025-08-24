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

// Scrape Google Trends using RSS feed method (most reliable)
async function scrapeGoogleTrendsRSS(region = 'KE') {
    try {
        const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${region}`;
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/rss+xml, application/xml, text/xml',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        
        const xml = response.data;
        const trends = [];
        
        // Parse XML manually to extract trending search terms
        const $ = cheerio.load(xml, { xmlMode: true });
        
        // Extract from title elements
        $('item title').each((i, element) => {
            const title = $(element).text().trim();
            if (title && 
                title !== 'Daily Search Trends' && 
                !title.includes('Trending searches') &&
                title.length > 2 && 
                title.length < 60 &&
                !trends.includes(title)) {
                trends.push(title);
            }
        });
        
        // Also try CDATA extraction
        const cdataRegex = /<!\[CDATA\[(.*?)\]\]>/g;
        let match;
        while ((match = cdataRegex.exec(xml)) !== null) {
            const text = match[1].trim();
            if (text && 
                text !== 'Daily Search Trends' &&
                !text.includes('Trending searches') &&
                text.length > 2 && 
                text.length < 60 &&
                !trends.includes(text)) {
                trends.push(text);
            }
        }

        logger.info(`Google Trends RSS ${region}: ${trends.length} trends extracted`);
        return trends.slice(0, 10);

    } catch (error) {
        logger.error(`Google Trends RSS failed for ${region}: ${error.message}`);
        return [];
    }
}

// Alternative Google Trends method using trending searches endpoint
async function scrapeGoogleTrendsAPI(region = 'KE') {
    try {
        // This mimics the internal API that Google Trends uses
        const url = `https://trends.google.com/trends/api/dailytrends?hl=en&tz=-180&geo=${region}&ns=15`;
        
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Referer': 'https://trends.google.com/',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        
        // Google returns data with )]}' prefix, remove it
        let jsonData = response.data;
        if (typeof jsonData === 'string' && jsonData.startsWith(')]}\'')) {
            jsonData = jsonData.substring(4);
        }
        
        const data = JSON.parse(jsonData);
        const trends = [];
        
        if (data.default && data.default.trendingSearchesDays) {
            const todayTrends = data.default.trendingSearchesDays[0];
            if (todayTrends && todayTrends.trendingSearches) {
                todayTrends.trendingSearches.forEach(trend => {
                    if (trend.title && trend.title.query) {
                        trends.push(trend.title.query);
                    }
                });
            }
        }

        logger.info(`Google Trends API ${region}: ${trends.length} trends extracted`);
        return trends.slice(0, 10);

    } catch (error) {
        logger.error(`Google Trends API failed for ${region}: ${error.message}`);
        return [];
    }
}

// Fetch RSS feeds from various sources
async function fetchRSSFeed(url, feedName) {
    try {
        const response = await axios.get(url, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TrendScope/1.0; +https://trendscope.com/bot)',
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

// Fetch NewsAPI topics (no fallbacks)
async function getNewsTopics(category, categoryName) {
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

// Health check endpoint
app.get('/api/health', (req, res) => {
    try {
        res.status(200).json({
            success: true,
            message: 'TrendScope server running - Real data only',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            data_sources: {
                news: 'NewsAPI',
                google_trends: 'Google Trends RSS + Internal API',
                rss_feeds: 'Direct RSS parsing'
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
            { key: 'kenya', region: 'KE', name: 'Kenya Google Trends', type: 'pytrends' },
            { key: 'worldwide', region: 'US', name: 'Worldwide Google Trends', type: 'pytrends' },
            { key: 'googletrends', region: 'US', name: 'Google Trends', type: 'pytrends' },
            { key: 'news', code: 'general', name: 'News', type: 'news' },
            { key: 'technology', code: 'technology', name: 'Technology', type: 'news' },
            { key: 'entertainment', code: 'entertainment', name: 'Entertainment', type: 'news' },
            { key: 'sports', code: 'sports', name: 'Sports', type: 'news' },
            { key: 'lifestyle', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', name: 'BBC Health RSS', type: 'rss' },
            { key: 'business', code: 'business', name: 'Business', type: 'news' },
            { key: 'health', url: 'https://rss.cnn.com/rss/edition.rss', name: 'CNN RSS', type: 'rss' },
            { key: 'science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', name: 'BBC Science RSS', type: 'rss' },
            { key: 'fashion', url: 'https://www.wired.com/feed/rss', name: 'Wired RSS', type: 'rss' }
        ];

        const results = {};
        const fetchPromises = categories.map(async (category) => {
            try {
                let trends = [];
                
                if (category.type === 'pytrends') {
                    trends = await getGoogleTrendsFromPython(category.region);
                } else if (category.type === 'news') {
                    trends = await getNewsTopics(category.code, category.name);
                } else if (category.type === 'rss') {
                    trends = await fetchRSSFeed(category.url, category.name);
                }
                
                results[category.key] = trends;
                logger.info(`${category.name}: ${trends.length} items fetched`);
            } catch (error) {
                logger.error(`${category.name} failed: ${error.message}`);
                results[category.key] = [];
            }
        });

        // Wait for all requests
        await Promise.allSettled(fetchPromises);

        const response = {
            success: true,
            timestamp: new Date().toISOString(),
            cached: false,
            sources_used: {
                google_trends_rss: ['kenya', 'googletrends'],
                google_trends_api: ['worldwide'],
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
            message: 'TrendScope server - Live data only',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            data_sources: {
                google_trends: 'RSS + Internal API',
                news: 'NewsAPI',
                rss: 'BBC, CNN, Wired feeds'
            },
            regions: { kenya: 'KE', worldwide: 'US' },
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
        logger.info(`TrendScope server running on port ${PORT} - Live data only`);
    });
}

module.exports = app;