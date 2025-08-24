const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const UserAgent = require('user-agents');
const cors = require('cors');
const path = require('path');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const dotenv = require('dotenv');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 600 }); // 10 min TTL

// Logger setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/combined.log' })
    ]
});
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple()
    }));
}

app.use(cors());
app.use(express.static('.')); // Serve static files from root
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // 100 requests per IP
});
app.use('/api/', limiter);

// Mock data fallback
const mockData = {
    kenya: ['Afrobeats', 'Nairobi Fashion', 'Benga Music', 'Kenyan Startups', 'Safaricom', 'M-Pesa', 'Kenya Marathon', 'Tech Hubs', 'Tourism Kenya', 'Kipepeo'],
    worldwide: ['Climate Action', 'AI Revolution', 'Metaverse', 'Crypto Trends', 'Global Health', 'Sustainable Tech', 'Digital Nomads', 'Space Tourism', '5G Expansion', 'Quantum Leap'],
    xtrends: ['#XSpaces', 'Elon Musk', '#Crypto', 'SpaceX Launch', '#AI', 'Neuralink', '#Web3', 'Starlink', '#TechTalk', 'Mars Mission'],
    news: ['Global Politics', 'Elections 2025', 'Climate Summit', 'Economic Recovery', 'Vaccine Updates', 'Breaking News', 'International Trade', 'Human Rights', 'Policy Changes', 'War Updates'],
    technology: ['Quantum Computing', 'Web3', 'AR/VR', '5G Networks', 'Blockchain', 'AI Ethics', 'Cybersecurity', 'Cloud Computing', 'IoT Devices', 'Robotics'],
    entertainment: ['AfroPop', 'Netflix Hits', 'Grammy Buzz', 'K-Drama', 'Hollywood Gossip', 'Bollywood Trends', 'Music Festivals', 'Streaming Wars', 'Oscar Predictions', 'Gaming Culture'],
    sports: ['Kenya Marathon', 'Premier League', 'NBA Finals', 'Olympics 2026', 'Rugby Sevens', 'Cricket IPL', 'Esports', 'F1 Racing', 'Athletics', 'Soccer Transfers'],
    lifestyle: ['Minimalism', 'Sustainable Living', 'Travel Trends', 'Wellness Retreats', 'Vegan Recipes', 'DIY Projects', 'Home Decor', 'Fitness Challenges', 'Mindfulness', 'Eco Fashion'],
    business: ['Startup Funding', 'Crypto Markets', 'Stock Market', 'Entrepreneurship', 'Remote Work', 'E-commerce Boom', 'Fintech', 'Supply Chain', 'Mergers', 'Gig Economy'],
    health: ['Mental Health', 'Telemedicine', 'Nutrition Trends', 'Fitness Apps', 'Vaccine Rollout', 'Wellness Tech', 'Aging Research', 'Sleep Science', 'Pandemic Recovery', 'Yoga Trends'],
    science: ['Space Exploration', 'Climate Tech', 'Quantum Physics', 'Biotech', 'AI Research', 'Renewable Energy', 'Genomics', 'Astrophysics', 'Nanotech', 'Deep Sea Exploration'],
    fashion: ['Sustainable Fashion', 'Streetwear', 'Athleisure', 'Vintage Trends', 'Designer Collabs', 'Fashion Week', 'Eco Fabrics', 'Minimalist Style', 'Bold Accessories', 'Cultural Prints']
};

// Serve HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Scrape Google Trends
async function scrapeTrends(countryCode, categoryName) {
    try {
        logger.info(`Scraping trends for ${categoryName}`);
        const userAgent = new UserAgent();
        const headers = {
            'User-Agent': userAgent.toString(),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
        };

        const url = `https://trends.google.com/trends/trendingsearches/daily?geo=${countryCode || ''}`;
        const response = await axios.get(url, { headers, timeout: 15000 });
        const $ = cheerio.load(response.data);

        const trends = [];
        const selectors = [
            '.trending-searches-item .title',
            '.trending-search .title',
            '[data-ved] .title',
            '.trending-searches .title',
            'h3',
            '.title'
        ];

        for (const selector of selectors) {
            $(selector).each((i, element) => {
                const text = $(element).text().trim();
                if (text && text.length > 0 && text.length < 100) trends.push(text);
            });
            if (trends.length > 0) break;
        }

        const uniqueTrends = [...new Set(trends)].slice(0, 10);
        logger.info(`Found ${uniqueTrends.length} trends for ${categoryName}`);
        return uniqueTrends;
    } catch (error) {
        logger.error(`Scraping failed for ${categoryName}: ${error.message}`);
        return [];
    }
}

// Fetch NewsAPI topics
async function getNewsTopics(category, categoryName) {
    try {
        logger.info(`Fetching NewsAPI topics for ${categoryName}`);
        const apiKey = '33579597361b410a9454a9634f3fd8a5';
        const response = await axios.get(`https://newsapi.org/v2/top-headlines?category=${category}&language=en&apiKey=${apiKey}`, {
            timeout: 10000
        });

        const topics = response.data.articles
            .map(article => article.title.split(' - ')[0].trim())
            .filter(title => title.length > 5 && title.length < 60)
            .slice(0, 10);

        logger.info(`Found ${topics.length} news topics for ${categoryName}`);
        return topics;
    } catch (error) {
        logger.error(`NewsAPI failed for ${categoryName}: ${error.message}`);
        return mockData[category] || [];
    }
}

// Fetch X Trends
async function getXTrends() {
    try {
        logger.info('Fetching X Trends');
        const bearerToken = 'AAAAAAAAAAAAAAAAAAAAAE783gEAAAAAel00S9G0811d2ZF%2ByaSXysMQZb4%3Dvug2Qo7Ym1Su6aCsFJRntheTjL0WwmE7nyjQVzyHDokhyZqII2';
        const response = await axios.get('https://api.twitter.com/2/trends/place/1', {
            headers: { Authorization: `Bearer ${bearerToken}` },
            timeout: 10000
        });

        const trends = response.data.trends
            .map(trend => ({
                name: trend.name,
                tweet_volume: trend.tweet_volume || null
            }))
            .filter(trend => trend.name.length > 0)
            .sort((a, b) => (b.tweet_volume || 0) - (a.tweet_volume || 0))
            .map(trend => trend.name)
            .slice(0, 10);

        logger.info(`Found ${trends.length} X Trends`);
        return trends;
    } catch (error) {
        logger.error(`X Trends failed: ${error.message}`);
        return mockData.xtrends;
    }
}

// API endpoint to get trends
app.get('/api/trends', async (req, res) => {
    try {
        logger.info('Starting trends fetch');
        const cached = cache.get('trends');
        if (cached) {
            logger.info('Returning cached trends');
            return res.json(cached);
        }

        const categories = [
            { key: 'kenya', code: 'KE', name: 'Kenya', type: 'trends' },
            { key: 'worldwide', code: '', name: 'Worldwide', type: 'trends' },
            { key: 'xtrends', code: null, name: 'X Trends', type: 'x' },
            { key: 'news', code: 'general', name: 'News', type: 'news' },
            { key: 'technology', code: 'technology', name: 'Technology', type: 'news' },
            { key: 'entertainment', code: 'entertainment', name: 'Entertainment', type: 'news' },
            { key: 'sports', code: 'sports', name: 'Sports', type: 'news' },
            { key: 'lifestyle', code: 'lifestyle', name: 'Lifestyle', type: 'news' },
            { key: 'business', code: 'business', name: 'Business', type: 'news' },
            { key: 'health', code: 'health', name: 'Health', type: 'news' },
            { key: 'science', code: 'science', name: 'Science', type: 'news' },
            { key: 'fashion', code: 'fashion', name: 'Fashion', type: 'news' }
        ];

        const results = {};
        let totalFound = 0;

        for (const category of categories) {
            logger.info(`Processing ${category.name}`);
            let trends = [];
            if (category.type === 'trends') {
                trends = await scrapeTrends(category.code, category.name);
            } else if (category.type === 'news') {
                trends = await getNewsTopics(category.code, category.name);
            } else if (category.type === 'x') {
                trends = await getXTrends();
            }

            if (trends.length === 0) {
                logger.warn(`No data for ${category.name}, using mock data`);
                trends = mockData[category.key] || [];
            }

            results[category.key] = trends;
            totalFound += trends.length;

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const response = {
            success: true,
            timestamp: new Date().toISOString(),
            total_trends: totalFound,
            method: 'mixed_api_scraping',
            ...results
        };

        cache.set('trends', response);
        res.json(response);
    } catch (error) {
        logger.error(`Critical error: ${error.message}`);
        res.status(500).json({
            success: false,
            error: `System error: ${error.message}`
        });
    }
});

// Export trends as CSV
app.get('/api/export', async (req, res) => {
    try {
        logger.info('Exporting trends as CSV');
        const trends = cache.get('trends') || { success: false, error: 'No trends available' };
        if (!trends.success) {
            return res.status(400).json(trends);
        }

        const records = Object.entries(trends)
            .filter(([key]) => key !== 'success' && key !== 'timestamp' && key !== 'total_trends' && key !== 'method')
            .flatMap(([category, keywords]) =>
                keywords.map(keyword => ({ category, keyword }))
            );

        const csvWriter = createCsvWriter({
            path: 'trends_export.csv',
            header: [
                { id: 'category', title: 'Category' },
                { id: 'keyword', title: 'Keyword' }
            ]
        });

        await csvWriter.writeRecords(records);
        res.download('trends_export.csv');
    } catch (error) {
        logger.error(`Export failed: ${error.message}`);
        res.status(500).json({ success: false, error: `Export failed: ${error.message}` });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'TrendScope server running',
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    logger.info(`🚀 TrendScope Platform running on http://localhost:${PORT}`);
});