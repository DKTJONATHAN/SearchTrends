const express = require('express');
const axios = require('axios');
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
app.use(express.json());

// Rate limiting: 100 requests per 15 minutes
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100
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

// Fetch NewsAPI topics
async function getNewsTopics(category, categoryName) {
    try {
        const apiKey = process.env.NEWSAPI_KEY;
        if (!apiKey) throw new Error('NEWSAPI_KEY not set');
        const response = await axios.get(`https://newsapi.org/v2/top-headlines?category=${category}&language=en&apiKey=${apiKey}`, {
            timeout: 5000 // 5-second timeout
        });
        return response.data.articles
            .map(article => article.title.split(' - ')[0].trim())
            .filter(title => title.length > 5 && title.length < 60)
            .slice(0, 10);
    } catch (error) {
        logger.error(`NewsAPI failed for ${categoryName}: ${error.message}`);
        return mockData[category] || [];
    }
}

// Fetch X Trends
async function getXTrends() {
    try {
        const bearerToken = process.env.X_API_BEARER_TOKEN;
        if (!bearerToken) throw new Error('X_API_BEARER_TOKEN not set');
        const response = await axios.get('https://api.twitter.com/2/trends/place/1', {
            headers: { Authorization: `Bearer ${bearerToken}` },
            timeout: 5000
        });
        if (!response.data.trends) throw new Error('Invalid X API response');
        return response.data.trends
            .map(trend => trend.name)
            .filter(name => name.length > 0)
            .slice(0, 10);
    } catch (error) {
        logger.error(`X Trends failed: ${error.message}`);
        return mockData.xtrends;
    }
}

// API endpoint to get trends
app.get('/api/trends', async (req, res) => {
    const timeout = setTimeout(() => {
        res.status(504).json({ success: false, error: 'Request timed out' });
    }, 9000); // 9 seconds to stay under 10-second limit
    try {
        const cached = cache.get('trends');
        if (cached) {
            clearTimeout(timeout);
            return res.json(cached);
        }

        const categories = [
            { key: 'kenya', code: 'KE', name: 'Kenya', type: 'mock' }, // Using mock for now
            { key: 'worldwide', code: '', name: 'Worldwide', type: 'mock' },
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
        for (const category of categories) {
            let trends = [];
            if (category.type === 'mock') {
                trends = mockData[category.key] || [];
            } else if (category.type === 'news') {
                trends = await getNewsTopics(category.code, category.name);
            } else if (category.type === 'x') {
                trends = await getXTrends();
            }
            results[category.key] = trends.length ? trends : mockData[category.key] || [];
        }

        const response = {
            success: true,
            timestamp: new Date().toISOString(),
            ...results
        };
        cache.set('trends', response);
        clearTimeout(timeout);
        res.json(response);
    } catch (error) {
        clearTimeout(timeout);
        logger.error(`Critical error in /api/trends: ${error.message}`);
        res.status(500).json({ success: false, error: `System error: ${error.message}` });
    }
});

// Export trends as CSV (response-based for Vercel)
app.get('/api/export', async (req, res) => {
    try {
        const trends = cache.get('trends') || { success: false, error: 'No trends available' };
        if (!trends.success) {
            return res.status(400).json(trends);
        }

        const records = Object.entries(trends)
            .filter(([key]) => key !== 'success' && key !== 'timestamp')
            .flatMap(([category, keywords]) =>
                keywords.map(keyword => ({ category, keyword }))
            );

        const csv = [
            'Category,Keyword',
            ...records.map(record => `${record.category},${record.keyword}`)
        ].join('\n');

        res.header('Content-Type', 'text/csv');
        res.attachment('trends_export.csv');
        res.send(csv);
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

// Export for Vercel serverless
module.exports = app;