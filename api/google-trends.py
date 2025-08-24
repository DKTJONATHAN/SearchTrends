from http.server import BaseHTTPRequestHandler
import json
from urllib.parse import urlparse, parse_qs
from pytrends.request import TrendReq
import logging

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            # Parse URL parameters
            url_parts = urlparse(self.path)
            query_params = parse_qs(url_parts.query)
            
            region = query_params.get('region', ['KE'])[0]
            
            # Initialize PyTrends
            pytrends = TrendReq(hl='en-US', tz=180)  # Kenya timezone
            
            # Map region codes to country names (PyTrends requires country names)
            region_mapping = {
                'KE': 'kenya',
                'US': 'united_states',
                'UK': 'united_kingdom',
                'CA': 'canada',
                'AU': 'australia'
            }
            
            country_name = region_mapping.get(region, 'united_states')
            
            # Get trending searches for the region
            trending_searches = pytrends.trending_searches(pn=country_name)
            
            # Convert to list (PyTrends returns DataFrame)
            trends_list = trending_searches[0].tolist() if not trending_searches.empty else []
            
            # Limit to top 10
            trends_list = trends_list[:10]
            
            response_data = {
                'success': True,
                'region': region,
                'trends': trends_list,
                'count': len(trends_list),
                'timestamp': str(pytrends._get_data.__name__ if hasattr(pytrends, '_get_data') else 'N/A')
            }
            
            # Send response
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(response_data).encode())
            
        except Exception as e:
            # Error response
            error_response = {
                'success': False,
                'error': str(e),
                'region': region if 'region' in locals() else 'unknown'
            }
            
            self.send_response(500)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(error_response).encode())
    
    def do_OPTIONS(self):
        # Handle CORS preflight
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()