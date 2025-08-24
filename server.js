const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const dotenv = require('dotenv');
const Parser = require('rss-parser');

dotenv.config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 }); // 10-minute cache
const parser = new Parser({
    timeout: 10000,
    customFields: {
        item: [
            ['media:content', 'media'],
            ['content:encoded', 'contentEncoded']
        ]
    }
});

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

// Specialized Kenyan news sources by category
const KENYAN_NEWS_SOURCES = {
    general: [
        {
            name: 'Daily Nation',
            url: 'https://www.nation.co.ke/kenya/rss',
            category: 'general'
        },
        {
            name: 'The Standard',
            url: 'https://www.standardmedia.co.ke/rss',
            category: 'general'
        },
        {
            name: 'The Star',
            url: 'https://www.the-star.co.ke/rss',
            category: 'general'
        }
    ],
    sports: [
        {
            name: 'Pulse Sports Kenya',
            url: 'https://www.pulsesports.co.ke/rss', // Assuming RSS exists
            category: 'sports'
        },
        {
            name: 'Kenya Moja Sports',
            url: 'https://www.kenyamoja.com/sports/rss', // Assuming RSS exists
            category: 'sports'
        },
        {
            name: 'Citizen Sports',
            url: 'https://citizentv.co.ke/sports/rss', // Assuming RSS exists
            category: 'sports'
        }
    ],
    business: [
        {
            name: 'Business Daily',
            url: 'https://www.businessdailyafrica.com/rss',
            category: 'business'
        },
        {
            name: 'The Kenyan Wall Street',
            url: 'https://kenyanwallstreet.com/rss', // Assuming RSS exists
            category: 'business'
        },
        {
            name: 'KBC Business',
            url: 'https://www.kbc.co.ke/business/rss', // Assuming RSS exists
            category: 'business'
        }
    ]
};

// Function to fetch news from a single source
async function fetchNewsFromSource(source) {
    try {
        logger.info(`Fetching news from ${source.name}: ${source.url}`);
        
        const feed = await parser.parseURL(source.url);
        const items = feed.items.slice(0, 3).map(item => ({
            title: item.title || '',
            link: item.link,
            content: item.contentSnippet || item.content || '',
            pubDate: item.pubDate || new Date().toISOString(),
            source: source.name,
            category: source.category
        }));
        
        logger.info(`Successfully fetched ${items.length} items from ${source.name}`);
        return items;
    } catch (error) {
        logger.error(`Failed to fetch from ${source.name}: ${error.message}`);
        return [];
    }
}

// Function to fetch all news by category
async function fetchNewsByCategory(category) {
    const sources = KENYAN_NEWS_SOURCES[category];
    if (!sources) {
        logger.error(`Invalid category: ${category}`);
        return [];
    }
    
    const promises = sources.map(source => fetchNewsFromSource(source));
    const results = await Promise.allSettled(promises);
    
    let allNews = [];
    results.forEach(result => {
        if (result.status === 'fulfilled') {
            allNews = allNews.concat(result.value);
        }
    });
    
    return allNews.slice(0, 9); // Return up to 9 items (3 from each source)
}

// Function to check if content is Kenyan-related
function isKenyanContent(title, content) {
    const kenyanKeywords = [
        'kenya', 'nairobi', 'mombasa', 'kisumu', 'nakuru', 
        'ruto', 'raila', 'uhuru', 'mudavadi', 'rigathi',
        'county', 'mp', 'senator', 'governor', 'kemsa',
        'kplc', 'kengen', 'safaricom', 'equity', 'kcb'
    ];
    
    const text = (title + ' ' + content).toLowerCase();
    return kenyanKeywords.some(keyword => text.includes(keyword));
}

// Modified NewsAPI function with category filtering
async function getGlobalNews() {
    try {
        const apiKey = process.env.NEWSAPI_KEY;
        if (!apiKey) {
            logger.error('NEWSAPI_KEY not configured');
            return [];
        }

        // Get global news
        const globalResponse = await axios.get(
            `https://newsapi.org/v2/top-headlines?language=en&pageSize=30&apiKey=${apiKey}`,
            { timeout: 8000 }
        );
        
        const globalNews = globalResponse.data.articles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: 'Global News',
            fromAPI: true
        }));

        return globalNews.filter(item => !isKenyanContent(item.title, item.content));
    } catch (error) {
        logger.error(`NewsAPI Global error: ${error.message}`);
        return [];
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'TrendScope server - Specialized Kenyan sources',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        sources: {
            general: KENYAN_NEWS_SOURCES.general.map(s => s.name),
            sports: KENYAN_NEWS_SOURCES.sports.map(s => s.name),
            business: KENYAN_NEWS_SOURCES.business.map(s => s.name)
        }
    });
});

// API endpoint to get categorized news
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
            news = await fetchNewsByCategory(category);
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

// API endpoint to get all news
app.get('/api/news', async (req, res) => {
    try {
        const cached = cache.get('all-news');
        if (cached) {
            return res.status(200).json(cached);
        }

        const [general, sports, business, global] = await Promise.allSettled([
            fetchNewsByCategory('general'),
            fetchNewsByCategory('sports'),
            fetchNewsByCategory('business'),
            getGlobalNews()
        ]);

        const responseData = {
            general: general.status === 'fulfilled' ? general.value : [],
            sports: sports.status === 'fulfilled' ? sports.value : [],
            business: business.status === 'fulfilled' ? business.value : [],
            global: global.status === 'fulfilled' ? global.value : [],
            lastUpdated: new Date().toISOString()
        };

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

// Serve static files for non-API routes
app.get('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found',
        available: ['/api/health', '/api/news', '/api/news/:category']
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
    logger.info(`Server running on port ${PORT} with specialized Kenyan sources`);
});

module.exports = app;