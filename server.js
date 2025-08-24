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

// Scrape Google Trends for specific regions
async function scrapeGoogleTrends(region = 'KE') {
    try {
        const url = `https://trends.google.com/trends/trendingsearches/daily?geo=${region}&hl=en`;
        
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });

        const $ = cheerio.load(response.data);
        const trends = [];

        // Try multiple selectors to extract trending topics
        const selectors = [
            '.fe-trending-search-title',
            '.trending-search-title',
            '[data-title]',
            '.title',
            'h3',
            '.search-term'
        ];

        for (const selector of selectors) {
            $(selector).each((i, element) => {
                const text = $(element).text().trim();
                if (text && text.length > 2 && text.length < 60 && !trends.includes(text)) {
                    trends.push(text);
                }
            });
            if (trends.length >= 10) break;
        }

        logger.info(`Scraped ${trends.length} trends for ${region}`);
        return trends.slice(0, 10);

    } catch (error) {
        logger.error(`Google Trends scraping failed for ${region}: ${error.message}`);
        return [];
    }
}

// Fetch RSS feeds from various sources
async function fetchRSSFeed(url, feedName) {
    try {
        const response = await axios.get(url, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TrendScope/1.0)'
            }
        });
        
        const xml = response.data;
        const trends = [];
        
        // Extract titles from RSS feeds
        const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/g;
        const simpleTitleRegex = /<title>(.*?)<\/title>/g;
        
        let match;
        
        // Try CDATA format first
        while ((match = titleRegex.exec(xml)) !== null) {
            const title = match[1].trim();
            if (title && title.length > 3 && title.length < 80 && !trends.includes(title)) {
                trends.push(title);
            }
        }
        
        // Try simple title format if no CDATA found
        if (trends.length === 0) {
            while ((match = simpleTitleRegex.exec(xml)) !== null) {
                const title = match[1].trim();
                if (title && 
                    title !== feedName &&
                    !title.includes('RSS') &&
                    title.length > 3 && 
                    title.length < 80 && 
                    !trends.includes(title)) {
                    trends.push(title);
                }
            }
        }

        logger.info(`Fetched ${trends.length} items from ${feedName} RSS`);
        return trends.slice(0, 10);

    } catch (error) {
        logger.error(`RSS feed failed for ${feedName}: ${error.message}`);
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
            
            logger.info(`NewsAPI returned ${trends.length} trends for ${categoryName}`);
            return trends;
        }
        
        logger.warn(`NewsAPI returned no articles for ${categoryName}`);
        return [];
        
    } catch (error) {
        logger.error(`NewsAPI failed for ${categoryName}: ${error.message}`);
        return [];
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    try {
        res.status(200).json({
            success: true,
            message: 'TrendScope server running',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            data_sources: ['NewsAPI', 'Google Trends Scraping', 'RSS Feeds'],
            no_fallbacks: true
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

        logger.info('Fetching fresh trends...');

        const categories = [
            { key: 'kenya', region: 'KE', name: 'Kenya', type: 'google' },
            { key: 'worldwide', region: 'US', name: 'Worldwide', type: 'google' },
            { key: 'googletrends', region: 'US', name: 'Google Trends', type: 'google' },
            { key: 'news', code: 'general', name: 'News', type: 'news' },
            { key: 'technology', code: 'technology', name: 'Technology', type: 'news' },
            { key: 'entertainment', code: 'entertainment', name: 'Entertainment', type: 'news' },
            { key: 'sports', code: 'sports', name: 'Sports', type: 'news' },
            { key: 'lifestyle', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', name: 'Lifestyle', type: 'rss' },
            { key: 'business', code: 'business', name: 'Business', type: 'news' },
            { key: 'health', url: 'https://feeds.bbci.co.uk/news/health/rss.xml', name: 'Health', type: 'rss' },
            { key: 'science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', name: 'Science', type: 'rss' },
            { key: 'fashion', url: 'https://www.vogue.com/feed/rss', name: 'Fashion', type: 'rss' }
        ];

        const results = {};
        const fetchPromises = categories.map(async (category) => {
            try {
                let trends = [];
                
                if (category.type === 'google') {
                    trends = await scrapeGoogleTrends(category.region);
                } else if (category.type === 'news') {
                    trends = await getNewsTopics(category.code, category.name);
                } else if (category.type === 'rss') {
                    trends = await fetchRSSFeed(category.url, category.name);
                }
                
                results[category.key] = trends;
                logger.info(`${category.name}: ${trends.length} trends fetched`);
            } catch (error) {
                logger.error(`Error fetching ${category.name}: ${error.message}`);
                results[category.key] = [];
            }
        });

        // Wait for all requests
        await Promise.allSettled(fetchPromises);

        const response = {
            success: true,
            timestamp: new Date().toISOString(),
            cached: false,
            data_sources: {
                kenya: 'Google Trends KE',
                worldwide: 'Google Trends US', 
                googletrends: 'Google Trends US',
                news_categories: 'NewsAPI',
                rss_feeds: ['BBC Health', 'BBC Science', 'Vogue Fashion']
            },
            no_fallbacks: true,
            ...results
        };

        // Cache the results
        cache.set('trends', response);
        logger.info('Fresh trends fetched and cached successfully');
        
        res.status(200).json(response);
    } catch (error) {
        logger.error(`Critical error in /api/trends: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Trend fetching failed - no fallback data available'
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
            .filter(([key]) => !['success', 'timestamp', 'cached', 'data_sources', 'no_fallbacks'].includes(key))
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
        res.setHeader('Content-Disposition', 'attachment; filename="trendscope-live-trends.csv"');
        res.status(200).send(csv);
        
        logger.info(`CSV export generated with ${records.length} records`);
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
            message: 'TrendScope server running - No fallbacks',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            data_sources: ['NewsAPI Only', 'Google Trends Scraping Only', 'RSS Feeds Only'],
            policy: 'Real data or empty results - no fallbacks'
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
        availableRoutes: ['/api/health', '/api/trends', '/api/export']
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
        logger.info(`TrendScope server running on port ${PORT} - No fallbacks mode`);
    });
}

// Export for Vercel serverless functions
module.exports = app;