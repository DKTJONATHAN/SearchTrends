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

// Verified Kenyan news RSS feeds
const KENYAN_NEWS_SOURCES = [
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
    },
    {
        name: 'Business Daily',
        url: 'https://www.businessdailyafrica.com/rss',
        category: 'business'
    },
    {
        name: 'Citizen TV',
        url: 'https://citizentv.co.ke/rss',
        category: 'general'
    },
    {
        name: 'Kenya News Agency',
        url: 'https://www.kenyanews.go.ke/rss',
        category: 'general'
    }
];

// Function to verify and fetch Kenyan news
async function fetchKenyanNews() {
    const newsItems = [];
    
    for (const source of KENYAN_NEWS_SOURCES) {
        try {
            logger.info(`Fetching news from ${source.name}: ${source.url}`);
            
            const feed = await parser.parseURL(source.url);
            
            feed.items.forEach(item => {
                // Basic validation to ensure it's Kenyan content
                const title = item.title || '';
                const content = item.contentSnippet || item.content || '';
                
                if (isKenyanContent(title, content)) {
                    newsItems.push({
                        title: title,
                        link: item.link,
                        content: content,
                        pubDate: item.pubDate || new Date().toISOString(),
                        source: source.name,
                        category: source.category
                    });
                }
            });
            
            logger.info(`Successfully fetched ${feed.items.length} items from ${source.name}`);
        } catch (error) {
            logger.error(`Failed to fetch from ${source.name}: ${error.message}`);
        }
    }
    
    return newsItems.slice(0, 30); // Return top 30 news items
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

// Modified NewsAPI function with better Kenyan filtering
async function getNewsAPITopics() {
    try {
        const apiKey = process.env.NEWSAPI_KEY;
        if (!apiKey) {
            logger.error('NEWSAPI_KEY not configured');
            return [];
        }

        // Try to get Kenyan news specifically
        let kenyanNews = [];
        try {
            const kenyaResponse = await axios.get(
                `https://newsapi.org/v2/top-headlines?country=ke&apiKey=${apiKey}`,
                { timeout: 8000 }
            );
            
            kenyanNews = kenyaResponse.data.articles.map(article => ({
                title: article.title,
                link: article.url,
                content: article.description,
                pubDate: article.publishedAt,
                source: article.source.name,
                category: 'Kenyan News',
                fromAPI: true
            }));
        } catch (error) {
            logger.error(`NewsAPI Kenya error: ${error.message}`);
        }

        // Get global news as fallback
        let globalNews = [];
        try {
            const globalResponse = await axios.get(
                `https://newsapi.org/v2/top-headlines?language=en&pageSize=20&apiKey=${apiKey}`,
                { timeout: 8000 }
            );
            
            globalNews = globalResponse.data.articles.map(article => ({
                title: article.title,
                link: article.url,
                content: article.description,
                pubDate: article.publishedAt,
                source: article.source.name,
                category: 'Global News',
                fromAPI: true
            }));
        } catch (error) {
            logger.error(`NewsAPI Global error: ${error.message}`);
        }

        return [...kenyanNews, ...globalNews];
    } catch (error) {
        logger.error(`NewsAPI general error: ${error.message}`);
        return [];
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'TrendScope server - Verified Kenyan sources',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        kenyanSources: KENYAN_NEWS_SOURCES.map(s => s.name)
    });
});

// API endpoint to get trends with Kenyan priority
app.get('/api/trends', async (req, res) => {
    try {
        const cached = cache.get('trends');
        if (cached) {
            return res.status(200).json(cached);
        }

        const [kenyanNews, newsApiTopics] = await Promise.allSettled([
            fetchKenyanNews(),
            getNewsAPITopics()
        ]);

        const kenyanResults = kenyanNews.status === 'fulfilled' ? kenyanNews.value : [];
        const apiResults = newsApiTopics.status === 'fulfilled' ? newsApiTopics.value : [];
        
        // Filter Kenyan content from API results
        const kenyanFromAPI = apiResults.filter(item => 
            isKenyanContent(item.title, item.content) || item.category === 'Kenyan News'
        );
        
        // Filter global content from API results
        const globalFromAPI = apiResults.filter(item => 
            !isKenyanContent(item.title, item.content) && item.category !== 'Kenyan News'
        );

        const responseData = {
            kenya: {
                trends: [],
                news: [...kenyanResults, ...kenyanFromAPI].slice(0, 25)
            },
            worldwide: {
                trends: [],
                news: globalFromAPI.slice(0, 25)
            },
            lastUpdated: new Date().toISOString()
        };

        cache.set('trends', responseData);
        res.status(200).json(responseData);
    } catch (error) {
        logger.error(`Trends endpoint error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch trends',
            message: error.message
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT} with verified Kenyan sources`);
});

module.exports = app;