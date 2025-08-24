const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
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

// Rate limiting: 100 requests per 15 minutes
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
});
app.use('/api/', limiter);

// Function to scrape Google Trends directly (YOUR WORKING VERSION)
async function scrapeTrends(countryCode, countryName) {
    try {
        console.log(`🔍 Scraping trends for ${countryName}...`);
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive'
        };

        // Google Trends daily trends URL
        const url = `https://trends.google.com/trends/trendingsearches/daily?geo=${countryCode}`;
        
        const response = await axios.get(url, { 
            headers,
            timeout: 15000,
            maxRedirects: 5
        });

        const html = response.data;
        const $ = cheerio.load(html);
        
        // Try to extract trending searches from the page
        const trends = [];
        
        // Look for different possible selectors where trends might be
        const selectors = [
            '.trending-searches-item .title',
            '.trending-search .title', 
            '[data-ved] .title',
            '.trending-searches .title',
            '.search-item .title',
            'h3',
            '.title'
        ];

        for (const selector of selectors) {
            $(selector).each((i, element) => {
                const text = $(element).text().trim();
                if (text && text.length > 0 && text.length < 100) {
                    trends.push(text);
                }
            });
            
            if (trends.length > 0) break;
        }

        // Remove duplicates and limit to 15
        const uniqueTrends = [...new Set(trends)].slice(0, 15);
        
        if (uniqueTrends.length > 0) {
            console.log(`✅ Found ${uniqueTrends.length} trends for ${countryName}`);
            return uniqueTrends;
        }

        console.log(`⚠️ No trends found in HTML for ${countryName}`);
        return [];

    } catch (error) {
        console.error(`❌ Scraping failed for ${countryName}:`, error.message);
        return [];
    }
}

// Alternative: Use RSS feeds from Google News (YOUR WORKING VERSION)
async function getNewsTopics(countryCode, countryName) {
    try {
        console.log(`📰 Getting news topics for ${countryName}...`);
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (compatible; TrendScope/1.0)',
            'Accept': 'application/rss+xml, application/xml, text/xml'
        };

        // Google News RSS URLs for different countries
        const rssUrls = {
            'KE': 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pMUlNnQVAB?hl=en-KE&gl=KE&ceid=KE:en',
            'US': 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en',
            'GB': 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFZxYUdjU0FtVnVHZ0pIVWlnQVAB?hl=en-GB&gl=GB&ceid=GB:en'
        };

        const url = rssUrls[countryCode];
        if (!url) return [];

        const response = await axios.get(url, { 
            headers,
            timeout: 10000
        });

        const $ = cheerio.load(response.data, { xmlMode: true });
        const topics = [];

        $('item title').each((i, element) => {
            const title = $(element).text().trim();
            if (title && i < 15) {
                // Extract main topic/keyword from news title
                const cleanTitle = title
                    .replace(/\s*-\s*.+$/, '') // Remove " - Source" 
                    .replace(/^\w+:\s*/, '') // Remove "Breaking:" etc
                    .trim();
                
                if (cleanTitle.length > 5 && cleanTitle.length < 60) {
                    topics.push(cleanTitle);
                }
            }
        });

        if (topics.length > 0) {
            console.log(`✅ Found ${topics.length} news topics for ${countryName}`);
            return topics;
        }

        return [];

    } catch (error) {
        console.error(`❌ News topics failed for ${countryName}:`, error.message);
        return [];
    }
}

// Fetch NewsAPI topics (UNCHANGED - YOUR WORKING VERSION)
async function getNewsAPITopics(category, categoryName) {
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