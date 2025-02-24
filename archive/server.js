require('dotenv').config(); // Load .env variables at the very top

console.log("API_KEY:", process.env.API_KEY);
console.log("CLIENT_ID:", process.env.CLIENT_ID);
console.log("CLIENT_SECRET:", process.env.CLIENT_SECRET);
console.log("REDIRECT_URI:", process.env.REDIRECT_URI);

const https = require('https');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Load HTTPS certificates
const options = {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'server.key')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'server.cert'))
};

// Bungie API credentials
const API_KEY = process.env.API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// Hardcoded membership ID
const HARDCODED_MEMBERSHIP_TYPE = "3"; // Bungie Membership Type: 3 (Steam)
const HARDCODED_MEMBERSHIP_ID = "4611686018489102995";

app.use(express.static('public'));

// Step 1: Redirect User to Bungie's OAuth Page
app.get('/auth', (req, res) => {
    const authUrl = `https://www.bungie.net/en/OAuth/Authorize?client_id=${CLIENT_ID}&response_type=code`;
    res.redirect(authUrl);
});

// Step 2: Handle Bungie OAuth Callback
app.get('/auth/callback', async (req, res) => {
    const code = req.query.code;

    if (!code) {
        return res.status(400).send("Missing authorization code.");
    }

    try {
        console.log("Authorization Code Received:", code);

        // Request Access Token from Bungie
        const tokenResponse = await axios.post(
            'https://www.bungie.net/platform/app/oauth/token/', 
            new URLSearchParams({
                grant_type: "authorization_code",
                code: code,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token } = tokenResponse.data; // Ignore returned membership_id

        console.log("Access Token Received:", access_token);
        console.log("Using Hardcoded Membership ID:", HARDCODED_MEMBERSHIP_ID);

        // Redirect user to dashboard.html with the hardcoded membership ID
        res.redirect(`/dashboard.html?access_token=${access_token}&membership_id=${HARDCODED_MEMBERSHIP_ID}`);

    } catch (error) {
        console.error("Error exchanging token:", error.response?.data || error.message);
        res.status(500).send("Authentication failed.");
    }
});

// Step 4: Fetch User Profile Data
app.get('/get-profile', async (req, res) => {
    const { access_token } = req.query;
    
    if (!access_token) {
        return res.status(400).send('Missing access_token');
    }

    try {
        const profileResponse = await axios.get(`https://www.bungie.net/Platform/Destiny2/${HARDCODED_MEMBERSHIP_TYPE}/Profile/${HARDCODED_MEMBERSHIP_ID}/?components=100`, {
            headers: {
                'X-API-Key': API_KEY,
                'Authorization': `Bearer ${access_token}`
            }
        });

        res.json(profileResponse.data);
    } catch (error) {
        console.error('Error fetching profile:', error.response?.data || error.message);
        res.status(500).send('Failed to fetch profile data');
    }
});

app.use(express.static('public'));

// Redirect to dashboard.html with query parameters
app.get('/dashboard', (req, res) => {
    const { access_token } = req.query;

    if (!access_token) {
        return res.redirect('/auth'); // Redirect to login if missing
    }

    // Redirect user to dashboard.html with query parameters and hardcoded membership ID
    res.redirect(`/dashboard.html?access_token=${access_token}&membership_id=${HARDCODED_MEMBERSHIP_ID}`);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start HTTPS Server
const PORT = 3000;
https.createServer(options, app).listen(PORT, () => {
    console.log(`Server running at https://localhost:${PORT}`);
});
