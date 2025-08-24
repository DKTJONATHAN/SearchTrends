const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const UserAgent = require('user-agents');
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

// Function to scrape Google Trends directly
async function scrapeTrends(countryCode, countryName) {
    try {
        console.log(`🔍 Scraping trends for ${countryName}...`);
        
        const userAgent = new UserAgent();
        const headers = {
            'User-Agent': userAgent.toString(),
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

// Alternative: Use RSS feeds from Google News (more reliable)
async function getNewsTopics(countryCode, countryName) {
    try {
        console.log(`📰 Getting news topics for ${countryName}...`);
        
        const userAgent = new UserAgent();
        const headers = {
            'User-Agent': userAgent.toString(),
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

// API endpoint to get trends
app.get('/api/trends', async (req, res) => {
    try {
        console.log('🚀 Starting real data fetch...');
        
        const countries = [
            { key: 'kenya', code: 'KE', name: 'Kenya' },
            { key: 'us', code: 'US', name: 'United States' },
            { key: 'uk', code: 'GB', name: 'United Kingdom' }
        ];

        const results = {};
        let totalFound = 0;

        for (const country of countries) {
            console.log(`\n--- Processing ${country.name} ---`);
            
            // Try scraping first
            let trends = await scrapeTrends(country.code, country.name);
            
            // If scraping fails, try news topics
            if (trends.length === 0) {
                trends = await getNewsTopics(country.code, country.name);
            }
            
            results[country.key] = trends;
            totalFound += trends.length;
            
            // Wait between requests
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        if (totalFound === 0) {
            return res.json({
                success: false,
                error: 'Unable to fetch any real data. Google may be blocking requests or their structure has changed. This is a common issue with Google Trends scraping.'
            });
        }

        console.log(`✅ Successfully found ${totalFound} total trends across all countries`);
        
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            total_trends: totalFound,
            method: 'web_scraping',
            ...results
        });

    } catch (error) {
        console.error('❌ Critical error:', error);
        res.json({
            success: false,
            error: `System error: ${error.message}`
        });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Real Trends Platform running on http://localhost:${PORT}`);
    console.log(`🔍 Using web scraping method for real Google data`);
    console.log(`💡 This may take 10-15 seconds per request to avoid detection`);
});