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

// News categories with search queries
const NEWS_CATEGORIES = {
    general: { name: 'General News', query: 'Kenya news' },
    politics: { name: 'Politics', query: 'Kenya politics' },
    business: { name: 'Business', query: 'Kenya business economy' },
    sports: { name: 'Sports', query: 'Kenya sports' },
    entertainment: { name: 'Entertainment', query: 'Kenya entertainment' },
    technology: { name: 'Technology', query: 'Kenya technology' },
    health: { name: 'Health', query: 'Kenya health' },
    lifestyle: { name: 'Lifestyle', query: 'Kenya lifestyle' }
};

// GNews API integration
async function getGNewsByCategory(category, query) {
    try {
        const apiKey = process.env.GNEWS_API;
        if (!apiKey) {
            throw new Error('GNEWS_API not configured');
        }

        const response = await axios.get('https://gnews.io/api/v4/search', {
            params: {
                q: query,
                token: apiKey,
                lang: 'en',
                country: 'ke',
                max: 9,
                sortby: 'publishedAt'
            },
            timeout: 8000
        });

        return response.data.articles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: category,
            image: article.image,
            fromGNews: true
        }));
    } catch (error) {
        logger.error(`GNews API error for ${category}: ${error.message}`);
        return [];
    }
}

// NewsAPI integration (fallback)
async function getNewsAPIByCategory(category, query) {
    try {
        const apiKey = process.env.NEWSAPI_KEY;
        if (!apiKey) {
            return [];
        }

        const response = await axios.get('https://newsapi.org/v2/everything', {
            params: {
                q: query,
                apiKey: apiKey,
                language: 'en',
                pageSize: 9,
                sortBy: 'publishedAt'
            },
            timeout: 8000
        });

        return response.data.articles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: category,
            image: article.urlToImage,
            fromNewsAPI: true
        }));
    } catch (error) {
        logger.error(`NewsAPI error for ${category}: ${error.message}`);
        return [];
    }
}

// Get global news (non-Kenyan)
async function getGlobalNews() {
    try {
        // Try GNews first
        const gnewsApiKey = process.env.GNEWS_API;
        if (gnewsApiKey) {
            const response = await axios.get('https://gnews.io/api/v4/top-headlines', {
                params: {
                    token: gnewsApiKey,
                    lang: 'en',
                    max: 15,
                    exclude: 'Kenya,kenya,Nairobi' // Exclude Kenyan content
                },
                timeout: 8000
            });

            return response.data.articles.map(article => ({
                title: article.title,
                link: article.url,
                content: article.description,
                pubDate: article.publishedAt,
                source: article.source.name,
                category: 'global',
                image: article.image,
                fromGNews: true
            }));
        }

        // Fallback to NewsAPI
        const newsapiKey = process.env.NEWSAPI_KEY;
        if (newsapiKey) {
            const response = await axios.get('https://newsapi.org/v2/top-headlines', {
                params: {
                    apiKey: newsapiKey,
                    language: 'en',
                    pageSize: 15,
                    q: '-Kenya -kenya -Nairobi' // Exclude Kenyan content
                },
                timeout: 8000
            });

            return response.data.articles.map(article => ({
                title: article.title,
                link: article.url,
                content: article.description,
                pubDate: article.publishedAt,
                source: article.source.name,
                category: 'global',
                image: article.urlToImage,
                fromNewsAPI: true
            }));
        }

        return [];
    } catch (error) {
        logger.error(`Global news error: ${error.message}`);
        return [];
    }
}

// Main function to get news by category
async function getNewsByCategory(category) {
    const categoryConfig = NEWS_CATEGORIES[category];
    if (!categoryConfig) {
        return [];
    }

    // Try GNews first (primary)
    let news = await getGNewsByCategory(category, categoryConfig.query);
    
    // If GNews returns empty, try NewsAPI
    if (news.length === 0 && process.env.NEWSAPI_KEY) {
        news = await getNewsAPIByCategory(category, categoryConfig.query);
    }

    return news.slice(0, 9); // Ensure max 9 items
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'TrendScope server - GNews & NewsAPI integration',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        apis: {
            gnews: !!process.env.GNEWS_API,
            newsapi: !!process.env.NEWSAPI_KEY
        },
        categories: Object.keys(NEWS_CATEGORIES)
    });
});

// API endpoint to get news by category
app.get('/api/news/:category', async (req, res) => {
    try {
        const category = req.params.category.toLowerCase();
        const cached = cache.get(`news-${category}`);
        
        if (cached) {
            return res.status(200).json(cached);
        }

        let news;
        if (category === 'global') {
            news = await getGlobalNews();
        } else {
            news = await getNewsByCategory(category);
        }

        const responseData = {
            category: category,
            items: news,
            count: news.length,
            lastUpdated: new Date().toISOString()
        };

        cache.set(`news-${category}`, responseData);
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
            return res.status(200).json(cached);
        }

        const categories = Object.keys(NEWS_CATEGORIES);
        const newsPromises = categories.map(cat => getNewsByCategory(cat));
        const globalPromise = getGlobalNews();
        
        const allResults = await Promise.allSettled([...newsPromises, globalPromise]);
        
        const responseData = {};
        categories.forEach((category, index) => {
            responseData[category] = allResults[index].status === 'fulfilled' ? allResults[index].value : [];
        });
        responseData.global = allResults[allResults.length - 1].status === 'fulfilled' ? allResults[allResults.length - 1].value : [];
        responseData.lastUpdated = new Date().toISOString();

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
        categories: Object.keys(NEWS_CATEGORIES).concat(['global']),
        description: 'Available news categories powered by GNews and NewsAPI'
    });
});

// Export endpoint
app.get('/api/export', async (req, res) => {
    try {
        const trends = cache.get('all-news') || {};
        // Simple CSV export implementation
        let csv = 'Category,Title,Source,Date,Link\n';
        
        Object.entries(trends).forEach(([category, items]) => {
            if (Array.isArray(items)) {
                items.forEach(item => {
                    csv += `"${category}","${item.title.replace(/"/g, '""')}","${item.source}","${item.pubDate}","${item.link}"\n`;
                });
            }
        });
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=news-export.csv');
        res.status(200).send(csv);
    } catch (error) {
        logger.error(`Export error: ${error.message}`);
        res.status(500).json({ success: false, error: 'Export failed' });
    }
});

// Serve static files for non-API routes
app.get('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found',
        available: [
            '/api/health',
            '/api/categories',
            '/api/news',
            '/api/news/:category',
            '/api/export'
        ]
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    logger.info(`GNews API: ${process.env.GNEWS_API ? 'Configured' : 'Not configured'}`);
    logger.info(`NewsAPI: ${process.env.NEWSAPI_KEY ? 'Configured' : 'Not configured'}`);
    logger.info(`Available categories: ${Object.keys(NEWS_CATEGORIES).join(', ')}`);
});

module.exports = app;