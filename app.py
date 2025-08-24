from flask import Flask, jsonify, render_template_string
from pytrends.request import TrendReq
import time

app = Flask(__name__)

def get_trends(country):
    try:
        pytrends = TrendReq(hl='en-US', tz=360)
        trending = pytrends.trending_searches(pn=country)
        return trending[0].head(15).tolist()
    except:
        return []

@app.route('/')
def index():
    with open('index.html', 'r') as f:
        return f.read()

@app.route('/api/trends')
def trends():
    try:
        countries = {
            'kenya': 'kenya',
            'us': 'united_states', 
            'uk': 'united_kingdom'
        }
        
        results = {}
        for key, country in countries.items():
            results[key] = get_trends(country)
            time.sleep(1)  # Avoid rate limits
        
        return jsonify({
            'success': True,
            **results
        })
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e)
        })

if __name__ == '__main__':
    app.run(debug=True, port=5000)