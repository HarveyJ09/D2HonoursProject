require('dotenv').config();
const express = require('express');
const https = require('https');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const session = require('express-session');
const { AuthorizationCode } = require('simple-oauth2');

const app = express();
const PORT = 3000;

// Serve static files from the public directory
app.use(express.static('public'));

app.use(session({
    secret: 'password', // Change this to a strong secret key
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Change to true if using HTTPS in production
}));

// Load environment variables
const API_KEY = process.env.API_KEY;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Bungie API URLs
const BASE_AUTH_URL = "https://www.bungie.net/en/OAuth/Authorize";
const REDIRECT_URL = "https://localhost:3000/auth/callback";
const TOKEN_URL = "https://www.bungie.net/platform/app/oauth/token/";
const GET_USER_PROFILE_URL = "https://www.bungie.net/Platform/Destiny2/{membershipType}/Profile/{membershipId}/?components=200";
const GET_USER_DETAILS_ENDPOINT = "https://www.bungie.net/Platform/User/GetCurrentBungieNetUser/";


// OAuth2 Configuration
const oauth2 = new AuthorizationCode({
    client: { id: CLIENT_ID, secret: CLIENT_SECRET },
    auth: { tokenHost: 'https://www.bungie.net', authorizePath: '/en/OAuth/Authorize', tokenPath: '/platform/app/oauth/token/' },
    options: { authorizationMethod: 'body' }
});

const authUrl = oauth2.authorizeURL({ redirect_uri: REDIRECT_URL });

// Serve authentication link on homepage
app.get('/', (req, res) => {
    res.send(`<html><body><h1>Welcome</h1><p><a href="${authUrl}">Click here to authenticate with Bungie</a></p></body></html>`);
});

// Authentication Callback
app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) {
        return res.status(400).send("Missing authorization code");
    }

    try {
        const tokenParams = { code, redirect_uri: REDIRECT_URL, scope: "" };
        const accessToken = await oauth2.getToken(tokenParams);

        // Store token in session
        req.session.accessToken = accessToken.token.access_token;

        // Fetch user details
        const response = await axios.get(GET_USER_DETAILS_ENDPOINT, {
            headers: { 
                'X-API-KEY': API_KEY, 
                Authorization: `Bearer ${accessToken.token.access_token}`
            }
        });

        const userName = response.data.Response.uniqueName;
        req.session.destinyMembershipId = response.data.Response.membershipId; // Store membership ID

        // Redirect to dashboard with username
        res.redirect(`/dashboard.html?user=${encodeURIComponent(userName)}`);
    } catch (error) {
        console.error("Error exchanging code for token:", error.response ? error.response.data : error.message);
        res.status(500).send("Authentication failed");
    }
});

app.get('/api/characters', async (req, res) => {
    if (!req.session.accessToken) {
        return res.status(401).json({ error: "Not authenticated" });
    }

    try {
        const membershipResponse = await axios.get("https://www.bungie.net/Platform/User/GetMembershipsForCurrentUser/", {
            headers: { 
                'X-API-KEY': API_KEY, 
                Authorization: `Bearer ${req.session.accessToken}`
            }
        });

        const memberships = membershipResponse.data.Response.destinyMemberships;
        if (!memberships || memberships.length === 0) {
            return res.status(500).json({ error: "No Destiny memberships found" });
        }

        const { membershipId, membershipType } = memberships[0];

        const profileUrl = `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=100`;

        const profileResponse = await axios.get(profileUrl, {
            headers: { 
                'X-API-KEY': API_KEY, 
                Authorization: `Bearer ${req.session.accessToken}`
            }
        });

        if (!profileResponse.data.Response.profile || !profileResponse.data.Response.profile.data.characterIds) {
            return res.status(500).json({ error: "Failed to retrieve character data" });
        }

        const characterIds = profileResponse.data.Response.profile.data.characterIds;

        // ✅ Store in session
        req.session.membershipId = membershipId;
        req.session.membershipType = membershipType;
        req.session.characterIds = characterIds;

        console.log("Stored in session:", {
            membershipId,
            membershipType,
            characterIds
        });

        // Fetch character data for Hunter, Warlock, and Titan
        let characterData = {
            hunter: null,
            warlock: null,
            titan: null
        };

        const characterRoles = ["hunter", "warlock", "titan"];

        for (let i = 0; i < characterIds.length; i++) {
            const characterId = characterIds[i];
            const characterRole = characterRoles[i]; // Maps characterIds[0] -> hunter, [1] -> warlock, [2] -> titan

            const characterUrl = `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Character/${characterId}/?components=200`;

            try {
                const characterResponse = await axios.get(characterUrl, {
                    headers: { 
                        'X-API-KEY': API_KEY, 
                        Authorization: `Bearer ${req.session.accessToken}`
                    }
                });

                if (characterResponse.data.Response && characterResponse.data.Response.character) {
                    characterData[characterRole] = characterResponse.data.Response.character.data;
                }
            } catch (characterError) {
                console.error(`Error fetching ${characterRole} data:`, characterError.response ? characterError.response.data : characterError.message);
            }
        }

        res.json({ characterIds, membershipType, membershipId, characterData });

    } catch (error) {
        console.error("Error fetching character data:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to retrieve character data" });
    }
});

app.get('/api/vault', async (req, res) => {
    try {
        const { membershipId, membershipType } = req.session;

        console.log(`Fetching vault for membershipId: ${membershipId}, membershipType: ${membershipType}`);

        const profileUrl = `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=102`;
        const profileResponse = await axios.get(profileUrl, {
            headers: {
                'X-API-KEY': API_KEY,
                Authorization: `Bearer ${req.session.accessToken}`
            }
        });

        if (!profileResponse.data.Response.profileInventory) {
            return res.status(500).json({ error: "Failed to retrieve vault data" });
        }

        const vaultItems = profileResponse.data.Response.profileInventory.data.items || [];
        const itemHashes = vaultItems.map(item => item.itemHash);

        console.log(`Fetching definitions for ${itemHashes.length} items...`);

        // Fetch all item definitions in parallel using Promise.all
        const definitionsPromises = itemHashes.map(hash => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(definitionResponse => {
                if (definitionResponse.data.Response) {
                    return {
                        hash: hash,
                        icon: `https://www.bungie.net${definitionResponse.data.Response.displayProperties.icon}`
                    };
                }
            }).catch(err => {
                console.error(`Error fetching definition for item ${hash}:`, err.message);
            })
        );

        const itemDefinitions = await Promise.all(definitionsPromises);

        // Map the fetched definitions to the vault items
        const vaultWithImages = vaultItems.map(item => {
            const definition = itemDefinitions.find(def => def.hash === item.itemHash);
            return {
                itemHash: item.itemHash,
                quantity: item.quantity,
                icon: definition ? definition.icon : null
            };
        });

        console.log(`Returning ${vaultWithImages.length} items with images.`);
        res.json({ vaultItems: vaultWithImages });

    } catch (error) {
        console.error("Error fetching vault data:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to retrieve vault data" });
    }
});


app.use((req, res, next) => {
    console.log("Session Data at Request:", req.session);
    next();
});


app.get('/character-data', async (req, res) => {
    try {
        if (!req.session.accessToken || !req.session.membershipId || !req.session.membershipType) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const { accessToken, membershipId, membershipType } = req.session;

        // Get Profile Data (To Retrieve Character IDs)
        const profileResponse = await axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=100`, {
            headers: {
                'X-API-KEY': API_KEY,
                'Authorization': `Bearer ${accessToken}`
            }
        });

        const characterIds = profileResponse.data.Response.profile.data.characterIds;

        if (!characterIds || characterIds.length === 0) {
            return res.status(404).json({ error: "No characters found" });
        }

        // Extract IDs (Assuming order: Hunter, Warlock, Titan)
        const characterData = {
            hunter: characterIds[0] || null,
            warlock: characterIds[1] || null,
            titan: characterIds[2] || null
        };

        console.log("Character IDs:", characterData); // Output to console

        res.json(characterData);
    } catch (error) {
        console.error("Error fetching character data:", error);
        res.status(500).json({ error: "Failed to fetch character data" });
    }
});


// Load SSL certificates
const options = {
    key: fs.readFileSync('certs/server.key'),
    cert: fs.readFileSync('certs/server.cert')
};

https.createServer(options, app).listen(PORT, () => {
    console.log(`Serving on https://localhost:${PORT}`);
});
