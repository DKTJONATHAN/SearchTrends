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

// GNews API integration for Kenyan content
async function getGNewsKenyanContent(category, query) {
    try {
        logger.info(`Fetching Kenyan ${category} news from GNews...`);
        
        const response = await axios.get('https://gnews.io/api/v4/search', {
            params: {
                q: query,
                token: process.env.GNEWS_API,
                lang: 'en',
                country: 'ke',
                max: 8, // Get extra to filter out duplicates
                sortby: 'publishedAt',
                in: 'title,description'
            },
            timeout: 10000
        });

        logger.info(`GNews Kenyan ${category}: ${response.data.articles?.length || 0} articles found`);
        
        return response.data.articles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: category,
            image: article.image,
            from: 'gnews',
            region: 'kenyan'
        }));
    } catch (error) {
        logger.error(`GNews Kenyan API error for ${category}: ${error.message}`);
        return [];
    }
}

// GNews API integration for global content
async function getGNewsGlobalContent(category) {
    try {
        logger.info(`Fetching global ${category} news from GNews...`);
        
        // Remove "Kenya" from query for global content
        const globalQuery = category === 'general' ? 'news' : category;
        
        const response = await axios.get('https://gnews.io/api/v4/search', {
            params: {
                q: globalQuery,
                token: process.env.GNEWS_API,
                lang: 'en',
                max: 8, // Get extra to filter out duplicates
                sortby: 'publishedAt',
                in: 'title,description',
                exclude: 'Kenya,kenya,Nairobi' // Exclude Kenyan content
            },
            timeout: 10000
        });

        // Additional filtering to ensure no Kenyan content
        const globalArticles = response.data.articles.filter(article => 
            !article.title.toLowerCase().includes('kenya') &&
            !article.description.toLowerCase().includes('kenya')
        );

        logger.info(`GNews Global ${category}: ${globalArticles.length} articles found`);
        
        return globalArticles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: category,
            image: article.image,
            from: 'gnews',
            region: 'global'
        }));
    } catch (error) {
        logger.error(`GNews Global API error for ${category}: ${error.message}`);
        return [];
    }
}

// NewsAPI integration for Kenyan content (fallback)
async function getNewsAPIKenyanContent(category, query) {
    try {
        logger.info(`Fetching Kenyan ${category} news from NewsAPI...`);
        
        const response = await axios.get('https://newsapi.org/v2/everything', {
            params: {
                q: query + ' AND (Kenya OR Kenyan)',
                apiKey: process.env.NEWSAPI_KEY,
                language: 'en',
                pageSize: 8,
                sortBy: 'publishedAt',
                searchIn: 'title,description'
            },
            timeout: 10000
        });

        logger.info(`NewsAPI Kenyan ${category}: ${response.data.articles?.length || 0} articles found`);
        
        return response.data.articles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: category,
            image: article.urlToImage,
            from: 'newsapi',
            region: 'kenyan'
        }));
    } catch (error) {
        logger.error(`NewsAPI Kenyan error for ${category}: ${error.message}`);
        return [];
    }
}

// NewsAPI integration for global content (fallback)
async function getNewsAPIGlobalContent(category) {
    try {
        logger.info(`Fetching global ${category} news from NewsAPI...`);
        
        const globalQuery = category === 'general' ? 'news' : category;
        
        const response = await axios.get('https://newsapi.org/v2/everything', {
            params: {
                q: globalQuery + ' -Kenya -kenya -Nairobi',
                apiKey: process.env.NEWSAPI_KEY,
                language: 'en',
                pageSize: 8,
                sortBy: 'publishedAt',
                searchIn: 'title,description'
            },
            timeout: 10000
        });

        logger.info(`NewsAPI Global ${category}: ${response.data.articles?.length || 0} articles found`);
        
        return response.data.articles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: category,
            image: article.urlToImage,
            from: 'newsapi',
            region: 'global'
        }));
    } catch (error) {
        logger.error(`NewsAPI Global error for ${category}: ${error.message}`);
        return [];
    }
}

// Remove duplicate articles based on title similarity
function removeDuplicates(articles) {
    const seen = new Set();
    return articles.filter(article => {
        const normalizedTitle = article.title.toLowerCase().replace(/[^\w\s]/g, '').trim();
        if (seen.has(normalizedTitle) || normalizedTitle.length < 10) {
            return false;
        }
        seen.add(normalizedTitle);
        return true;
    });
}

// Main function to get 10 topics per category (5 Kenyan + 5 Global)
async function getNewsByCategory(category) {
    const categoryConfig = NEWS_CATEGORIES[category];
    if (!categoryConfig) {
        return [];
    }

    let kenyanArticles = [];
    let globalArticles = [];
    
    // Get Kenyan content - try GNews first, then NewsAPI
    const gnewsKenyan = await getGNewsKenyanContent(category, categoryConfig.query);
    kenyanArticles = [...gnewsKenyan];
    
    if (kenyanArticles.length < 5) {
        const newsapiKenyan = await getNewsAPIKenyanContent(category, categoryConfig.query);
        kenyanArticles = [...kenyanArticles, ...newsapiKenyan];
    }
    
    // Get Global content - try GNews first, then NewsAPI
    const gnewsGlobal = await getGNewsGlobalContent(category);
    globalArticles = [...gnewsGlobal];
    
    if (globalArticles.length < 5) {
        const newsapiGlobal = await getNewsAPIGlobalContent(category);
        globalArticles = [...globalArticles, ...newsapiGlobal];
    }
    
    // Remove duplicates and ensure exactly 5 each
    const uniqueKenyan = removeDuplicates(kenyanArticles).slice(0, 5);
    const uniqueGlobal = removeDuplicates(globalArticles).slice(0, 5);
    
    // Combine with region identifier
    const combinedArticles = [
        ...uniqueKenyan.map(article => ({ ...article, region: 'kenyan' })),
        ...uniqueGlobal.map(article => ({ ...article, region: 'global' }))
    ];
    
    return combinedArticles;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'TrendScope Server - Ready with 10 topics per category (5 Kenyan + 5 Global)',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        apis: {
            gnews: process.env.GNEWS_API ? 'Configured ✅' : 'Not configured ❌',
            newsapi: process.env.NEWSAPI_KEY ? 'Configured ✅' : 'Not configured ❌'
        },
        categories: Object.keys(NEWS_CATEGORIES),
        topicsPerCategory: '10 (5 Kenyan + 5 Global)',
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
        if (!NEWS_CATEGORIES[category]) {
            return res.status(400).json({
                success: false,
                error: 'Invalid category',
                validCategories: Object.keys(NEWS_CATEGORIES)
            });
        }

        const cacheKey = `news-${category}`;
        const cached = cache.get(cacheKey);
        
        if (cached) {
            logger.info(`Returning cached data for ${category}`);
            return res.status(200).json(cached);
        }

        const news = await getNewsByCategory(category);

        const responseData = {
            success: true,
            category: category,
            items: news,
            count: news.length,
            kenyanCount: news.filter(item => item.region === 'kenyan').length,
            globalCount: news.filter(item => item.region === 'global').length,
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
        
        const allResults = await Promise.allSettled(newsPromises);
        
        const responseData = {
            success: true,
            lastUpdated: new Date().toISOString(),
            totalCategories: categories.length,
            totalTopics: 0
        };
        
        categories.forEach((category, index) => {
            const articles = allResults[index].status === 'fulfilled' ? allResults[index].value : [];
            responseData[category] = articles;
            responseData.totalTopics += articles.length;
        });

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
        categories: Object.keys(NEWS_CATEGORIES),
        count: Object.keys(NEWS_CATEGORIES).length,
        description: 'Available news categories with 10 topics each (5 Kenyan + 5 Global)',
        topicsPerCategory: '10 (5 Kenyan + 5 Global)'
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
    logger.info(`📊 Topics per category: 10 (5 Kenyan + 5 Global)`);
    logger.info(`💾 Caching: Enabled (10 minutes)`);
});

module.exports = app;