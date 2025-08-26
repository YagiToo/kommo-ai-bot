const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// ===== USE ENVIRONMENT VARIABLES =====
const KEYS = {
  KOMMO_CLIENT_ID: process.env.KOMMO_CLIENT_ID,
  KOMMO_CLIENT_SECRET: process.env.KOMMO_CLIENT_SECRET,
  KOMMO_SUBDOMAIN: process.env.KOMMO_SUBDOMAIN,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};
// =====================================

// In a real app, use a database. For this demo, we'll use a variable.
// YOUR TOKEN WILL RESET IF THE SERVER RESTARTS.
let kommoAccessToken = null;

// 1. Route to start the Kommo connection (Open this in your browser)
app.get('/auth', (req, res) => {
  // Dynamically get the hostname and construct the EXACT Redirect URI
  const redirectUri = `https://${req.get('host')}/oauth`;
  
  // Construct the OAuth URL EXACTLY as Kommo requires :cite[1]
  const authUrl = `https://www.kommo.com/oauth?client_id=${KEYS.KOMMO_CLIENT_ID}&state=some_random_state_string&mode=post_message&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  res.send(`<a href="${authUrl}">Click HERE to Connect Your Kommo Account</a>`);
});

// 2. Route where Kommo sends the access token after auth
app.get('/oauth', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authorization failed: No code received from Kommo.');
  }

  try {
    // Use the SAME redirect_uri as in the /auth step
    const redirectUri = `https://${req.get('host')}/oauth`;
    
    const response = await axios.post(`https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/oauth2/access_token`, {
      client_id: KEYS.KOMMO_CLIENT_ID,
      client_secret: KEYS.KOMMO_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri // Must match the initial request
    });
    
    kommoAccessToken = response.data.access_token;
    res.send('Kommo Connected Successfully! You can close this tab and message your Telegram bot.');
  } catch (error) {
    console.error('Kommo Auth Error:', error.response?.data);
    res.send(`Error connecting to Kommo. Ensure your Redirect URI in Kommo is set to: https://${req.get('host')}/oauth`);
  }
});

// 3. Main Webhook - Telegram sends messages here
app.post('/webhook', async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userText = message.text;
  const userName = `${message.from.first_name} ${message.from.last_name || ''}`.trim();

  console.log('User said:', userText);

  // 4. Use OpenAI to EXTRACT SEARCH PARAMETERS (Focus on location and budget)
  let searchCriteria = {};
  try {
    const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Analyze this real estate request and return a JSON object. Extract the location (city or area, convert it to a relevant US ZIP code if possible) and maximum budget. If not specified, use null.

        USER REQUEST: "${userText}"

        Example Output for "I want a house in NYC under 500k": {"zipcode": "10001", "maxPrice": 500000}

        Return ONLY a valid JSON object. Nothing else.
        JSON:`
      }]
    }, {
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    // Parse the AI's response into a usable JavaScript object
    searchCriteria = JSON.parse(openaiResponse.data.choices[0].message.content);
  } catch (error) {
    console.error('OpenAI Extraction Error:', error.response?.data);
    // If AI fails, send a message asking for clarification
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: "I want to help you find the perfect property! Could you please tell me your target location and budget? For example: '2-bedroom apartment in Miami under $300,000'."
    });
    return res.sendStatus(200);
  }

  // 5. CALL THE APIFY ZILLOW ZIP CODE SCRAPER API
  let propertyListings = [];
  try {
    // Prepare the input for the Apify Actor as per its documentation :cite[1]
    const input = {
      "zipCodes": [searchCriteria.zipcode || "10001"], // Default to a NYC ZIP code if none found
      "priceMax": searchCriteria.maxPrice || 1000000 // Default to $1M if no budget is set
    };

    // Run the Actor synchronously and get dataset items :cite[1]
    const apifyResponse = await axios.post(`https://api.apify.com/v2/acts/maxcopell~zillow-zip-search/run-sync-get-dataset-items?token=${process.env.APIFY_API_TOKEN}`, input);
    propertyListings = apifyResponse.data;

    console.log(`✅ Apify API Success! Fetched ${propertyListings.length} properties.`);

  } catch (error) {
    console.error('Apify API Error:', error.response?.data);
    // If the API call fails, inform the user.
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: "It seems our property search is temporarily unavailable. Please try again in a few moments, or tell me your budget and location again."
    });
    return res.sendStatus(200);
  }

  // 6. FILTER & FORMAT THE RESULTS (Get top 2 most relevant)
  const topListings = propertyListings.slice(0, 2);

  // 7. GENERATE A HELPFUL AI RESPONSE BASED ON THE REAL LISTINGS
  let aiResponse = "I found some great properties for you! 🏡";
  if (topListings.length === 0) {
    aiResponse = "I couldn't find any properties matching your criteria right now. Try broadening your search (e.g., a different area or higher budget).";
  }

  // 8. SEND THE RESPONSE + PROPERTY PHOTOS TO THE USER ON TELEGRAM
  try {
    // Send the introductory text response first
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: aiResponse
    });

            // If we have listings, send each one as a photo with a rich caption
    if (topListings.length > 0) {
      for (const listing of topListings) {
// 1. SAFELY FORMAT THE CAPTION - Escape Markdown special characters
// A simple function to escape characters that break MarkdownV2
function escapeMarkdown(text) {
  if (!text) return '';
  // Added the pipe | to the list of characters to escape
  return text.toString().replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

        // 2. BUILD THE CAPTION using escaped values
        const caption = `
${escapeMarkdown(listing.statusText) || 'Property For Sale'} 🏠
*Price:* ${escapeMarkdown(listing.price) || 'N/A'}
*Address:* ${escapeMarkdown(listing.address) || 'Address not available'}
*Beds:* ${escapeMarkdown(listing.beds) || 'N/A'} | *Baths:* ${escapeMarkdown(listing.baths) || 'N/A'} | *Area:* ${listing.area ? `${escapeMarkdown(listing.area.toString())} sqft` : 'N/A'}
        
${escapeMarkdown(listing.detailUrl) || ''}
        `.trim();

        // 3. Prepare the photo payload. Use a placeholder if no image is available.
        const photoUrl = listing.imgSrc || 'https://placehold.co/600x400?text=No+Image+Available';

        // 4. Send the photo with the caption USING MarkdownV2
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
          chat_id: chatId,
          photo: photoUrl,
          caption: caption,
          parse_mode: 'MarkdownV2' // Use the more robust MarkdownV2
        });
      }
    }

  } catch (error) {
    console.error('Telegram Send Error:', error.response?.data);
  }

  // 9. KOMMO INTEGRATION (Log the interaction and create a lead)
  if (kommoAccessToken) {
    try {
      // A. Create or find the contact in Kommo
      const kommoContact = await axios.post(`https://${process.env.KOMMO_SUBDOMAIN}.kommo.com/api/v4/contacts`, [{
        name: userName,
        custom_fields_values: [{
          field_code: 'PHONE',
          values: [{ value: message.from.id.toString() }]
        }]
      }], {
        headers: { 'Authorization': `Bearer ${kommoAccessToken}` }
      });
      const contactId = kommoContact.data._embedded.contacts[0].id;

      // B. Add a note about the interaction and the search performed
      await axios.post(`https://${process.env.KOMMO_SUBDOMAIN}.kommo.com/api/v4/events`, [{
        entity_id: contactId,
        note: `User searched for properties on Telegram.\nQuery: "${userText}"\nFound ${propertyListings.length} results using ZIP code ${searchCriteria.zipcode}.`
      }], {
        headers: { 'Authorization': `Bearer ${kommoAccessToken}` }
      });

      // C. CREATE A DEAL since they are actively searching
      await axios.post(`https://${process.env.KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads`, [{
        name: `Property Search Lead: ${userName}`,
        pipeline_id: 123456, // <<< REPLACE WITH YOUR PIPELINE ID
        status_id: 1234567,  // <<< REPLACE WITH YOUR STATUS ID
        _embedded: { contacts: [{ id: contactId }] }
      }], {
        headers: { 'Authorization': `Bearer ${kommoAccessToken}` }
      });
      console.log('✅ SUCCESS: Created a new DEAL in Kommo!');

    } catch (kommoError) {
      console.error('Kommo API Error:', kommoError.response?.data);
    }
  }

  res.sendStatus(200);
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
