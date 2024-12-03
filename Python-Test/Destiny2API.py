from flask import Flask, redirect, request, url_for, render_template
from requests_oauthlib import OAuth2Session
from dotenv import load_dotenv
import os

app = Flask(__name__)

# Load environment variables from .env file
load_dotenv()

# Retrieve environment variables
api_key = os.getenv('API_KEY')
client_id = os.getenv('CLIENT_ID')
client_secret = os.getenv('CLIENT_SECRET')

# Define URLs
base_auth_url = 'https://www.bungie.net/en/OAuth/Authorize'
redirect_url = 'http://localhost:5000/callback'
token_url = 'https://www.bungie.net/platform/app/oauth/token/'
get_user_details_endpoint = 'https://www.bungie.net/Platform/User/GetCurrentBungieNetUser/'

@app.route('/')
def index():
    return render_template('main.html')

@app.route('/login')
def login():
    session = OAuth2Session(client_id, redirect_uri=redirect_url)
    auth_link, state = session.authorization_url(base_auth_url)
    return redirect(auth_link)

@app.route('/callback')
def callback():
    session = OAuth2Session(client_id, redirect_uri=redirect_url)
    session.fetch_token(
        token_url=token_url,
        client_id=client_id,
        client_secret=client_secret,
        authorization_response=request.url
    )
    additional_headers = {'X-API-KEY': api_key}
    response = session.get(url=get_user_details_endpoint, headers=additional_headers)
    user_data = response.json()
    return render_template('main.html', user_data=user_data)

if __name__ == '__main__':
    app.run(debug=True)