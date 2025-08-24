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

// API endpoint to get trends
app.get('/api/trends', async (req, res) => {
    try {
        const countries = {
            'kenya': 'KE',
            'us': 'US',
            'uk': 'GB'
        };

        const results = {};

        // Get trends for each country
        for (const [key, countryCode] of Object.entries(countries)) {
            try {
                const trendsData = await googleTrends.dailyTrends({
                    trendDate: new Date(),
                    geo: countryCode,
                });

                const parsed = JSON.parse(trendsData);
                const trends = parsed.default.trendingSearchesDays[0]?.trendingSearches || [];
                
                results[key] = trends
                    .slice(0, 15)
                    .map(trend => trend.title.query);

                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.log(`Error getting trends for ${key}:`, error.message);
                results[key] = [];
            }
        }

        res.json({
            success: true,
            ...results
        });

    } catch (error) {
        console.error('Error:', error);
        res.json({
            success: false,
            error: error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Trends Platform running on http://localhost:${PORT}`);
});