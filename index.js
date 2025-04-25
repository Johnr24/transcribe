require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process'); // Import exec for running ffmpeg
const util = require('util'); // Import util for promisify
const execPromise = util.promisify(exec); // Promisify exec

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
// ================== Helper Functions ==================

// Function to download a file from Telegram
async function downloadTelegramFile(ctx, fileId, fileType, statusMessage) {
  const messageId = ctx.message?.message_id || `unknown_${fileType}`;
  console.log(`[${messageId}] [${fileType}] Getting file link for file_id: ${fileId}`);
  const fileLink = await ctx.telegram.getFileLink(fileId);
  console.log(`[${messageId}] [${fileType}] Got file link: ${fileLink.href}`);

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMessage.message_id,
    undefined,
    `Downloading ${fileType.replace('_', ' ')}...`
  );
  console.log(`[${messageId}] [${fileType}] Updated status to Downloading`);

  const response = await axios({
    method: 'GET',
    url: fileLink.href,
    responseType: 'stream'
  });

  // Determine file extension
  let fileExtension = '.dat'; // Default extension
  if (ctx.message.voice) fileExtension = '.oga';
  else if (ctx.message.video) fileExtension = `.${ctx.message.video.mime_type?.split('/')[1] || 'mp4'}`;
  else if (ctx.message.video_note) fileExtension = '.mp4';
  else if (ctx.message.document) fileExtension = `.${ctx.message.document.mime_type?.split('/')[1] || 'dat'}`;


  const tempFilePath = path.join(tempDir, `${Date.now()}_${messageId}${fileExtension}`);
  const writer = fs.createWriteStream(tempFilePath);
  console.log(`[${messageId}] [${fileType}] Starting download to ${tempFilePath}`);

  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on('finish', () => {
      console.log(`[${messageId}] [${fileType}] Finished downloading file`);
      resolve();
    });
    writer.on('error', (err) => {
      console.error(`[${messageId}] [${fileType}] Error writing file: ${err.message}`);
      reject(err);
    });
  });

  return tempFilePath;
}

// Function to extract audio using ffmpeg
async function extractAudio(ctx, inputPath, fileType, statusMessage) {
  const messageId = ctx.message?.message_id || `unknown_${fileType}`;
  let tempAudioPath = null;

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMessage.message_id,
    undefined,
    'Extracting audio...'
  );
  console.log(`[${messageId}] [${fileType}] Updated status to Extracting Audio`);

  tempAudioPath = path.join(tempDir, `${Date.now()}_${messageId}.mp3`); // Output as mp3
  const ffmpegCommand = `ffmpeg -i "${inputPath}" -vn -acodec libmp3lame -q:a 2 "${tempAudioPath}"`;
  console.log(`[${messageId}] [${fileType}] Running ffmpeg command: ${ffmpegCommand}`);

  try {
    const { stdout, stderr } = await execPromise(ffmpegCommand);
    if (stderr) {
      console.log(`[${messageId}] [${fileType}] ffmpeg stderr: ${stderr}`);
    }
    console.log(`[${messageId}] [${fileType}] ffmpeg stdout: ${stdout}`);
    console.log(`[${messageId}] [${fileType}] Successfully extracted audio to ${tempAudioPath}`);
    return tempAudioPath;
  } catch (ffmpegError) {
    console.error(`[${messageId}] [${fileType}] ffmpeg execution failed: ${ffmpegError.message}`);
    console.error(`[${messageId}] [${fileType}] ffmpeg stderr: ${ffmpegError.stderr}`);
    // Clean up failed audio path if it exists
     if (tempAudioPath && fs.existsSync(tempAudioPath)) {
        try { fs.unlinkSync(tempAudioPath); } catch (e) { console.error(`[${messageId}] Error deleting failed temp audio file: ${e.message}`); }
    }
    throw new Error(`Failed to extract audio: ${ffmpegError.message}`);
  }
}

// Function to transcribe an audio file using Whisper API
async function transcribeAudio(ctx, audioPath, fileType, statusMessage) {
  const messageId = ctx.message?.message_id || `unknown_${fileType}`;

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    statusMessage.message_id,
    undefined,
    `Transcribing ${fileType.includes('audio') ? 'audio' : 'extracted audio'} with Whisper API...`
  );
  console.log(`[${messageId}] [${fileType}] Updated status to Transcribing`);

  const formData = new FormData();
  formData.append('audio_file', fs.createReadStream(audioPath));
  console.log(`[${messageId}] [${fileType}] Prepared form data with audio file ${audioPath}`);

  console.log(`[${messageId}] [${fileType}] Sending request to Whisper API: ${whisperApiUrl}`);
  const whisperResponse = await axios.post(whisperApiUrl, formData, {
    headers: {
      ...formData.getHeaders(),
    },
  });
  console.log(`[${messageId}] [${fileType}] Received response from Whisper API`);

  // Parse transcription
  let transcription = 'No transcription returned';
  if (whisperResponse && whisperResponse.data) {
    console.log(`[${messageId}] [${fileType}] Whisper API response:`, JSON.stringify(whisperResponse.data));
    if (typeof whisperResponse.data === 'string') {
      transcription = whisperResponse.data;
    } else if (whisperResponse.data.text) {
      transcription = whisperResponse.data.text;
    } else if (whisperResponse.data.result) {
      transcription = whisperResponse.data.result;
    } else {
       console.log(`[${messageId}] [${fileType}] Unexpected Whisper API response format.`);
       transcription = 'Could not parse transcription from API response.';
    }
  } else {
     console.log(`[${messageId}] [${fileType}] No data received from Whisper API.`);
  }
  return transcription;
}

// Main processing function for media files
async function processMediaFile(ctx, fileId, fileType, needsAudioExtraction) {
  let statusMessage;
  let tempFilePath = null; // Path for downloaded file
  let tempAudioPath = null; // Path for extracted audio (if needed)
  const messageId = ctx.message?.message_id || `unknown_${fileType}`;
  console.log(`[${messageId}] [${fileType}] Received ${fileType.replace('_', ' ')} from user ${ctx.from.id}`);

  try {
    statusMessage = await ctx.reply(`Receiving your ${fileType.replace('_', ' ')}...`);
    console.log(`[${messageId}] [${fileType}] Sent initial status message ${statusMessage.message_id}`);

    // 1. Download file
    tempFilePath = await downloadTelegramFile(ctx, fileId, fileType, statusMessage);

    // 2. Extract Audio (if needed)
    let audioPathForTranscription = tempFilePath;
    if (needsAudioExtraction) {
      tempAudioPath = await extractAudio(ctx, tempFilePath, fileType, statusMessage);
      audioPathForTranscription = tempAudioPath; // Use extracted audio for transcription
    }

    // 3. Transcribe Audio
    const transcription = await transcribeAudio(ctx, audioPathForTranscription, fileType, statusMessage);

    // 4. Send Result
    console.log(`[${messageId}] [${fileType}] Sending transcription to user`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      `Transcription complete! Here's the content:\n\n${transcription}`
    );
    console.log(`[${messageId}] [${fileType}] Successfully sent transcription.`);

  } catch (error) {
    console.error(`[${messageId}] [${fileType}] Error processing ${fileType}:`, error.message);
    if (error.response) {
      console.error(`[${messageId}] [${fileType}] API Response data:`, error.response.data);
      console.error(`[${messageId}] [${fileType}] API Status code:`, error.response.status);
    } else if (error.stderr) { // Check for ffmpeg specific stderr
       console.error(`[${messageId}] [${fileType}] Process stderr:`, error.stderr);
    } else {
      console.error(`[${messageId}] [${fileType}] Full error object:`, error);
    }

    // Notify user about the error
    try {
      if (statusMessage) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          `Sorry, there was an error processing your ${fileType.replace('_', ' ')}. Please try again later.`
        );
         console.log(`[${messageId}] [${fileType}] Edited status message to show error.`);
      } else {
        await ctx.reply(`Sorry, there was an error processing your ${fileType.replace('_', ' ')}. Please try again later.`);
        console.log(`[${messageId}] [${fileType}] Sent new reply to show error.`);
      }
    } catch (replyError) {
      console.error(`[${messageId}] [${fileType}] Failed to notify user about the error: ${replyError.message}`);
    }
  } finally {
    // 5. Cleanup ALL temporary files
    if (tempAudioPath && fs.existsSync(tempAudioPath)) {
        console.log(`[${messageId}] [${fileType}] Cleaning up temp audio file: ${tempAudioPath}`);
        try { fs.unlinkSync(tempAudioPath); } catch (e) { console.error(`[${messageId}] Error deleting temp audio file: ${e.message}`); }
    }
    if (tempFilePath && fs.existsSync(tempFilePath)) {
        console.log(`[${messageId}] [${fileType}] Cleaning up temp media file: ${tempFilePath}`);
        try { fs.unlinkSync(tempFilePath); } catch (e) { console.error(`[${messageId}] Error deleting temp media file: ${e.message}`); }
    }
  }
}

// ================== Bot Handlers ==================

// Handle voice messages
bot.on('voice', async (ctx) => {
  const fileId = ctx.message.voice.file_id;
  await processMediaFile(ctx, fileId, 'voice', false); // No audio extraction needed for voice
});

// Handle video messages
bot.on('video', async (ctx) => {
  const fileId = ctx.message.video.file_id;
  await processMediaFile(ctx, fileId, 'video', true); // Needs audio extraction
});

// Handle video note messages (circular videos)
bot.on('video_note', async (ctx) => {
  const fileId = ctx.message.video_note.file_id;
  await processMediaFile(ctx, fileId, 'video_note', true); // Needs audio extraction
});

// Handle audio messages (sent as audio file, possibly forwarded)
bot.on('audio', async (ctx) => {
  console.log('>>> Audio handler entered <<<');
  const audio = ctx.message.audio;
  const fileId = audio.file_id;
  // Use 'audio' as fileType for logging/status messages
  await processMediaFile(ctx, fileId, 'audio', false); // No extraction needed
});

// Handle document messages (generic attachments)
bot.on('document', async (ctx) => {
  console.log('>>> Document handler entered <<<');
  const doc = ctx.message.document;
  const fileId = doc.file_id;
  const mimeType = doc.mime_type || 'application/octet-stream';
  const messageId = ctx.message?.message_id || 'unknown_document';

  console.log(`[${messageId}] [document] Received document: ${doc.file_name}, MIME type: '${mimeType}', Size: ${doc.file_size}`);

  // Define supported MIME types for transcription (expanded list)
  const supportedAudioTypes = [
    'audio/ogg',
    'audio/mpeg', // Common for MP3
    'audio/mp3',
    'audio/wav',
    'audio/x-wav', // Variations for WAV
    'audio/wave',
    'audio/x-pn-wav',
    'audio/aac',
    'audio/flac',
    'audio/opus',
    'audio/m4a'
  ];
  const supportedVideoTypes = ['video/mp4', 'video/mpeg', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska']; // AVI, MKV

  if (supportedAudioTypes.includes(mimeType)) {
    console.log(`[${messageId}] [document] Processing as audio document.`);
    // Use 'audio_document' as fileType for logging/status messages
    await processMediaFile(ctx, fileId, 'audio_document', false);
  } else if (supportedVideoTypes.includes(mimeType)) {
    console.log(`[${messageId}] [document] Processing as video document.`);
    // Use 'video_document' as fileType for logging/status messages
    await processMediaFile(ctx, fileId, 'video_document', true);
  } else {
    console.log(`[${messageId}] [document] Unsupported file type: ${mimeType}`);
    await ctx.reply(`Sorry, I can only transcribe audio and video files. The received file type (${mimeType}) is not supported.`);
  }
});

// Launch the bot
bot.launch();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Bot is running. Send a voice message to get started!'); 