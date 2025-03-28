require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

// Create temp directory if it doesn't exist
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Telegram bot token from environment variables
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set in .env file');
  process.exit(1);
}

// Whisper API URL from environment variables
const whisperApiUrl = process.env.WHISPER_API_URL;
if (!whisperApiUrl) {
  console.error('WHISPER_API_URL is not set in .env file');
  process.exit(1);
}

// Get authorized users from environment variables
const authorizedUsersStr = process.env.AUTHORIZED_USERS || '';
const authorizedUsers = authorizedUsersStr.split(',').map(id => id.trim()).filter(Boolean);

if (authorizedUsers.length === 0) {
  console.warn('No AUTHORIZED_USERS specified in .env file. Bot will be accessible to everyone.');
}

// Create a new bot instance
const bot = new Telegraf(token);

// Authorization middleware
bot.use((ctx, next) => {
  const userId = ctx.from?.id?.toString();
  
  // If no authorized users specified or user is authorized
  if (authorizedUsers.length === 0 || (userId && authorizedUsers.includes(userId))) {
    return next();
  }
  
  console.log(`Unauthorized access attempt by user ID: ${userId}`);
  return ctx.reply('Sorry, you are not authorized to use this bot.');
});

// Handle start command
bot.start((ctx) => {
  ctx.reply('Welcome! Send me a voice note, and I will transcribe it for you.');
});

// Handle help command
bot.help((ctx) => {
  ctx.reply('Send me a voice note, and I will transcribe it for you!');
});

// Handle text messages
bot.on('text', (ctx) => {
  ctx.reply('Send me a voice note, and I will transcribe it for you!');
});

// Handle voice messages
bot.on('voice', async (ctx) => {
  try {
    // Send initial processing message
    const statusMessage = await ctx.reply('Receiving your voice note...');
    
    // Get file information
    const fileId = ctx.message.voice.file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    
    // Update status
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      'Downloading voice note...'
    );
    
    // Download the file
    const response = await axios({
      method: 'GET',
      url: fileLink.href,
      responseType: 'stream'
    });
    
    const tempFilePath = path.join(tempDir, `${Date.now()}.oga`);
    const writer = fs.createWriteStream(tempFilePath);
    
    response.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    // Update status
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      'Transcribing with Shed.Gay Whisper API...'
    );
    
    // Prepare form data with the audio file
    const formData = new FormData();
    formData.append('audio_file', fs.createReadStream(tempFilePath));
    
    // Send request to Whisper API
    const whisperResponse = await axios.post(whisperApiUrl, formData, {
      headers: {
        ...formData.getHeaders(),
      },
    });
    
    // Clean up the temporary file
    fs.unlinkSync(tempFilePath);
    
    // Get the transcription text - handle the response format properly
    let transcription = 'No transcription returned';
    
    if (whisperResponse && whisperResponse.data) {
      // Debug the response structure
      console.log('Whisper API response:', JSON.stringify(whisperResponse.data));
      
      if (typeof whisperResponse.data === 'string') {
        transcription = whisperResponse.data;
      } else if (whisperResponse.data.text) {
        transcription = whisperResponse.data.text;
      } else if (whisperResponse.data.result) {
        transcription = whisperResponse.data.result;
      }
    }
    
    // Send the transcription to the user
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      `Transcription complete! Here's what you said:\n\n${transcription}`
    );
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Status code:', error.response.status);
    }
    await ctx.reply('Sorry, there was an error processing your voice note. Please try again later.');
  }
});

// Launch the bot
bot.launch();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Bot is running. Send a voice message to get started!'); 