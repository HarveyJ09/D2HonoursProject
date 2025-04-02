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

app.get('/auth/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error("Error clearing session:", err);
            return res.status(500).json({ error: "Failed to clear session" });
        }
        res.send("Authorization token cleared. You have been logged out.");
    });
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

app.get('/api/hunterinventory', async (req, res) => {
    try {
        const { membershipId, membershipType, characterIds } = req.session;
        
        if (!membershipId || !membershipType || !characterIds) {
            return res.status(400).json({ error: "Missing session data. Ensure you have fetched characters first." });
        }

        const hunterCharacterId = characterIds[0]; // Assuming characterIds[0] is the Hunter
        
        if (!hunterCharacterId) {
            return res.status(500).json({ error: "Hunter character ID not found." });
        }

        console.log(`Fetching inventory for membershipId: ${membershipId}, membershipType: ${membershipType}, characterId: ${hunterCharacterId}`);

        const profileUrl = `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=201`;
        const characterInventoryResponse = await axios.get(profileUrl, {
            headers: {
                'X-API-KEY': API_KEY,
                Authorization: `Bearer ${req.session.accessToken}`
            }
        });

        console.log(`Character Inventory Response for ${hunterCharacterId}:`, characterInventoryResponse.data);

        const characterInventoryData = characterInventoryResponse.data.Response.characterInventories.data[hunterCharacterId];
        if (!characterInventoryData) {
            return res.status(500).json({ error: "Failed to retrieve inventory data" });
        }

        const inventoryItems = characterInventoryData.items || [];
        const itemHashes = inventoryItems.map(item => item.itemHash);
        const itemInstanceIds = inventoryItems.map(item => item.itemInstanceId).filter(id => id); // Remove null values

        console.log(`Fetching definitions for ${itemHashes.length} items...`);

        // Fetch all item definitions in parallel using Promise.all
        const definitionsPromises = itemHashes.map(hash => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(definitionResponse => {
                if (definitionResponse.data.Response) {
                    return {
                        name: definitionResponse.data.Response.displayProperties.name,
                        hash: hash,
                        
                        icon: `https://www.bungie.net${definitionResponse.data.Response.displayProperties.icon}`
                    };
                }
            }).catch(err => {
                console.error(`Error fetching definition for item ${hash}:`, err.message);
            })
        );
        const itemDefinitions = await Promise.all(definitionsPromises);

        // Fetch item light levels (primaryStat value) for each item instance
        const lightLevelPromises = itemInstanceIds.map(instanceId => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${instanceId}/?components=300,307`, {
                headers: { 'X-API-KEY': API_KEY, Authorization: `Bearer ${req.session.accessToken}` }
            }).then(itemResponse => {
                const itemData = itemResponse.data.Response;
                if (itemData?.instance?.data?.primaryStat) {
                    return {
                        itemInstanceId: instanceId,
                        bucketHash: itemData.item.data.bucketHash,
                        lightLevel: itemData.instance.data.primaryStat.value, // Get the light level
                        damageType: itemData.instance.data.damageTypeHash
                    };
                }
                return null; // If no light level is found
            }).catch(err => {
                console.error(`Error fetching light level for item ${instanceId}:`, err.message);
                return null;
            })
        );
        
        const lightLevels = await Promise.all(lightLevelPromises);

        const damageTypePromises = lightLevels
            .filter(data => data?.damageType) // Ensure damageType exists
            .map(data =>
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyDamageTypeDefinition/${data.damageType}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(damageResponse => {
                if (damageResponse.data.Response) {
                return {
                    damageTypeHash: data.damageType,
                    damageTypeName: damageResponse.data.Response.displayProperties.name,
                    damageTypeIcon: `https://www.bungie.net${damageResponse.data.Response.displayProperties.icon}`
                };
                }
            }).catch(err => {
                console.error(`Error fetching damage type for hash ${data.damageType}:`, err.message);
            })
            );

        const damageTypeDefinitions = await Promise.all(damageTypePromises);

        // Map the fetched definitions and light levels to the inventory items
        const inventoryWithImagesAndLightLevels = inventoryItems
            .map(item => {
                const definition = itemDefinitions.find(def => def.hash === item.itemHash);
                const lightLevelData = lightLevels.find(data => data?.itemInstanceId === item.itemInstanceId);
                const damageTypeData = damageTypeDefinitions.find(data => data?.damageTypeHash === lightLevelData?.damageType);
                return {
                    name: definition ? definition.name : null,
                    dName: damageTypeData ? damageTypeData.damageTypeName : null,
                    dIcon: damageTypeData ? damageTypeData.damageTypeIcon : null,
                    itemHash: item.itemHash,
                    quantity: item.quantity,
                    itemInstanceId: item.itemInstanceId,
                    bucketHash: lightLevelData ? lightLevelData.bucketHash : null,
                    icon: definition ? definition.icon : null,
                    lightLevel: lightLevelData ? lightLevelData.lightLevel : null
                };
            })
            .filter(item => item.icon && item.lightLevel !== null); // Remove items without icon or light level

        console.log(`Returning ${inventoryWithImagesAndLightLevels.length} hunter items with images and light levels.`);
        res.json({ inventoryItems: inventoryWithImagesAndLightLevels });

    } catch (error) {
        console.error("Error fetching inventory data:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to retrieve inventory data" });
    }
});


app.get('/api/warlockinventory', async (req, res) => {
    try {
        const { membershipId, membershipType, characterIds } = req.session;
        
        if (!membershipId || !membershipType || !characterIds) {
            return res.status(400).json({ error: "Missing session data. Ensure you have fetched characters first." });
        }

        const warlockCharacterId = characterIds[1];
        
        if (!warlockCharacterId) {
            return res.status(500).json({ error: "Warlock character ID not found." });
        }

        console.log(`Fetching inventory for membershipId: ${membershipId}, membershipType: ${membershipType}, characterId: ${warlockCharacterId}`);

        const profileUrl = `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=201`;
        const characterInventoryResponse = await axios.get(profileUrl, {
            headers: {
                'X-API-KEY': API_KEY,
                Authorization: `Bearer ${req.session.accessToken}`
            }
        });

        console.log(`Character Inventory Response for ${warlockCharacterId}:`, characterInventoryResponse.data);

        const characterInventoryData = characterInventoryResponse.data.Response.characterInventories.data[warlockCharacterId];
        if (!characterInventoryData) {
            return res.status(500).json({ error: "Failed to retrieve inventory data" });
        }

        const inventoryItems = characterInventoryData.items || [];
        const itemHashes = inventoryItems.map(item => item.itemHash);
        const itemInstanceIds = inventoryItems.map(item => item.itemInstanceId).filter(id => id); // Remove null values

        console.log(`Fetching definitions for ${itemHashes.length} items...`);

        // Fetch all item definitions in parallel using Promise.all
        const definitionsPromises = itemHashes.map(hash => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(definitionResponse => {
                if (definitionResponse.data.Response) {
                    return {
                        name: definitionResponse.data.Response.displayProperties.name,
                        hash: hash,
                        icon: `https://www.bungie.net${definitionResponse.data.Response.displayProperties.icon}`
                    };
                }
            }).catch(err => {
                console.error(`Error fetching definition for item ${hash}:`, err.message);
            })
        );

        const itemDefinitions = await Promise.all(definitionsPromises);

        // Fetch item light levels (primaryStat value) for each item instance
        const lightLevelPromises = itemInstanceIds.map(instanceId => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${instanceId}/?components=300,307`, {
                headers: { 'X-API-KEY': API_KEY, Authorization: `Bearer ${req.session.accessToken}` }
            }).then(itemResponse => {
                const itemData = itemResponse.data.Response;
                if (itemData?.instance?.data?.primaryStat) {
                    return {
                        itemInstanceId: instanceId,
                        bucketHash: itemData.item.data.bucketHash,
                        lightLevel: itemData.instance.data.primaryStat.value, // Get the light level
                        damageType: itemData.instance.data.damageTypeHash
                    };
                }
                return null; // If no light level is found
            }).catch(err => {
                console.error(`Error fetching light level for item ${instanceId}:`, err.message);
                return null;
            })
        );

        const lightLevels = await Promise.all(lightLevelPromises);

        const damageTypePromises = lightLevels
            .filter(data => data?.damageType) // Ensure damageType exists
            .map(data =>
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyDamageTypeDefinition/${data.damageType}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(damageResponse => {
                if (damageResponse.data.Response) {
                return {
                    damageTypeHash: data.damageType,
                    damageTypeName: damageResponse.data.Response.displayProperties.name,
                    damageTypeIcon: `https://www.bungie.net${damageResponse.data.Response.displayProperties.icon}`
                };
                }
            }).catch(err => {
                console.error(`Error fetching damage type for hash ${data.damageType}:`, err.message);
            })
            );

        const damageTypeDefinitions = await Promise.all(damageTypePromises);

        // Map the fetched definitions and light levels to the inventory items
        const inventoryWithImagesAndLightLevels = inventoryItems
            .map(item => {
                const definition = itemDefinitions.find(def => def.hash === item.itemHash);
                const lightLevelData = lightLevels.find(data => data?.itemInstanceId === item.itemInstanceId);
                const damageTypeData = damageTypeDefinitions.find(data => data?.damageTypeHash === lightLevelData?.damageType);
                return {
                    name: definition ? definition.name : null,
                    dName: damageTypeData ? damageTypeData.damageTypeName : null,
                    dIcon: damageTypeData ? damageTypeData.damageTypeIcon : null,
                    itemHash: item.itemHash,
                    quantity: item.quantity,
                    itemInstanceId: item.itemInstanceId,
                    bucketHash: lightLevelData ? lightLevelData.bucketHash : null,
                    icon: definition ? definition.icon : null,
                    lightLevel: lightLevelData ? lightLevelData.lightLevel : null
                };
            })
            .filter(item => item.icon && item.lightLevel !== null); // Remove items without icon or light level

        console.log(`Returning ${inventoryWithImagesAndLightLevels.length} warlock items with images and light levels.`);
        res.json({ inventoryItems: inventoryWithImagesAndLightLevels });

    } catch (error) {
        console.error("Error fetching inventory data:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to retrieve inventory data" });
    }
});

app.get('/api/titaninventory', async (req, res) => {
    try {
        const { membershipId, membershipType, characterIds } = req.session;
        
        if (!membershipId || !membershipType || !characterIds) {
            return res.status(400).json({ error: "Missing session data. Ensure you have fetched characters first." });
        }

        const titanCharacterId = characterIds[2];
        
        if (!titanCharacterId) {
            return res.status(500).json({ error: "Titan character ID not found." });
        }

        console.log(`Fetching inventory for membershipId: ${membershipId}, membershipType: ${membershipType}, characterId: ${titanCharacterId}`);

        const profileUrl = `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=201`;
        const characterInventoryResponse = await axios.get(profileUrl, {
            headers: {
                'X-API-KEY': API_KEY,
                Authorization: `Bearer ${req.session.accessToken}`
            }
        });

        console.log(`Character Inventory Response for ${titanCharacterId}:`, characterInventoryResponse.data);

        const characterInventoryData = characterInventoryResponse.data.Response.characterInventories.data[titanCharacterId];
        if (!characterInventoryData) {
            return res.status(500).json({ error: "Failed to retrieve inventory data" });
        }

        const inventoryItems = characterInventoryData.items || [];
        const itemHashes = inventoryItems.map(item => item.itemHash);
        const itemInstanceIds = inventoryItems.map(item => item.itemInstanceId).filter(id => id); // Remove null values

        console.log(`Fetching definitions for ${itemHashes.length} items...`);

        // Fetch all item definitions in parallel using Promise.all
        const definitionsPromises = itemHashes.map(hash => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(definitionResponse => {
                if (definitionResponse.data.Response) {
                    return {
                        name: definitionResponse.data.Response.displayProperties.name,
                        hash: hash,
                        icon: `https://www.bungie.net${definitionResponse.data.Response.displayProperties.icon}`
                    };
                }
            }).catch(err => {
                console.error(`Error fetching definition for item ${hash}:`, err.message);
            })
        );

        const itemDefinitions = await Promise.all(definitionsPromises);

        // Fetch item light levels (primaryStat value) for each item instance
        const lightLevelPromises = itemInstanceIds.map(instanceId => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${instanceId}/?components=300,307`, {
                headers: { 'X-API-KEY': API_KEY, Authorization: `Bearer ${req.session.accessToken}` }
            }).then(itemResponse => {
                const itemData = itemResponse.data.Response;
                if (itemData?.instance?.data?.primaryStat) {
                    return {
                        itemInstanceId: instanceId,
                        bucketHash: itemData.item.data.bucketHash,
                        lightLevel: itemData.instance.data.primaryStat.value,
                        damageType: itemData.instance.data.damageTypeHash
                    };
                }
                return null; // If no light level is found
            }).catch(err => {
                console.error(`Error fetching light level for item ${instanceId}:`, err.message);
                return null;
            })
        );

        const lightLevels = await Promise.all(lightLevelPromises);

        const damageTypePromises = lightLevels
            .filter(data => data?.damageType) // Ensure damageType exists
            .map(data =>
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyDamageTypeDefinition/${data.damageType}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(damageResponse => {
                if (damageResponse.data.Response) {
                return {
                    damageTypeHash: data.damageType,
                    damageTypeName: damageResponse.data.Response.displayProperties.name,
                    damageTypeIcon: `https://www.bungie.net${damageResponse.data.Response.displayProperties.icon}`
                };
                }
            }).catch(err => {
                console.error(`Error fetching damage type for hash ${data.damageType}:`, err.message);
            })
            );

        const damageTypeDefinitions = await Promise.all(damageTypePromises);

        // Map the fetched definitions and light levels to the inventory items
        const inventoryWithImagesAndLightLevels = inventoryItems
            .map(item => {
                const definition = itemDefinitions.find(def => def.hash === item.itemHash);
                const lightLevelData = lightLevels.find(data => data?.itemInstanceId === item.itemInstanceId);
                const damageTypeData = damageTypeDefinitions.find(data => data?.damageTypeHash === lightLevelData?.damageType);
                return {
                    name: definition ? definition.name : null,
                    dName: damageTypeData ? damageTypeData.damageTypeName : null,
                    dIcon: damageTypeData ? damageTypeData.damageTypeIcon : null,
                    itemHash: item.itemHash,
                    quantity: item.quantity,
                    itemInstanceId: item.itemInstanceId,
                    bucketHash: lightLevelData ? lightLevelData.bucketHash : null,
                    icon: definition ? definition.icon : null,
                    lightLevel: lightLevelData ? lightLevelData.lightLevel : null
                };
            })
            .filter(item => item.icon && item.lightLevel !== null); // Remove items without icon or light level

        console.log(`Returning ${inventoryWithImagesAndLightLevels.length} titan items with images and light levels.`);
        res.json({ inventoryItems: inventoryWithImagesAndLightLevels });

    } catch (error) {
        console.error("Error fetching inventory data:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to retrieve inventory data" });
    }
});

app.get('/api/vault', async (req, res) => {
    try {
        const { membershipId, membershipType } = req.session;

        console.log(`Fetching vault for membershipId: ${membershipId}, membershipType: ${membershipType}`);

        // Fetch profile data
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

        // Fetch the vault items and filter out any non-vault items
        const vaultItems = profileResponse.data.Response.profileInventory.data.items || [];
        const filteredVaultItems = vaultItems.filter(item => item.bucketHash !== 1469714392); // Exclude vault items (1469714392)
        const itemHashes = filteredVaultItems.map(item => item.itemHash);
        const itemInstanceIds = filteredVaultItems.map(item => item.itemInstanceId).filter(id => id); // Remove null values

        // Fetch item definitions in parallel using Promise.all
        const definitionsPromises = itemHashes.map(hash => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(definitionResponse => {
                if (definitionResponse.data.Response) {
                    return {
                        hash: hash,
                        name: definitionResponse.data.Response.displayProperties.name,
                        icon: `https://www.bungie.net${definitionResponse.data.Response.displayProperties.icon}`,
                        bucketTypeHash: definitionResponse.data.Response.inventory.bucketTypeHash
                    };
                }
            }).catch(err => {
                console.error(`Error fetching definition for item ${hash}:`, err.message);
            })
        );

        const itemDefinitions = await Promise.all(definitionsPromises);

        // Fetch item light levels (primaryStat value) for each item instance
        const lightLevelPromises = itemInstanceIds.map(instanceId => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${instanceId}/?components=300,307`, {
                headers: { 'X-API-KEY': API_KEY, Authorization: `Bearer ${req.session.accessToken}` }
            }).then(itemResponse => {
                const itemData = itemResponse.data.Response;
                if (itemData?.instance?.data?.primaryStat) {
                    return {
                        itemInstanceId: instanceId,
                        bucketHash: itemData.item.data.bucketHash,
                        lightLevel: itemData.instance.data.primaryStat.value, // Get the light level
                        damageType: itemData.instance.data.damageTypeHash
                    };
                }
                return null; // If no light level is found
            }).catch(err => {
                console.error(`Error fetching light level for item ${instanceId}:`, err.message);
                return null;
            })
        );

        const lightLevels = await Promise.all(lightLevelPromises);

        const damageTypePromises = lightLevels
            .filter(data => data?.damageType) // Ensure damageType exists
            .map(data =>
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyDamageTypeDefinition/${data.damageType}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(damageResponse => {
                if (damageResponse.data.Response) {
                return {
                    damageTypeHash: data.damageType,
                    damageTypeName: damageResponse.data.Response.displayProperties.name,
                    damageTypeIcon: `https://www.bungie.net${damageResponse.data.Response.displayProperties.icon}`
                };
                }
            }).catch(err => {
                console.error(`Error fetching damage type for hash ${data.damageType}:`, err.message);
            })
            );

        const damageTypeDefinitions = await Promise.all(damageTypePromises);

        // Map the fetched definitions and light levels to the vault items
        const vaultWithImagesAndLightLevels = filteredVaultItems
            .map(item => {
                const definition = itemDefinitions.find(def => def.hash === item.itemHash);
                const lightLevelData = lightLevels.find(data => data?.itemInstanceId === item.itemInstanceId);
                const damageTypeData = damageTypeDefinitions.find(data => data?.damageTypeHash === lightLevelData?.damageType);
                return {
                    name: definition ? definition.name : null,
                    dName: damageTypeData ? damageTypeData.damageTypeName : null,
                    dIcon: damageTypeData ? damageTypeData.damageTypeIcon : null,
                    itemHash: item.itemHash,
                    quantity: item.quantity,
                    itemInstanceId: item.itemInstanceId,
                    bucketHash: definition ? definition.bucketTypeHash : null,
                    icon: definition ? definition.icon : null,
                    lightLevel: lightLevelData ? lightLevelData.lightLevel : null
                };
            })
            .filter(item => item.icon && item.lightLevel !== null); // Remove items without icon or light level

        console.log(`Returning ${vaultWithImagesAndLightLevels.length} items with images and light levels.`);
        res.json({ vaultItems: vaultWithImagesAndLightLevels });

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

app.get('/api/hunterequipment', async (req, res) => {
    try {
        const { membershipId, membershipType, characterIds } = req.session;

        if (!membershipId || !membershipType || !characterIds) {
            return res.status(400).json({ error: "Missing session data. Ensure you have fetched characters first." });
        }

        const hunterCharacterId = characterIds[0]; // Assuming characterIds[0] is the Hunter

        if (!hunterCharacterId) {
            return res.status(500).json({ error: "Hunter character ID not found." });
        }

        console.log(`Fetching equipment for membershipId: ${membershipId}, membershipType: ${membershipType}, characterId: ${hunterCharacterId}`);

        const equipmentUrl = `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Character/${hunterCharacterId}/?components=205`;
        const equipmentResponse = await axios.get(equipmentUrl, {
            headers: {
                'X-API-KEY': API_KEY,
                Authorization: `Bearer ${req.session.accessToken}`
            }
        });

        const equipmentData = equipmentResponse.data.Response.equipment.data.items || [];

        if (!equipmentData || equipmentData.length === 0) {
            return res.status(404).json({ error: "No equipment found for Hunter." });
        }

        // Get the first 8 items
        const firstEightItems = equipmentData.slice(0, 8);
        const itemHashes = firstEightItems.map(item => item.itemHash);
        const itemInstanceIds = firstEightItems.map(item => item.itemInstanceId).filter(id => id); // Remove null values

        console.log(`Fetching definitions for ${itemHashes.length} Hunter Equipment items...`);

        // Fetch item definitions in parallel using Promise.all
        const definitionsPromises = itemHashes.map(hash => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(definitionResponse => {
                if (definitionResponse.data.Response) {
                    return {
                        hash: hash,
                        name: definitionResponse.data.Response.displayProperties.name,
                        icon: `https://www.bungie.net${definitionResponse.data.Response.displayProperties.icon}`,
                        bucketTypeHash: definitionResponse.data.Response.inventory.bucketTypeHash,
                        itemTypeDisplayName: definitionResponse.data.Response.itemTypeDisplayName,
                        statImpact: definitionResponse.data.Response.stats.stats["4043523819"]?.value || "N/A",
                        statRange: definitionResponse.data.Response.stats.stats["1240592695"]?.value || "N/A",
                        statStability: definitionResponse.data.Response.stats.stats["155624089"]?.value || "N/A",
                        statHandling: definitionResponse.data.Response.stats.stats["943549884"]?.value || "N/A",
                        statReloadSpeed: definitionResponse.data.Response.stats.stats["4188031367"]?.value || "N/A",
                        statAA: definitionResponse.data.Response.stats.stats["1345609583"]?.value || "N/A",
                        statAirborne: definitionResponse.data.Response.stats.stats["2714457168"]?.value || "N/A",
                        statZoom: definitionResponse.data.Response.stats.stats["3555269338"]?.value || "N/A",
                        statRPM: definitionResponse.data.Response.stats.stats["4284893193"]?.value || "N/A",
                        statBR: definitionResponse.data.Response.stats.stats["3614673599"]?.value || "N/A",
                        statVelocity: definitionResponse.data.Response.stats.stats["2523465841"]?.value || "N/A",
                        statPower: definitionResponse.data.Response.stats.stats["1935470627"]?.value || "N/A",
                        statGR: definitionResponse.data.Response.stats.stats["209426660"]?.value || "N/A",
                        statAC: definitionResponse.data.Response.stats.stats["925767036"]?.value || "N/A",
                        statIS: definitionResponse.data.Response.stats.stats["1931675084"]?.value || "N/A",
                        statGE: definitionResponse.data.Response.stats.stats["2762071195"]?.value || "N/A",
                        statSS: definitionResponse.data.Response.stats.stats["2837207746"]?.value || "N/A",
                        statCT: definitionResponse.data.Response.stats.stats["2961396640"]?.value || "N/A",
                        statCR: definitionResponse.data.Response.stats.stats["3022301683"]?.value || "N/A",
                        statSD: definitionResponse.data.Response.stats.stats["1842278586"]?.value || "N/A",
                        statDT: definitionResponse.data.Response.stats.stats["447667954"]?.value || "N/A",
                        statAccuracy: definitionResponse.data.Response.stats.stats["1591432999"]?.value || "N/A",
                    };
                }
            }).catch(err => {
                console.error(`Error fetching definition for item ${hash}:`, err.message);
            })
        );

        const itemDefinitions = await Promise.all(definitionsPromises);

        // Fetch item light levels (primaryStat value) for each item instance
        const lightLevelPromises = itemInstanceIds.map(instanceId => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${instanceId}/?components=300,307`, {
                headers: { 'X-API-KEY': API_KEY, Authorization: `Bearer ${req.session.accessToken}` }
            }).then(itemResponse => {
                const itemData = itemResponse.data.Response;
                if (itemData?.instance?.data?.primaryStat) {
                    return {
                        itemInstanceId: instanceId,
                        bucketHash: itemData.item.data.bucketHash,
                        lightLevel: itemData.instance.data.primaryStat.value, // Get the light level
                        damageType: itemData.instance.data.damageTypeHash
                    };
                }
                return null; // If no light level is found
            }).catch(err => {
                console.error(`Error fetching light level for item ${instanceId}:`, err.message);
                return null;
            })
        );

        // Fetch item light levels
        const lightLevels = await Promise.all(lightLevelPromises);

        // Armor bucket hashes
        const armorBucketHashes = [
            3448274439, // Helmet
            3551918588, // Gauntlets
            14239492,   // Chest Armor
            20886954,   // Leg Armor
            1585787867  // Class Armor
        ];

        // Filter for armor items
        const armorItems = firstEightItems.filter(item => {
            const definition = itemDefinitions.find(def => def.hash === item.itemHash);
            return definition && armorBucketHashes.includes(definition.bucketTypeHash);
        });

        // Fetch armor stats for each armor item
        const armorStatsPromises = armorItems.map(item => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${item.itemInstanceId}/?components=304`, {
            headers: { 
                'X-API-KEY': API_KEY, 
                Authorization: `Bearer ${req.session.accessToken}` 
            }
            }).then(statsResponse => {
            const statsData = statsResponse.data.Response.stats?.data;
            if (statsData) {
                return {
                itemInstanceId: item.itemInstanceId,
                stats: {
                    mobility: statsData.stats[2996146975]?.value || 0,     // Mobility
                    resilience: statsData.stats[392767087]?.value || 0,    // Resilience
                    recovery: statsData.stats[1943323491]?.value || 0,     // Recovery
                    discipline: statsData.stats[1735777505]?.value || 0,   // Discipline
                    intellect: statsData.stats[144602215]?.value || 0,     // Intellect
                    strength: statsData.stats[4244567218]?.value || 0      // Strength
                }
                };
            }
            return null;
            }).catch(err => {
            console.error(`Error fetching stats for armor ${item.itemInstanceId}:`, err.message);
            return null;
            })
        );

        const armorStats = await Promise.all(armorStatsPromises);

        const damageTypePromises = lightLevels
            .filter(data => data?.damageType) // Ensure damageType exists
            .map(data =>
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyDamageTypeDefinition/${data.damageType}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(damageResponse => {
                if (damageResponse.data.Response) {
                return {
                    damageTypeHash: data.damageType,
                    damageTypeName: damageResponse.data.Response.displayProperties.name,
                    damageTypeIcon: `https://www.bungie.net${damageResponse.data.Response.displayProperties.icon}`
                };
                }
            }).catch(err => {
                console.error(`Error fetching damage type for hash ${data.damageType}:`, err.message);
            })
            );

        const damageTypeDefinitions = await Promise.all(damageTypePromises);

        // Map the fetched definitions and light levels to the equipment items
        const equipmentWithDetails = firstEightItems
            .map(item => {
                const definition = itemDefinitions.find(def => def.hash === item.itemHash);
                const lightLevelData = lightLevels.find(data => data?.itemInstanceId === item.itemInstanceId);
                const damageTypeData = damageTypeDefinitions.find(data => data?.damageTypeHash === lightLevelData?.damageType);
                return {
                    name: definition ? definition.name : null,
                    dName: damageTypeData ? damageTypeData.damageTypeName : null,
                    dIcon: damageTypeData ? damageTypeData.damageTypeIcon : null,
                    itemHash: item.itemHash,
                    quantity: item.quantity,
                    itemInstanceId: item.itemInstanceId,
                    itemTypeDisplayName: definition ? definition.itemTypeDisplayName : null,
                    bucketHash: definition ? definition.bucketTypeHash : null,
                    icon: definition ? definition.icon : null,
                    lightLevel: lightLevelData ? lightLevelData.lightLevel : null,
                    impact: definition ? definition.statImpact : "N/A",
                    range: definition ? definition.statRange : "N/A",
                    stability: definition ? definition.statStability : "N/A",
                    handling: definition ? definition.statHandling : "N/A",
                    reloadspeed: definition ? definition.statReloadSpeed : "N/A",
                    aimassistance: definition ? definition.statAA : "N/A",
                    airborne: definition ? definition.statAirborne : "N/A",
                    zoom: definition ? definition.statZoom : "N/A",
                    rpm: definition ? definition.statRPM : "N/A",
                    blastradius: definition ? definition.statBR : "N/A",
                    velocity: definition ? definition.statVelocity : "N/A",
                    power: definition ? definition.statPower : "N/A",
                    guardResistance: definition ? definition.statGR : "N/A",
                    ammoCapacity: definition ? definition.statAC : "N/A",
                    inventorySize: definition ? definition.statIS : "N/A",
                    guardEndurance: definition ? definition.statGE : "N/A",
                    swingSpeed: definition ? definition.statSS : "N/A",
                    chargeTime: definition ? definition.statCT : "N/A",
                    chargeRate: definition ? definition.statCR : "N/A",
                    shieldDuration: definition ? definition.statSD : "N/A",
                    drawTime: definition ? definition.statDT : "N/A",
                    accuracy: definition ? definition.statAccuracy : "N/A",
                    mobility: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.mobility || 0,
                    resilience: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.resilience || 0,
                    recovery: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.recovery || 0,
                    discipline: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.discipline || 0,
                    intellect: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.intellect || 0,
                    strength: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.strength || 0,



                };
            })
            .filter(item => item.icon && item.lightLevel !== null); // Remove items without icon or light level

        console.log(`Returning ${equipmentWithDetails.length} hunter equipment items with details.`);
        res.json({ equipment: equipmentWithDetails });


        
    } catch (error) {
        console.error("Error fetching Hunter equipment:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to retrieve Hunter equipment" });
    }
});

app.get('/api/warlockequipment', async (req, res) => {
    try {
        const { membershipId, membershipType, characterIds } = req.session;

        if (!membershipId || !membershipType || !characterIds) {
            return res.status(400).json({ error: "Missing session data. Ensure you have fetched characters first." });
        }

        const warlockCharacterId = characterIds[1]; // Assuming characterIds[0] is the Hunter

        if (!warlockCharacterId) {
            return res.status(500).json({ error: "Warlock character ID not found." });
        }

        console.log(`Fetching equipment for membershipId: ${membershipId}, membershipType: ${membershipType}, characterId: ${warlockCharacterId}`);

        const equipmentUrl = `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Character/${warlockCharacterId}/?components=205`;
        const equipmentResponse = await axios.get(equipmentUrl, {
            headers: {
                'X-API-KEY': API_KEY,
                Authorization: `Bearer ${req.session.accessToken}`
            }
        });

        const equipmentData = equipmentResponse.data.Response.equipment.data.items || [];

        if (!equipmentData || equipmentData.length === 0) {
            return res.status(404).json({ error: "No equipment found for Hunter." });
        }

        // Get the first 8 items
        const firstEightItems = equipmentData.slice(0, 8);
        const itemHashes = firstEightItems.map(item => item.itemHash);
        const itemInstanceIds = firstEightItems.map(item => item.itemInstanceId).filter(id => id); // Remove null values

        console.log(`Fetching definitions for ${itemHashes.length} Warlock Equipment items...`);

        // Fetch item definitions in parallel using Promise.all
        const definitionsPromises = itemHashes.map(hash => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(definitionResponse => {
                if (definitionResponse.data.Response) {
                    return {
                        hash: hash,
                        name: definitionResponse.data.Response.displayProperties.name,
                        icon: `https://www.bungie.net${definitionResponse.data.Response.displayProperties.icon}`,
                        bucketTypeHash: definitionResponse.data.Response.inventory.bucketTypeHash,
                        itemTypeDisplayName: definitionResponse.data.Response.itemTypeDisplayName,
                        statImpact: definitionResponse.data.Response.stats.stats["4043523819"]?.value || "N/A",
                        statRange: definitionResponse.data.Response.stats.stats["1240592695"]?.value || "N/A",
                        statStability: definitionResponse.data.Response.stats.stats["155624089"]?.value || "N/A",
                        statHandling: definitionResponse.data.Response.stats.stats["943549884"]?.value || "N/A",
                        statReloadSpeed: definitionResponse.data.Response.stats.stats["4188031367"]?.value || "N/A",
                        statAA: definitionResponse.data.Response.stats.stats["1345609583"]?.value || "N/A",
                        statAirborne: definitionResponse.data.Response.stats.stats["2714457168"]?.value || "N/A",
                        statZoom: definitionResponse.data.Response.stats.stats["3555269338"]?.value || "N/A",
                        statRPM: definitionResponse.data.Response.stats.stats["4284893193"]?.value || "N/A",
                        statBR: definitionResponse.data.Response.stats.stats["3614673599"]?.value || "N/A",
                        statVelocity: definitionResponse.data.Response.stats.stats["2523465841"]?.value || "N/A",
                        statPower: definitionResponse.data.Response.stats.stats["1935470627"]?.value || "N/A",
                        statGR: definitionResponse.data.Response.stats.stats["209426660"]?.value || "N/A",
                        statAC: definitionResponse.data.Response.stats.stats["925767036"]?.value || "N/A",
                        statIS: definitionResponse.data.Response.stats.stats["1931675084"]?.value || "N/A",
                        statGE: definitionResponse.data.Response.stats.stats["2762071195"]?.value || "N/A",
                        statSS: definitionResponse.data.Response.stats.stats["2837207746"]?.value || "N/A",
                        statCT: definitionResponse.data.Response.stats.stats["2961396640"]?.value || "N/A",
                        statCR: definitionResponse.data.Response.stats.stats["3022301683"]?.value || "N/A",
                        statSD: definitionResponse.data.Response.stats.stats["1842278586"]?.value || "N/A",
                        statDT: definitionResponse.data.Response.stats.stats["447667954"]?.value || "N/A",
                        statAccuracy: definitionResponse.data.Response.stats.stats["1591432999"]?.value || "N/A",
                    };
                }
            }).catch(err => {
                console.error(`Error fetching definition for item ${hash}:`, err.message);
            })
        );

        const itemDefinitions = await Promise.all(definitionsPromises);

        // Fetch item light levels (primaryStat value) for each item instance
        const lightLevelPromises = itemInstanceIds.map(instanceId => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${instanceId}/?components=300,307`, {
                headers: { 'X-API-KEY': API_KEY, Authorization: `Bearer ${req.session.accessToken}` }
            }).then(itemResponse => {
                const itemData = itemResponse.data.Response;
                if (itemData?.instance?.data?.primaryStat) {
                    return {
                        itemInstanceId: instanceId,
                        bucketHash: itemData.item.data.bucketHash,
                        lightLevel: itemData.instance.data.primaryStat.value, // Get the light level
                        damageType: itemData.instance.data.damageTypeHash
                    };
                }
                return null; // If no light level is found
            }).catch(err => {
                console.error(`Error fetching light level for item ${instanceId}:`, err.message);
                return null;
            })
        );

        // Fetch item light levels
        const lightLevels = await Promise.all(lightLevelPromises);

        // Armor bucket hashes
        const armorBucketHashes = [
            3448274439, // Helmet
            3551918588, // Gauntlets
            14239492,   // Chest Armor
            20886954,   // Leg Armor
            1585787867  // Class Armor
        ];

        // Filter for armor items
        const armorItems = firstEightItems.filter(item => {
            const definition = itemDefinitions.find(def => def.hash === item.itemHash);
            return definition && armorBucketHashes.includes(definition.bucketTypeHash);
        });

        // Fetch armor stats for each armor item
        const armorStatsPromises = armorItems.map(item => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${item.itemInstanceId}/?components=304`, {
            headers: { 
                'X-API-KEY': API_KEY, 
                Authorization: `Bearer ${req.session.accessToken}` 
            }
            }).then(statsResponse => {
            const statsData = statsResponse.data.Response.stats?.data;
            if (statsData) {
                return {
                itemInstanceId: item.itemInstanceId,
                stats: {
                    mobility: statsData.stats[2996146975]?.value || 0,     // Mobility
                    resilience: statsData.stats[392767087]?.value || 0,    // Resilience
                    recovery: statsData.stats[1943323491]?.value || 0,     // Recovery
                    discipline: statsData.stats[1735777505]?.value || 0,   // Discipline
                    intellect: statsData.stats[144602215]?.value || 0,     // Intellect
                    strength: statsData.stats[4244567218]?.value || 0      // Strength
                }
                };
            }
            return null;
            }).catch(err => {
            console.error(`Error fetching stats for armor ${item.itemInstanceId}:`, err.message);
            return null;
            })
        );

        const armorStats = await Promise.all(armorStatsPromises);

        const damageTypePromises = lightLevels
            .filter(data => data?.damageType) // Ensure damageType exists
            .map(data =>
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyDamageTypeDefinition/${data.damageType}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(damageResponse => {
                if (damageResponse.data.Response) {
                return {
                    damageTypeHash: data.damageType,
                    damageTypeName: damageResponse.data.Response.displayProperties.name,
                    damageTypeIcon: `https://www.bungie.net${damageResponse.data.Response.displayProperties.icon}`
                };
                }
            }).catch(err => {
                console.error(`Error fetching damage type for hash ${data.damageType}:`, err.message);
            })
            );

        const damageTypeDefinitions = await Promise.all(damageTypePromises);

        // Map the fetched definitions and light levels to the equipment items
        const equipmentWithDetails = firstEightItems
            .map(item => {
                const definition = itemDefinitions.find(def => def.hash === item.itemHash);
                const lightLevelData = lightLevels.find(data => data?.itemInstanceId === item.itemInstanceId);
                const damageTypeData = damageTypeDefinitions.find(data => data?.damageTypeHash === lightLevelData?.damageType);
                return {
                    name: definition ? definition.name : null,
                    dName: damageTypeData ? damageTypeData.damageTypeName : null,
                    dIcon: damageTypeData ? damageTypeData.damageTypeIcon : null,
                    itemHash: item.itemHash,
                    quantity: item.quantity,
                    itemInstanceId: item.itemInstanceId,
                    itemTypeDisplayName: definition ? definition.itemTypeDisplayName : null,
                    bucketHash: definition ? definition.bucketTypeHash : null,
                    icon: definition ? definition.icon : null,
                    lightLevel: lightLevelData ? lightLevelData.lightLevel : null,
                    impact: definition ? definition.statImpact : "N/A",
                    range: definition ? definition.statRange : "N/A",
                    stability: definition ? definition.statStability : "N/A",
                    handling: definition ? definition.statHandling : "N/A",
                    reloadspeed: definition ? definition.statReloadSpeed : "N/A",
                    aimassistance: definition ? definition.statAA : "N/A",
                    airborne: definition ? definition.statAirborne : "N/A",
                    zoom: definition ? definition.statZoom : "N/A",
                    rpm: definition ? definition.statRPM : "N/A",
                    blastradius: definition ? definition.statBR : "N/A",
                    velocity: definition ? definition.statVelocity : "N/A",
                    power: definition ? definition.statPower : "N/A",
                    guardResistance: definition ? definition.statGR : "N/A",
                    ammoCapacity: definition ? definition.statAC : "N/A",
                    inventorySize: definition ? definition.statIS : "N/A",
                    guardEndurance: definition ? definition.statGE : "N/A",
                    swingSpeed: definition ? definition.statSS : "N/A",
                    chargeTime: definition ? definition.statCT : "N/A",
                    chargeRate: definition ? definition.statCR : "N/A",
                    shieldDuration: definition ? definition.statSD : "N/A",
                    drawTime: definition ? definition.statDT : "N/A",
                    accuracy: definition ? definition.statAccuracy : "N/A",
                    mobility: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.mobility || 0,
                    resilience: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.resilience || 0,
                    recovery: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.recovery || 0,
                    discipline: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.discipline || 0,
                    intellect: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.intellect || 0,
                    strength: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.strength || 0,



                };
            })
            .filter(item => item.icon && item.lightLevel !== null); // Remove items without icon or light level

        console.log(`Returning ${equipmentWithDetails.length} warlock equipment items with details.`);
        res.json({ equipment: equipmentWithDetails });


        
    } catch (error) {
        console.error("Error fetching Warlock equipment:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to retrieve Warlock equipment" });
    }
});

app.get('/api/titanequipment', async (req, res) => {
    try {
        const { membershipId, membershipType, characterIds } = req.session;

        if (!membershipId || !membershipType || !characterIds) {
            return res.status(400).json({ error: "Missing session data. Ensure you have fetched characters first." });
        }

        const titanCharacterId = characterIds[2]; // Assuming characterIds[0] is the Hunter

        if (!titanCharacterId) {
            return res.status(500).json({ error: "Titan character ID not found." });
        }

        console.log(`Fetching equipment for membershipId: ${membershipId}, membershipType: ${membershipType}, characterId: ${titanCharacterId}`);

        const equipmentUrl = `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Character/${titanCharacterId}/?components=205`;
        const equipmentResponse = await axios.get(equipmentUrl, {
            headers: {
                'X-API-KEY': API_KEY,
                Authorization: `Bearer ${req.session.accessToken}`
            }
        });

        const equipmentData = equipmentResponse.data.Response.equipment.data.items || [];

        if (!equipmentData || equipmentData.length === 0) {
            return res.status(404).json({ error: "No equipment found for Titan." });
        }

        // Get the first 8 items
        const firstEightItems = equipmentData.slice(0, 8);
        const itemHashes = firstEightItems.map(item => item.itemHash);
        const itemInstanceIds = firstEightItems.map(item => item.itemInstanceId).filter(id => id); // Remove null values

        console.log(`Fetching definitions for ${itemHashes.length} Titan Equipment items...`);

        // Fetch item definitions in parallel using Promise.all
        const definitionsPromises = itemHashes.map(hash => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyInventoryItemDefinition/${hash}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(definitionResponse => {
                if (definitionResponse.data.Response) {
                    return {
                        hash: hash,
                        name: definitionResponse.data.Response.displayProperties.name,
                        icon: `https://www.bungie.net${definitionResponse.data.Response.displayProperties.icon}`,
                        bucketTypeHash: definitionResponse.data.Response.inventory.bucketTypeHash,
                        itemTypeDisplayName: definitionResponse.data.Response.itemTypeDisplayName,
                        statImpact: definitionResponse.data.Response.stats.stats["4043523819"]?.value || "N/A",
                        statRange: definitionResponse.data.Response.stats.stats["1240592695"]?.value || "N/A",
                        statStability: definitionResponse.data.Response.stats.stats["155624089"]?.value || "N/A",
                        statHandling: definitionResponse.data.Response.stats.stats["943549884"]?.value || "N/A",
                        statReloadSpeed: definitionResponse.data.Response.stats.stats["4188031367"]?.value || "N/A",
                        statAA: definitionResponse.data.Response.stats.stats["1345609583"]?.value || "N/A",
                        statAirborne: definitionResponse.data.Response.stats.stats["2714457168"]?.value || "N/A",
                        statZoom: definitionResponse.data.Response.stats.stats["3555269338"]?.value || "N/A",
                        statRPM: definitionResponse.data.Response.stats.stats["4284893193"]?.value || "N/A",
                        statBR: definitionResponse.data.Response.stats.stats["3614673599"]?.value || "N/A",
                        statVelocity: definitionResponse.data.Response.stats.stats["2523465841"]?.value || "N/A",
                        statPower: definitionResponse.data.Response.stats.stats["1935470627"]?.value || "N/A",
                        statGR: definitionResponse.data.Response.stats.stats["209426660"]?.value || "N/A",
                        statAC: definitionResponse.data.Response.stats.stats["925767036"]?.value || "N/A",
                        statIS: definitionResponse.data.Response.stats.stats["1931675084"]?.value || "N/A",
                        statGE: definitionResponse.data.Response.stats.stats["2762071195"]?.value || "N/A",
                        statSS: definitionResponse.data.Response.stats.stats["2837207746"]?.value || "N/A",
                        statCT: definitionResponse.data.Response.stats.stats["2961396640"]?.value || "N/A",
                        statCR: definitionResponse.data.Response.stats.stats["3022301683"]?.value || "N/A",
                        statSD: definitionResponse.data.Response.stats.stats["1842278586"]?.value || "N/A",
                        statDT: definitionResponse.data.Response.stats.stats["447667954"]?.value || "N/A",
                        statAccuracy: definitionResponse.data.Response.stats.stats["1591432999"]?.value || "N/A",
                    };
                }
            }).catch(err => {
                console.error(`Error fetching definition for item ${hash}:`, err.message);
            })
        );

        const itemDefinitions = await Promise.all(definitionsPromises);

        // Fetch item light levels (primaryStat value) for each item instance
        const lightLevelPromises = itemInstanceIds.map(instanceId => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${instanceId}/?components=300,307`, {
                headers: { 'X-API-KEY': API_KEY, Authorization: `Bearer ${req.session.accessToken}` }
            }).then(itemResponse => {
                const itemData = itemResponse.data.Response;
                if (itemData?.instance?.data?.primaryStat) {
                    return {
                        itemInstanceId: instanceId,
                        bucketHash: itemData.item.data.bucketHash,
                        lightLevel: itemData.instance.data.primaryStat.value, // Get the light level
                        damageType: itemData.instance.data.damageTypeHash
                    };
                }
                return null; // If no light level is found
            }).catch(err => {
                console.error(`Error fetching light level for item ${instanceId}:`, err.message);
                return null;
            })
        );

        // Fetch item light levels
        const lightLevels = await Promise.all(lightLevelPromises);

        // Armor bucket hashes
        const armorBucketHashes = [
            3448274439, // Helmet
            3551918588, // Gauntlets
            14239492,   // Chest Armor
            20886954,   // Leg Armor
            1585787867  // Class Armor
        ];

        // Filter for armor items
        const armorItems = firstEightItems.filter(item => {
            const definition = itemDefinitions.find(def => def.hash === item.itemHash);
            return definition && armorBucketHashes.includes(definition.bucketTypeHash);
        });

        // Fetch armor stats for each armor item
        const armorStatsPromises = armorItems.map(item => 
            axios.get(`https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/Item/${item.itemInstanceId}/?components=304`, {
            headers: { 
                'X-API-KEY': API_KEY, 
                Authorization: `Bearer ${req.session.accessToken}` 
            }
            }).then(statsResponse => {
            const statsData = statsResponse.data.Response.stats?.data;
            if (statsData) {
                return {
                itemInstanceId: item.itemInstanceId,
                stats: {
                    mobility: statsData.stats[2996146975]?.value || 0,     // Mobility
                    resilience: statsData.stats[392767087]?.value || 0,    // Resilience
                    recovery: statsData.stats[1943323491]?.value || 0,     // Recovery
                    discipline: statsData.stats[1735777505]?.value || 0,   // Discipline
                    intellect: statsData.stats[144602215]?.value || 0,     // Intellect
                    strength: statsData.stats[4244567218]?.value || 0      // Strength
                }
                };
            }
            return null;
            }).catch(err => {
            console.error(`Error fetching stats for armor ${item.itemInstanceId}:`, err.message);
            return null;
            })
        );

        const armorStats = await Promise.all(armorStatsPromises);

        const damageTypePromises = lightLevels
            .filter(data => data?.damageType) // Ensure damageType exists
            .map(data =>
            axios.get(`https://www.bungie.net/Platform/Destiny2/Manifest/DestinyDamageTypeDefinition/${data.damageType}/`, {
                headers: { 'X-API-KEY': API_KEY }
            }).then(damageResponse => {
                if (damageResponse.data.Response) {
                return {
                    damageTypeHash: data.damageType,
                    damageTypeName: damageResponse.data.Response.displayProperties.name,
                    damageTypeIcon: `https://www.bungie.net${damageResponse.data.Response.displayProperties.icon}`
                };
                }
            }).catch(err => {
                console.error(`Error fetching damage type for hash ${data.damageType}:`, err.message);
            })
            );

        const damageTypeDefinitions = await Promise.all(damageTypePromises);

        // Map the fetched definitions and light levels to the equipment items
        const equipmentWithDetails = firstEightItems
            .map(item => {
                const definition = itemDefinitions.find(def => def.hash === item.itemHash);
                const lightLevelData = lightLevels.find(data => data?.itemInstanceId === item.itemInstanceId);
                const damageTypeData = damageTypeDefinitions.find(data => data?.damageTypeHash === lightLevelData?.damageType);
                return {
                    name: definition ? definition.name : null,
                    dName: damageTypeData ? damageTypeData.damageTypeName : null,
                    dIcon: damageTypeData ? damageTypeData.damageTypeIcon : null,
                    itemHash: item.itemHash,
                    quantity: item.quantity,
                    itemInstanceId: item.itemInstanceId,
                    itemTypeDisplayName: definition ? definition.itemTypeDisplayName : null,
                    bucketHash: definition ? definition.bucketTypeHash : null,
                    icon: definition ? definition.icon : null,
                    lightLevel: lightLevelData ? lightLevelData.lightLevel : null,
                    impact: definition ? definition.statImpact : "N/A",
                    range: definition ? definition.statRange : "N/A",
                    stability: definition ? definition.statStability : "N/A",
                    handling: definition ? definition.statHandling : "N/A",
                    reloadspeed: definition ? definition.statReloadSpeed : "N/A",
                    aimassistance: definition ? definition.statAA : "N/A",
                    airborne: definition ? definition.statAirborne : "N/A",
                    zoom: definition ? definition.statZoom : "N/A",
                    rpm: definition ? definition.statRPM : "N/A",
                    blastradius: definition ? definition.statBR : "N/A",
                    velocity: definition ? definition.statVelocity : "N/A",
                    power: definition ? definition.statPower : "N/A",
                    guardResistance: definition ? definition.statGR : "N/A",
                    ammoCapacity: definition ? definition.statAC : "N/A",
                    inventorySize: definition ? definition.statIS : "N/A",
                    guardEndurance: definition ? definition.statGE : "N/A",
                    swingSpeed: definition ? definition.statSS : "N/A",
                    chargeTime: definition ? definition.statCT : "N/A",
                    chargeRate: definition ? definition.statCR : "N/A",
                    shieldDuration: definition ? definition.statSD : "N/A",
                    drawTime: definition ? definition.statDT : "N/A",
                    accuracy: definition ? definition.statAccuracy : "N/A",
                    mobility: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.mobility || 0,
                    resilience: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.resilience || 0,
                    recovery: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.recovery || 0,
                    discipline: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.discipline || 0,
                    intellect: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.intellect || 0,
                    strength: armorStats.find(stats => stats?.itemInstanceId === item.itemInstanceId)?.stats.strength || 0,



                };
            })
            .filter(item => item.icon && item.lightLevel !== null); // Remove items without icon or light level

        console.log(`Returning ${equipmentWithDetails.length} titan equipment items with details.`);
        res.json({ equipment: equipmentWithDetails });


        
    } catch (error) {
        console.error("Error fetching Titan equipment:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: "Failed to retrieve Titan equipment" });
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
