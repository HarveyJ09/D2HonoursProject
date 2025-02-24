import http.server
import ssl
from urllib.parse import urlparse, parse_qs
from requests_oauthlib import OAuth2Session
from dotenv import load_dotenv
import os

load_dotenv()

# Load environment variables
api_key = os.getenv("API_KEY")
client_id = os.getenv("CLIENT_ID")
client_secret = os.getenv("CLIENT_SECRET")

# Bungie API URLs
base_auth_url = "https://www.bungie.net/en/OAuth/Authorize"
redirect_url = "https://localhost:3000/auth/callback"
token_url = "https://www.bungie.net/platform/app/oauth/token/"
get_user_details_endpoint = "https://www.bungie.net/Platform/User/GetCurrentBungieNetUser/"

# Create OAuth2 session
session = OAuth2Session(client_id=client_id, redirect_uri=redirect_url)

# Generate auth link
auth_link, state = session.authorization_url(base_auth_url)
print(f"Click the link to authenticate: {auth_link}")

PORT = 3000

class RequestHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed_path = urlparse(self.path)

        if parsed_path.path == "/auth/callback":
            # Parse query parameters
            query_params = parse_qs(parsed_path.query)
            auth_code = query_params.get("code", [None])[0]

            if not auth_code:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Missing authorization code")
                return

            # Exchange code for access token
            token = session.fetch_token(
                token_url=token_url,
                client_id=client_id,
                client_secret=client_secret,
                code=auth_code
            )

            # Fetch user details
            headers = {'X-API-KEY': api_key}
            response = session.get(url=get_user_details_endpoint, headers=headers)

            # Respond with user details
            self.send_response(200)
            self.send_header("Content-type", "text/html")
            self.end_headers()
            self.wfile.write(f"<html><body><h1>Authentication Successful</h1><p>{response.text}</p></body></html>".encode())

        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"404 Not Found")

# Set up HTTPS server
server_address = ('0.0.0.0', PORT)
httpd = http.server.HTTPServer(server_address, RequestHandler)

CERT_FILE = "certs/server.cert"
KEY_FILE = "certs/server.key"

# Create an SSL context
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)

# Wrap the server socket
httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

print(f"Serving on https://localhost:{PORT}")
httpd.serve_forever()
