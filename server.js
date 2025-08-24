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

// Logger setup - Console only for Vercel (no file system writes)
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
    max: 100,
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/', limiter);

// Mock data fallback
const mockData = {
    kenya: ['Safaricom', 'M-Pesa Innovation', 'Nairobi Tech Hub', 'Kenya Airways', 'Tusker Beer', 'KCB Bank', 'Equity Bank', 'Kenyan Startups', 'Safari Tourism', 'Maasai Culture'],
    worldwide: ['AI Revolution', 'Climate Action', 'Web3 Technology', 'Space Exploration', 'Green Energy', 'Digital Transformation', 'Sustainable Development', 'Global Health', 'Remote Work', 'Cryptocurrency'],
    xtrends: ['#AI', '#Climate', '#Crypto', '#Tech', '#Innovation', '#Sustainability', '#Web3', '#Health', '#Education', '#Entertainment'],
    news: ['Global Elections', 'Climate Summit', 'Tech Regulations', 'International Trade', 'Health Updates', 'Economic Recovery', 'Political Changes', 'Social Issues', 'Environmental News', 'Breaking Headlines'],
    technology: ['ChatGPT', 'Blockchain', 'Virtual Reality', 'Quantum Computing', '5G Networks', 'Internet of Things', 'Cybersecurity', 'Cloud Computing', 'Machine Learning', 'Robotics'],
    entertainment: ['Netflix Originals', 'Spotify Playlists', 'Gaming Trends', 'Movie Releases', 'Music Charts', 'Celebrity News', 'TV Shows', 'Streaming Wars', 'Social Media', 'Viral Content'],
    sports: ['Football World Cup', 'NBA Season', 'Tennis Grand Slam', 'Olympics Prep', 'Marathon Events', 'Premier League', 'Basketball Finals', 'Golf Championships', 'Athletics Records', 'Sports Technology'],
    lifestyle: ['Wellness Trends', 'Travel Destinations', 'Fashion Week', 'Food Culture', 'Fitness Challenges', 'Home Design', 'Sustainable Living', 'Mental Health', 'Productivity Tips', 'Life Hacks'],
    business: ['Startup Funding', 'Stock Market', 'E-commerce Growth', 'Financial Technology', 'Market Analysis', 'Investment Trends', 'Business Strategy', 'Entrepreneurship', 'Corporate News', 'Economic Indicators'],
    health: ['Mental Wellness', 'Nutrition Science', 'Exercise Routines', 'Medical Breakthroughs', 'Healthcare Technology', 'Pandemic Recovery', 'Preventive Care', 'Health Apps', 'Fitness Trends', 'Wellness Programs'],
    science: ['Space Missions', 'Climate Research', 'Physics Discoveries', 'Biotechnology', 'Scientific Studies', 'Research Breakthroughs', 'Environmental Science', 'Medical Research', 'Technology Innovation', 'Data Science'],
    fashion: ['Sustainable Fashion', 'Street Style', 'Luxury Brands', 'Fashion Trends', 'Designer Collaborations', 'Fashion Technology', 'Vintage Revival', 'Minimalist Style', 'Cultural Fashion', 'Eco-Friendly Clothing']
};

// Fetch NewsAPI topics with better error handling
async function getNewsTopics(category, categoryName) {
    try {
        const apiKey = process.env.NEWSAPI_KEY;
        if (!apiKey) {
            logger.warn(`NEWSAPI_KEY not configured for ${categoryName}`);
            return mockData[category] || [];
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
        
        if (response.data && response.data.articles) {
            const trends = response.data.articles
                .map(article => {
                    if (!article.title) return null;
                    return article.title.split(' - ')[0].trim();
                })
                .filter(title => title && title.length > 5 && title.length < 80)
                .slice(0, 10);
            
            return trends.length > 0 ? trends : mockData[category] || [];
        }
        
        return mockData[category] || [];
    } catch (error) {
        logger.error(`NewsAPI failed for ${categoryName}: ${error.message}`);
        return mockData[category] || [];
    }
}

// Fetch X Trends with improved error handling
async function getXTrends() {
    try {
        const bearerToken = process.env.X_API_BEARER_TOKEN;
        if (!bearerToken) {
            logger.warn('X_API_BEARER_TOKEN not configured');
            return mockData.xtrends;
        }
        
        const response = await axios.get('https://api.twitter.com/2/trends/place/1', {
            headers: { 
                'Authorization': `Bearer ${bearerToken}`,
                'User-Agent': 'TrendScope/1.0'
            },
            timeout: 8000
        });
        
        if (response.data && response.data.trends) {
            const trends = response.data.trends
                .map(trend => trend.name)
                .filter(name => name && name.length > 0 && name.length < 50)
                .slice(0, 10);
            
            return trends.length > 0 ? trends : mockData.xtrends;
        }
        
        return mockData.xtrends;
    } catch (error) {
        logger.error(`X Trends failed: ${error.message}`);
        return mockData.xtrends;
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    try {
        res.status(200).json({
            success: true,
            message: 'TrendScope server running',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development'
        });
    } catch (error) {
        logger.error(`Health check failed: ${error.message}`);
        res.status(500).json({
            success: false,
            error: 'Health check failed'
        });
    }
});

// API endpoint to get trends
app.get('/api/trends', async (req, res) => {
    try {
        // Check cache first
        const cached = cache.get('trends');
        if (cached) {
            logger.info('Returning cached trends');
            return res.status(200).json(cached);
        }

        logger.info('Fetching fresh trends...');

        const categories = [
            { key: 'kenya', code: null, name: 'Kenya', type: 'mock' },
            { key: 'worldwide', code: null, name: 'Worldwide', type: 'mock' },
            { key: 'xtrends', code: null, name: 'X Trends', type: 'x' },
            { key: 'news', code: 'general', name: 'News', type: 'news' },
            { key: 'technology', code: 'technology', name: 'Technology', type: 'news' },
            { key: 'entertainment', code: 'entertainment', name: 'Entertainment', type: 'news' },
            { key: 'sports', code: 'sports', name: 'Sports', type: 'news' },
            { key: 'lifestyle', code: 'health', name: 'Lifestyle', type: 'news' },
            { key: 'business', code: 'business', name: 'Business', type: 'news' },
            { key: 'health', code: 'health', name: 'Health', type: 'news' },
            { key: 'science', code: 'science', name: 'Science', type: 'news' },
            { key: 'fashion', code: 'entertainment', name: 'Fashion', type: 'news' }
        ];

        const results = {};
        const fetchPromises = categories.map(async (category) => {
            try {
                let trends = [];
                
                if (category.type === 'mock') {
                    trends = mockData[category.key] || [];
                } else if (category.type === 'news') {
                    trends = await getNewsTopics(category.code, category.name);
                } else if (category.type === 'x') {
                    trends = await getXTrends();
                }
                
                results[category.key] = trends.length ? trends : mockData[category.key] || [];
            } catch (error) {
                logger.error(`Error fetching ${category.name}: ${error.message}`);
                results[category.key] = mockData[category.key] || [];
            }
        });

        // Wait for all requests with timeout
        await Promise.allSettled(fetchPromises);

        const response = {
            success: true,
            timestamp: new Date().toISOString(),
            cached: false,
            ...results
        };

        // Cache the results
        cache.set('trends', response);
        logger.info('Fresh trends fetched and cached');
        
        res.status(200).json(response);
    } catch (error) {
        logger.error(`Critical error in /api/trends: ${error.message}`);
        
        // Return mock data on critical error
        const fallbackResponse = {
            success: true,
            timestamp: new Date().toISOString(),
            cached: false,
            fallback: true,
            ...mockData
        };
        
        res.status(200).json(fallbackResponse);
    }
});

// Export trends as CSV
app.get('/api/export', async (req, res) => {
    try {
        const trends = cache.get('trends');
        
        if (!trends || !trends.success) {
            return res.status(404).json({ 
                success: false, 
                error: 'No trends data available. Please fetch trends first.' 
            });
        }

        const records = Object.entries(trends)
            .filter(([key]) => !['success', 'timestamp', 'cached', 'fallback'].includes(key))
            .flatMap(([category, keywords]) => {
                if (Array.isArray(keywords)) {
                    return keywords.map(keyword => ({ 
                        category: category.charAt(0).toUpperCase() + category.slice(1), 
                        keyword: keyword.replace(/,/g, ';') // Replace commas to avoid CSV issues
                    }));
                }
                return [];
            });

        if (records.length === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'No trend data to export' 
            });
        }

        const csv = [
            'Category,Keyword,Timestamp',
            ...records.map(record => 
                `"${record.category}","${record.keyword}","${trends.timestamp}"`
            )
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="trendscope-trends.csv"');
        res.status(200).send(csv);
        
        logger.info(`CSV export generated with ${records.length} records`);
    } catch (error) {
        logger.error(`Export failed: ${error.message}`);
        res.status(500).json({ 
            success: false, 
            error: 'Export generation failed' 
        });
    }
});

// Serve static files for non-API routes (Vercel will handle this)
app.get('*', (req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Route not found',
        availableRoutes: ['/api/health', '/api/trends', '/api/export']
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

// Only listen on port when not in production (for local development)
if (process.env.NODE_ENV !== 'production') {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        logger.info(`TrendScope server running on port ${PORT}`);
    });
}

// Export for Vercel serverless functions
module.exports = app;