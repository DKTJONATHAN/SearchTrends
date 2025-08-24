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

// Comprehensive Kenyan news sources by category
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
    politics: [
        {
            name: 'Kenya News Agency',
            url: 'https://www.kenyanews.go.ke/rss',
            category: 'politics'
        },
        {
            name: 'Capital FM Politics',
            url: 'https://www.capitalfm.co.ke/news/politics/rss',
            category: 'politics'
        },
        {
            name: 'People Daily Politics',
            url: 'https://www.pd.co.ke/news/politics/rss',
            category: 'politics'
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
            url: 'https://kenyanwallstreet.com/rss',
            category: 'business'
        },
        {
            name: 'KBC Business',
            url: 'https://www.kbc.co.ke/business/rss',
            category: 'business'
        }
    ],
    sports: [
        {
            name: 'Pulse Sports Kenya',
            url: 'https://www.pulsesports.co.ke/rss',
            category: 'sports'
        },
        {
            name: 'Michezo Afrika',
            url: 'https://www.michezoafrika.com/rss',
            category: 'sports'
        },
        {
            name: 'Citizen Sports',
            url: 'https://citizentv.co.ke/sports/rss',
            category: 'sports'
        }
    ],
    entertainment: [
        {
            name: 'Mpasho',
            url: 'https://www.mpasho.co.ke/rss',
            category: 'entertainment'
        },
        {
            name: 'Ghafla',
            url: 'https://www.ghafla.co.ke/rss',
            category: 'entertainment'
        },
        {
            name: 'Pulse Live',
            url: 'https://www.pulselive.co.ke/rss',
            category: 'entertainment'
        }
    ],
    technology: [
        {
            name: 'Techweez',
            url: 'https://www.techweez.com/rss',
            category: 'technology'
        },
        {
            name: 'Business Daily Tech',
            url: 'https://www.businessdailyafrica.com/technology/rss',
            category: 'technology'
        },
        {
            name: 'News Trends KE',
            url: 'https://newstrends.co.ke/technology/rss',
            category: 'technology'
        }
    ],
    health: [
        {
            name: 'Daily Nation Health',
            url: 'https://www.nation.co.ke/health/rss',
            category: 'health'
        },
        {
            name: 'The Standard Health',
            url: 'https://www.standardmedia.co.ke/health/rss',
            category: 'health'
        },
        {
            name: 'Capital FM Health',
            url: 'https://www.capitalfm.co.ke/news/health/rss',
            category: 'health'
        }
    ],
    lifestyle: [
        {
            name: 'Tuko Lifestyle',
            url: 'https://www.tuko.co.ke/lifestyle/rss',
            category: 'lifestyle'
        },
        {
            name: 'Nairobi Wire',
            url: 'https://nairobiwire.com/lifestyle/rss',
            category: 'lifestyle'
        },
        {
            name: 'Standard Lifestyle',
            url: 'https://www.standardmedia.co.ke/lifestyle/rss',
            category: 'lifestyle'
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
            category: source.category,
            image: item.enclosure ? item.enclosure.url : null
        }));
        
        logger.info(`Successfully fetched ${items.length} items from ${source.name}`);
        return items;
    } catch (error) {
        logger.error(`Failed to fetch from ${source.name}: ${error.message}`);
        // Return dummy data if source fails
        return [{
            title: `Latest ${source.category} news from ${source.name}`,
            link: `https://${source.name.toLowerCase().replace(/\s+/g, '')}.co.ke`,
            content: `Check ${source.name} for the latest ${source.category} updates`,
            pubDate: new Date().toISOString(),
            source: source.name,
            category: source.category,
            image: null
        }];
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

// Get global news from international sources
async function getGlobalNews() {
    try {
        const apiKey = process.env.NEWSAPI_KEY;
        let globalNews = [];
        
        if (apiKey) {
            const globalResponse = await axios.get(
                `https://newsapi.org/v2/top-headlines?language=en&pageSize=30&apiKey=${apiKey}`,
                { timeout: 8000 }
            );
            
            globalNews = globalResponse.data.articles.map(article => ({
                title: article.title,
                link: article.url,
                content: article.description,
                pubDate: article.publishedAt,
                source: article.source.name,
                category: 'global',
                fromAPI: true,
                image: article.urlToImage
            }));
        }
        
        // Filter out Kenyan content from global news
        return globalNews.filter(item => !isKenyanContent(item.title, item.content));
    } catch (error) {
        logger.error(`Global news error: ${error.message}`);
        return [];
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    const categories = Object.keys(KENYAN_NEWS_SOURCES);
    const sourceCount = {};
    
    categories.forEach(category => {
        sourceCount[category] = KENYAN_NEWS_SOURCES[category].length;
    });
    
    res.status(200).json({
        success: true,
        message: 'TrendScope server - Comprehensive Kenyan news coverage',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        categories: categories,
        sourcesPerCategory: sourceCount,
        totalSources: categories.reduce((acc, cat) => acc + KENYAN_NEWS_SOURCES[cat].length, 0)
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

// API endpoint to get all news across all categories
app.get('/api/news', async (req, res) => {
    try {
        const cached = cache.get('all-news');
        if (cached) {
            return res.status(200).json(cached);
        }

        const categories = Object.keys(KENYAN_NEWS_SOURCES);
        const newsPromises = categories.map(cat => fetchNewsByCategory(cat));
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
        categories: Object.keys(KENYAN_NEWS_SOURCES).concat(['global']),
        description: 'Available news categories with Kenyan-focused sources'
    });
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
    logger.info(`Server running on port ${PORT} with comprehensive Kenyan news coverage`);
    logger.info(`Available categories: ${Object.keys(KENYAN_NEWS_SOURCES).join(', ')}`);
});

module.exports = app;