const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// ===== PASTE YOUR KEYS HERE =====
const KEYS = {
  KOMMO_CLIENT_ID: 'a73fbba0-dfd7-48ca-87fe-e1adb583854d', // From Kommo > Settings > Integrations > API
  KOMMO_CLIENT_SECRET: '3KFvkpcWbJH24EGPapiybUQpVpennkd2ChvfYRRaTO97aaOcm6ti5arNTmuDLF59', // From Kommo > Settings > Integrations > API
  KOMMO_SUBDOMAIN: 'medkhoulali18', // Just the subdomain: 'yourcompany' from 'yourcompany.kommo.com'
  TELEGRAM_BOT_TOKEN: '8477776790:AAFcy_q19eJAbyN3Vfcjaqo2RE5cU8r8LUc', // From @BotFather on Telegram
  OPENAI_API_KEY: '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' // From platform.openai.com/api-keys
};
// =================================

// In a real app, use a database. For this demo, we'll use a variable.
// YOUR TOKEN WILL RESET IF THE SERVER RESTARTS.
let kommoAccessToken = null;

// 1. Route to start the Kommo connection (Open this in your browser)
app.get('/auth', (req, res) => {
  // We now dynamically get the hostname from the request, ensuring it's always correct
  const redirectUri = `https://${req.get('host')}/oauth`;
  const authUrl = `https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/oauth?client_id=${KEYS.KOMMO_CLIENT_ID}&mode=post_message&redirect_uri=${encodeURIComponent(redirectUri)}`;
  
  res.send(`<a href="${authUrl}">Click HERE to Connect Your Kommo Account</a>`);
});

// 2. Route where Kommo sends the access token after auth
app.get('/oauth', async (req, res) => {
  const { code } = req.query;
  
  // Check if we got a code from Kommo
  if (!code) {
    return res.status(400).send('Authorization failed: No code received from Kommo.');
  }

  try {
    // We must use the same redirect_uri here that we used in the /auth step
    const redirectUri = `https://${req.get('host')}/oauth`;
    
    const response = await axios.post(`https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/oauth2/access_token`, {
      client_id: KEYS.KOMMO_CLIENT_ID,
      client_secret: KEYS.KOMMO_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri // Use the dynamically generated URI
    });
    
    kommoAccessToken = response.data.access_token;
    res.send('Kommo Connected Successfully! You can close this tab and go message your Telegram bot. The AI is now ready!');
    
  } catch (error) {
    console.error('Kommo Auth Error:');
    console.error('Full Error Object:', error.response?.data || error.message);
    
    // More helpful error message for the browser
    let errorMessage = '<h2>Error connecting to Kommo.</h2><p>Check the server logs for details. Common causes:</p>';
    errorMessage += '<ul><li>Mismatched Redirect URI in Kommo App Settings</li>';
    errorMessage += '<li>Incorrect Client ID or Secret</li>';
    errorMessage += '<li>Wrong Kommo subdomain</li></ul>';
    errorMessage += `<p>Your Redirect URI must be set to: <strong>https://${req.get('host')}/oauth</strong></p>`;
    
    res.send(errorMessage);
  }
});

// 3. Main Webhook - Telegram sends messages here
app.post('/webhook', async (req, res) => {
  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userText = message.text;

  console.log('User said:', userText);

  // 4. Generate AI Response with OpenAI
  let aiResponse = "Hello! I'm your real estate AI assistant. How can I help you find a property today?";
  try {
    const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [{
        role: 'user',
        content: `Act as a friendly real estate agent. A client texted this: "${userText}". Respond helpfully and ask one question to learn more about their needs (like budget, location, or type of home). Keep it short.`
      }]
    }, {
      headers: { 'Authorization': `Bearer ${KEYS.OPENAI_API_KEY}` }
    });
    aiResponse = openaiResponse.data.choices[0].message.content;
  } catch (error) {
    console.error('OpenAI Error:', error.response?.data);
  }

  // 5. Send the AI response back to Telegram
  try {
    await axios.post(`https://api.telegram.org/bot${KEYS.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: aiResponse
    });
  } catch (error) {
    console.error('Telegram Send Error:', error.response?.data);
  }

  // 6. KOMMO INTEGRATION: Save Contact & Create Deal if qualified
  if (kommoAccessToken) {
    try {
      // A. Create or find the contact in Kommo (using Telegram user ID as a demo identifier)
      const kommoContact = await axios.post(`https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/api/v4/contacts`, [{
        name: `${message.from.first_name} ${message.from.last_name || ''}`.trim(),
        custom_fields_values: [{
          field_code: 'PHONE',
          values: [{ value: message.from.id.toString() }] // Using ID as a fake number
        }]
      }], {
        headers: { 'Authorization': `Bearer ${kommoAccessToken}` }
      });
      const contactId = kommoContact.data._embedded.contacts[0].id;

      // B. Add a note about the interaction
      await axios.post(`https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/api/v4/events`, [{
        entity_id: contactId,
        note: `Telegram Conversation:\nUser: ${userText}\nAI: ${aiResponse}`
      }], {
        headers: { 'Authorization': `Bearer ${kommoAccessToken}` }
      });

      // C. CHECK FOR KEYWORDS TO CONVERT TO A DEAL!
      const lowerText = userText.toLowerCase();
      if (lowerText.includes('buy') || lowerText.includes('interested') || lowerText.includes('budget') || lowerText.includes('viewing')) {
        await axios.post(`https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads`, [{
          name: `New Lead from Telegram: ${message.from.first_name}`,
          pipeline_id: 123456, // <<< REPLACE WITH YOUR KOMMO PIPELINE ID
          status_id: 1234567,  // <<< REPLACE WITH YOUR KOMMO STATUS ID
          _embedded: { contacts: [{ id: contactId }] }
        }], {
          headers: { 'Authorization': `Bearer ${kommoAccessToken}` }
        });
        console.log('✅ SUCCESS: Created a new DEAL in Kommo!');
      }

    } catch (kommoError) {
      console.error('Kommo API Error:', kommoError.response?.data);
    }
  }

  res.sendStatus(200);
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
