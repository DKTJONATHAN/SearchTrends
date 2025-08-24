const express = require('express');
const googleTrends = require('google-trends-api');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('.'));

// Serve the HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Function to get real trends data
async function getRealTrends(countryCode, countryName) {
    try {
        console.log(`🔍 Fetching real trends for ${countryName} (${countryCode})...`);
        
        // Try different methods to get trends
        
        // Method 1: Daily Trends (most reliable)
        try {
            const trendsData = await googleTrends.dailyTrends({
                trendDate: new Date(),
                geo: countryCode,
            });

            const parsed = JSON.parse(trendsData);
            const trendingSearches = parsed.default?.trendingSearchesDays?.[0]?.trendingSearches;
            
            if (trendingSearches && trendingSearches.length > 0) {
                const trends = trendingSearches
                    .slice(0, 15)
                    .map(trend => trend.title.query)
                    .filter(title => title && title.length > 0);
                
                if (trends.length > 0) {
                    console.log(`✅ Daily trends success for ${countryName}: ${trends.length} items`);
                    return trends;
                }
            }
        } catch (dailyError) {
            console.log(`⚠️ Daily trends failed for ${countryName}:`, dailyError.message);
        }

        // Method 2: Real-time trends
        try {
            const realTimeData = await googleTrends.realTimeTrends({
                geo: countryCode,
                category: 'all'
            });

            const parsed = JSON.parse(realTimeData);
            let trends = [];
            
            if (parsed.storySummaries?.trendingStories) {
                trends = parsed.storySummaries.trendingStories
                    .slice(0, 15)
                    .map(story => story.title)
                    .filter(title => title && title.length > 0);
            }
            
            if (trends.length > 0) {
                console.log(`✅ Real-time trends success for ${countryName}: ${trends.length} items`);
                return trends;
            }
        } catch (realTimeError) {
            console.log(`⚠️ Real-time trends failed for ${countryName}:`, realTimeError.message);
        }

        // Method 3: Interest over time for popular keywords (last resort)
        try {
            const popularKeywords = ['news', 'weather', 'sports', 'entertainment', 'technology'];
            const keywordData = await googleTrends.interestOverTime({
                keyword: popularKeywords,
                geo: countryCode,
                startTime: new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)), // Last 7 days
            });

            const parsed = JSON.parse(keywordData);
            if (parsed.default?.timelineData) {
                // This won't give trending searches but confirms API is working
                console.log(`📊 Interest data available for ${countryName}, but no trending searches found`);
            }
        } catch (interestError) {
            console.log(`⚠️ Interest over time failed for ${countryName}:`, interestError.message);
        }

        console.log(`❌ No real trends data available for ${countryName}`);
        return [];

    } catch (error) {
        console.error(`❌ All methods failed for ${countryName}:`, error.message);
        return [];
    }
}

// API endpoint to get trends
app.get('/api/trends', async (req, res) => {
    try {
        console.log('🚀 Starting trends fetch...');
        
        const countries = [
            { key: 'kenya', code: 'KE', name: 'Kenya' },
            { key: 'us', code: 'US', name: 'United States' },
            { key: 'uk', code: 'GB', name: 'United Kingdom' }
        ];

        const results = {};
        let hasData = false;

        for (const country of countries) {
            const trends = await getRealTrends(country.code, country.name);
            results[country.key] = trends;
            
            if (trends.length > 0) {
                hasData = true;
            }

            // Wait between requests to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        if (!hasData) {
            return res.json({
                success: false,
                error: 'Unable to fetch real trends data from Google. This could be due to rate limiting, API changes, or temporary service issues. Please try again in a few minutes.'
            });
        }

        console.log('✅ Trends fetch completed successfully');
        
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            ...results
        });

    } catch (error) {
        console.error('❌ Critical error:', error);
        res.json({
            success: false,
            error: `Failed to connect to Google Trends API: ${error.message}`
        });
    }
});

// Test endpoint to verify API connectivity
app.get('/api/test', async (req, res) => {
    try {
        // Test with a simple trends query
        const testData = await googleTrends.dailyTrends({
            trendDate: new Date(),
            geo: 'US',
        });
        
        res.json({
            success: true,
            message: 'Google Trends API is accessible',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.json({
            success: false,
            message: 'Google Trends API connection failed',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Trends Platform running on http://localhost:${PORT}`);
    console.log(`🧪 Test API connectivity: http://localhost:${PORT}/api/test`);
    console.log(`📊 Real trends endpoint: http://localhost:${PORT}/api/trends`);
});