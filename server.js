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
async function scrapeGoogleTrends(region = 'KE', category = '') {
    try {
        let url = `https://trends.google.com/trends/trendingsearches/daily?geo=${region}&hl=en`;
        
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

        // If no trends found, try alternative approach - RSS feed
        if (trends.length === 0) {
            return await scrapeGoogleTrendsRSS(region);
        }

        logger.info(`Scraped ${trends.length} trends for ${region}`);
        return trends.slice(0, 10);

    } catch (error) {
        logger.error(`Google Trends scraping failed for ${region}: ${error.message}`);
        return await scrapeGoogleTrendsRSS(region);
    }
}

// Alternative method using Google Trends RSS feed
async function scrapeGoogleTrendsRSS(region = 'KE') {
    try {
        const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${region}`;
        const response = await axios.get(url, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TrendScope/1.0)'
            }
        });
        
        const xml = response.data;
        const trends = [];
        
        // Extract titles from CDATA sections
        const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>/g;
        let match;
        
        while ((match = titleRegex.exec(xml)) !== null) {
            const title = match[1].trim();
            if (title && 
                title !== 'Daily Search Trends' && 
                title !== `Trending searches in ${region}` &&
                title.length > 2 && 
                title.length < 60 &&
                !trends.includes(title)) {
                trends.push(title);
            }
        }
        
        // Also try description extraction
        const descRegex = /<description><!\[CDATA\[(.*?)\]\]><\/description>/g;
        while ((match = descRegex.exec(xml)) !== null) {
            const desc = match[1].trim();
            if (desc && desc.length > 5 && desc.length < 60 && !trends.includes(desc)) {
                trends.push(desc);
            }
        }

        logger.info(`Extracted ${trends.length} trends from RSS for ${region}`);
        return trends.slice(0, 10);

    } catch (error) {
        logger.error(`Google Trends RSS failed for ${region}: ${error.message}`);
        
        // Country-specific trending topics as final fallback
        const countryTrends = {
            'KE': ['Safaricom', 'M-Pesa', 'Nairobi', 'William Ruto', 'KCSE Results', 'Kenya Airways', 'Tusker', 'KCB', 'Equity Bank', 'Maasai Mara'],
            'US': ['Donald Trump', 'Taylor Swift', 'NFL', 'iPhone', 'ChatGPT', 'Netflix', 'Amazon', 'Tesla', 'Google', 'YouTube'],
            'default': ['Technology', 'Entertainment', 'Sports', 'News', 'Health', 'Science', 'Business', 'Fashion', 'Travel', 'Food']
        };
        
        return countryTrends[region] || countryTrends['default'];
    }
}

// Fetch NewsAPI topics with Google Trends fallback
async function getNewsTopics(category, categoryName) {
    try {
        const apiKey = process.env.NEWSAPI_KEY;
        if (!apiKey) {
            logger.warn(`NEWSAPI_KEY not configured for ${categoryName}, using Google Trends`);
            return await scrapeGoogleTrends('US');
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
            
            if (trends.length > 0) {
                logger.info(`NewsAPI returned ${trends.length} trends for ${categoryName}`);
                return trends;
            }
        }
        
        // Fallback to Google Trends
        logger.info(`NewsAPI returned no results for ${categoryName}, using Google Trends`);
        return await scrapeGoogleTrends('US');
        
    } catch (error) {
        logger.error(`NewsAPI failed for ${categoryName}: ${error.message}, falling back to Google Trends`);
        return await scrapeGoogleTrends('US');
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
            data_sources: ['NewsAPI', 'Google Trends Scraping'],
            regions: ['Kenya (KE)', 'Worldwide (US)', 'Custom categories']
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
            { key: 'lifestyle', code: 'health', name: 'Lifestyle', type: 'news' },
            { key: 'business', code: 'business', name: 'Business', type: 'news' },
            { key: 'health', code: 'health', name: 'Health', type: 'news' },
            { key: 'science', code: 'science', name: 'Science', type: 'news' },
            { key: 'fashion', code: 'entertainment', name: 'Fashion', type: 'news' }
        ];

        const results = {};
        const fetchPromises = categories.map(async (category) => {
            try {
                let trends = [];
                
                if (category.type === 'google') {
                    trends = await scrapeGoogleTrends(category.region);
                } else if (category.type === 'news') {
                    trends = await getNewsTopics(category.code, category.name);
                }
                
                results[category.key] = trends.length ? trends : await scrapeGoogleTrends('US');
            } catch (error) {
                logger.error(`Error fetching ${category.name}: ${error.message}`);
                results[category.key] = await scrapeGoogleTrends('US');
            }
        });

        // Wait for all requests
        await Promise.allSettled(fetchPromises);

        const response = {
            success: true,
            timestamp: new Date().toISOString(),
            cached: false,
            data_source: 'NewsAPI + Google Trends Scraping',
            regions: { kenya: 'KE', worldwide: 'US' },
            ...results
        };

        // Cache the results
        cache.set('trends', response);
        logger.info('Fresh trends fetched and cached successfully');
        
        res.status(200).json(response);
    } catch (error) {
        logger.error(`Critical error in /api/trends: ${error.message}`);
        
        // Final fallback
        try {
            const fallbackTrends = await scrapeGoogleTrends('US');
            const fallbackResponse = {
                success: true,
                timestamp: new Date().toISOString(),
                cached: false,
                emergency_fallback: true,
                kenya: await scrapeGoogleTrends('KE'),
                worldwide: fallbackTrends,
                googletrends: fallbackTrends,
                news: fallbackTrends,
                technology: fallbackTrends,
                entertainment: fallbackTrends,
                sports: fallbackTrends,
                lifestyle: fallbackTrends,
                business: fallbackTrends,
                health: fallbackTrends,
                science: fallbackTrends,
                fashion: fallbackTrends
            };
            
            res.status(200).json(fallbackResponse);
        } catch (fallbackError) {
            logger.error(`All data sources failed: ${fallbackError.message}`);
            res.status(500).json({
                success: false,
                error: 'All trend sources unavailable'
            });
        }
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
            .filter(([key]) => !['success', 'timestamp', 'cached', 'data_source', 'regions', 'emergency_fallback'].includes(key))
            .flatMap(([category, keywords]) => {
                if (Array.isArray(keywords)) {
                    return keywords.map(keyword => ({ 
                        category: category.charAt(0).toUpperCase() + category.slice(1), 
                        keyword: keyword.replace(/,/g, ';'),
                        source: trends.emergency_fallback ? 'Google Trends Emergency' : 'Live Data'
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
            'Category,Keyword,Source,Timestamp',
            ...records.map(record => 
                `"${record.category}","${record.keyword}","${record.source}","${trends.timestamp}"`
            )
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="trendscope-kenya-trends.csv"');
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
            message: 'TrendScope Kenya server running',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            data_sources: ['NewsAPI', 'Google Trends Kenya Scraping'],
            features: ['Kenya trends', 'Global trends', 'News categories', 'CSV export']
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
        logger.info(`TrendScope Kenya server running on port ${PORT}`);
    });
}

// Export for Vercel serverless functions
module.exports = app;