const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10-minute cache

// Logger setup
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

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', limiter);

// News categories with optimized search queries
const NEWS_CATEGORIES = {
    general: { name: 'General News', query: 'Kenya' },
    politics: { name: 'Politics', query: 'Kenya politics OR government' },
    business: { name: 'Business', query: 'Kenya business OR economy OR finance' },
    sports: { name: 'Sports', query: 'Kenya sports OR football OR athletics' },
    entertainment: { name: 'Entertainment', query: 'Kenya entertainment OR music OR movies' },
    technology: { name: 'Technology', query: 'Kenya technology OR digital OR innovation' },
    health: { name: 'Health', query: 'Kenya health OR healthcare OR medicine' },
    lifestyle: { name: 'Lifestyle', query: 'Kenya lifestyle OR fashion OR culture' }
};

// GNews API integration - Primary source
async function getGNewsByCategory(category, query) {
    try {
        logger.info(`Fetching ${category} news from GNews...`);
        
        const response = await axios.get('https://gnews.io/api/v4/search', {
            params: {
                q: query,
                token: process.env.GNEWS_API,
                lang: 'en',
                country: 'ke',
                max: 12, // Get extra to filter out duplicates
                sortby: 'publishedAt',
                in: 'title,description'
            },
            timeout: 10000
        });

        logger.info(`GNews ${category}: ${response.data.articles?.length || 0} articles found`);
        
        return response.data.articles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: category,
            image: article.image,
            from: 'gnews'
        }));
    } catch (error) {
        logger.error(`GNews API error for ${category}: ${error.message}`);
        return [];
    }
}

// NewsAPI integration - Fallback source
async function getNewsAPIByCategory(category, query) {
    try {
        logger.info(`Fetching ${category} news from NewsAPI...`);
        
        const response = await axios.get('https://newsapi.org/v2/everything', {
            params: {
                q: query,
                apiKey: process.env.NEWSAPI_KEY,
                language: 'en',
                pageSize: 12,
                sortBy: 'publishedAt',
                searchIn: 'title,description'
            },
            timeout: 10000
        });

        logger.info(`NewsAPI ${category}: ${response.data.articles?.length || 0} articles found`);
        
        return response.data.articles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: category,
            image: article.urlToImage,
            from: 'newsapi'
        }));
    } catch (error) {
        logger.error(`NewsAPI error for ${category}: ${error.message}`);
        return [];
    }
}

// Get global news (non-Kenyan)
async function getGlobalNews() {
    try {
        logger.info('Fetching global news...');
        
        // Try GNews first for global news
        const response = await axios.get('https://gnews.io/api/v4/top-headlines', {
            params: {
                token: process.env.GNEWS_API,
                lang: 'en',
                max: 15,
                // Exclude Kenyan content by focusing on international sources
                topic: 'world-news'
            },
            timeout: 10000
        });

        // Filter out any Kenyan content that might slip through
        const globalArticles = response.data.articles.filter(article => 
            !article.title.toLowerCase().includes('kenya') &&
            !article.description.toLowerCase().includes('kenya')
        );

        logger.info(`Global news: ${globalArticles.length} articles found`);
        
        return globalArticles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: 'global',
            image: article.image,
            from: 'gnews'
        }));
    } catch (error) {
        logger.error(`Global news error: ${error.message}`);
        return [];
    }
}

// Remove duplicate articles based on title similarity
function removeDuplicates(articles) {
    const seen = new Set();
    return articles.filter(article => {
        // Create a normalized version of the title for comparison
        const normalizedTitle = article.title.toLowerCase().replace(/[^\w\s]/g, '').trim();
        if (seen.has(normalizedTitle)) {
            return false;
        }
        seen.add(normalizedTitle);
        return true;
    });
}

// Main function to get news by category with fallback logic
async function getNewsByCategory(category) {
    const categoryConfig = NEWS_CATEGORIES[category];
    if (!categoryConfig) {
        return [];
    }

    let articles = [];
    
    // Try GNews first (primary)
    const gnewsArticles = await getGNewsByCategory(category, categoryConfig.query);
    articles = [...gnewsArticles];
    
    // If we need more articles or GNews failed, try NewsAPI
    if (articles.length < 6) {
        const newsapiArticles = await getNewsAPIByCategory(category, categoryConfig.query);
        articles = [...articles, ...newsapiArticles];
    }
    
    // Remove duplicates and limit to 9 articles
    const uniqueArticles = removeDuplicates(articles);
    return uniqueArticles.slice(0, 9);
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'TrendScope Server - Ready',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        apis: {
            gnews: process.env.GNEWS_API ? 'Configured ✅' : 'Not configured ❌',
            newsapi: process.env.NEWSAPI_KEY ? 'Configured ✅' : 'Not configured ❌'
        },
        categories: Object.keys(NEWS_CATEGORIES),
        cache: {
            enabled: true,
            ttl: '10 minutes'
        }
    });
});

// API endpoint to get news by category
app.get('/api/news/:category', async (req, res) => {
    try {
        const category = req.params.category.toLowerCase();
        
        // Validate category
        if (category !== 'global' && !NEWS_CATEGORIES[category]) {
            return res.status(400).json({
                success: false,
                error: 'Invalid category',
                validCategories: Object.keys(NEWS_CATEGORIES).concat(['global'])
            });
        }

        const cacheKey = `news-${category}`;
        const cached = cache.get(cacheKey);
        
        if (cached) {
            logger.info(`Returning cached data for ${category}`);
            return res.status(200).json(cached);
        }

        let news;
        if (category === 'global') {
            news = await getGlobalNews();
        } else {
            news = await getNewsByCategory(category);
        }

        const responseData = {
            success: true,
            category: category,
            items: news,
            count: news.length,
            lastUpdated: new Date().toISOString(),
            sources: {
                gnews: process.env.GNEWS_API ? 'active' : 'inactive',
                newsapi: process.env.NEWSAPI_KEY ? 'active' : 'inactive'
            }
        };

        cache.set(cacheKey, responseData);
        res.status(200).json(responseData);
    } catch (error) {
        logger.error(`News endpoint error for ${req.params.category}: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch news',
            message: error.message
        });
    }
});

// API endpoint to get all news across all categories
app.get('/api/news', async (req, res) => {
    try {
        const cached = cache.get('all-news');
        if (cached) {
            logger.info('Returning cached data for all news');
            return res.status(200).json(cached);
        }

        const categories = Object.keys(NEWS_CATEGORIES);
        const newsPromises = categories.map(cat => getNewsByCategory(cat));
        const globalPromise = getGlobalNews();
        
        const allResults = await Promise.allSettled([...newsPromises, globalPromise]);
        
        const responseData = {
            success: true,
            lastUpdated: new Date().toISOString()
        };
        
        categories.forEach((category, index) => {
            responseData[category] = allResults[index].status === 'fulfilled' ? allResults[index].value : [];
        });
        responseData.global = allResults[allResults.length - 1].status === 'fulfilled' ? allResults[allResults.length - 1].value : [];

        cache.set('all-news', responseData);
        res.status(200).json(responseData);
    } catch (error) {
        logger.error(`All news endpoint error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch news',
            message: error.message
        });
    }
});

// API endpoint to get available categories
app.get('/api/categories', (req, res) => {
    res.status(200).json({
        success: true,
        categories: Object.keys(NEWS_CATEGORIES).concat(['global']),
        count: Object.keys(NEWS_CATEGORIES).length + 1,
        description: 'Available news categories powered by GNews and NewsAPI'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        message: err.message
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`🚀 Server running on port ${PORT}`);
    logger.info(`📰 GNews API: ${process.env.GNEWS_API ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
    logger.info(`📺 NewsAPI: ${process.env.NEWSAPI_KEY ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
    logger.info(`🗂️ Available categories: ${Object.keys(NEWS_CATEGORIES).join(', ')}`);
    logger.info(`💾 Caching: Enabled (10 minutes)`);
});

module.exports = app;