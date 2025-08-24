const express = require('express');
const axios = require('axios');
const cors = require('cors');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const dotenv = require('dotenv');
const cheerio = require('cheerio');
const Parser = require('rss-parser');

dotenv.config();

const app = express();
const cache = new NodeCache({ stdTTL: 600 });
const parser = new Parser();

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

// Kenyan news sources
const KENYAN_NEWS_SOURCES = [
    'https://www.standardmedia.co.ke/rss',
    'https://www.nation.co.ke/rss',
    'https://www.the-star.co.ke/rss',
    'https://www.citizen.digital/rss',
    'https://www.kbc.co.ke/feed/',
    'https://www.businessdailyafrica.com/rss'
];

// Function to scrape Kenyan news
async function scrapeKenyanNews() {
    try {
        const newsItems = [];
        
        for (const source of KENYAN_NEWS_SOURCES) {
            try {
                const feed = await parser.parseURL(source);
                feed.items.forEach(item => {
                    newsItems.push({
                        title: item.title,
                        link: item.link,
                        content: item.contentSnippet || '',
                        pubDate: item.pubDate,
                        source: feed.title
                    });
                });
            } catch (error) {
                logger.error(`Error scraping ${source}: ${error.message}`);
            }
        }
        
        return newsItems.slice(0, 30); // Return top 30 news items
    } catch (error) {
        logger.error(`Error in scrapeKenyanNews: ${error.message}`);
        return [];
    }
}

// Modified NewsAPI function with Kenya focus
async function getNewsAPITopics() {
    try {
        const apiKey = process.env.NEWSAPI_KEY;
        if (!apiKey) {
            logger.error('NEWSAPI_KEY not configured');
            return [];
        }

        // First try to get Kenyan news specifically
        const kenyaResponse = await axios.get(
            `https://newsapi.org/v2/top-headlines?country=ke&apiKey=${apiKey}`,
            { timeout: 8000 }
        );

        const newsItems = kenyaResponse.data.articles.map(article => ({
            title: article.title,
            link: article.url,
            content: article.description,
            pubDate: article.publishedAt,
            source: article.source.name,
            category: 'Kenyan News'
        }));

        // If we need more content, get global news
        if (newsItems.length < 10) {
            const globalResponse = await axios.get(
                `https://newsapi.org/v2/top-headlines?language=en&apiKey=${apiKey}`,
                { timeout: 8000 }
            );

            globalResponse.data.articles.forEach(article => {
                newsItems.push({
                    title: article.title,
                    link: article.url,
                    content: article.description,
                    pubDate: article.publishedAt,
                    source: article.source.name,
                    category: 'Global News'
                });
            });
        }

        return newsItems.slice(0, 40); // Return mixed news
    } catch (error) {
        logger.error(`NewsAPI error: ${error.message}`);
        return [];
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'TrendScope server - Kenyan focus',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development'
    });
});

// API endpoint to get trends with Kenyan priority
app.get('/api/trends', async (req, res) => {
    try {
        const cached = cache.get('trends');
        if (cached) {
            return res.status(200).json(cached);
        }

        const [kenyanNews, newsApiTopics] = await Promise.all([
            scrapeKenyanNews(),
            getNewsAPITopics()
        ]);

        // Combine and prioritize Kenyan news
        const allNews = [...kenyanNews, ...newsApiTopics];
        
        const responseData = {
            kenya: {
                trends: [],
                news: allNews.filter(item => 
                    item.title.toLowerCase().includes('kenya') || 
                    item.category === 'Kenyan News'
                ).slice(0, 20)
            },
            worldwide: {
                trends: [],
                news: allNews.filter(item => 
                    !item.title.toLowerCase().includes('kenya') && 
                    item.category !== 'Kenyan News'
                ).slice(0, 20)
            }
        };

        cache.set('trends', responseData);
        res.status(200).json(responseData);
    } catch (error) {
        logger.error(`Trends endpoint error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch trends'
        });
    }
});

// Export endpoint
app.get('/api/export', async (req, res) => {
    try {
        const trends = cache.get('trends') || {};
        // Implement your CSV conversion logic here
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=trends.csv');
        res.status(200).send('CSV data would be here');
    } catch (error) {
        logger.error(`Export error: ${error.message}`);
        res.status(500).json({ success: false, error: 'Export failed' });
    }
});

// Error handling
app.use((err, req, res, next) => {
    logger.error(`Unhandled error: ${err.message}`);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT} with Kenyan focus`);
});

module.exports = app;