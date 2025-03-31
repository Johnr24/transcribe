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

// Handle video messages
bot.on('video', async (ctx) => {
  let statusMessage;
  let tempVideoPath; // Path for downloaded video
  let tempAudioPath; // Path for extracted audio
  const messageId = ctx.message?.message_id || 'unknown_video';
  console.log(`[${messageId}] Received video from user ${ctx.from.id}`);

  try {
    // Send initial processing message
    statusMessage = await ctx.reply('Receiving your video...');
    console.log(`[${messageId}] Sent initial status message ${statusMessage.message_id}`);

    // Get file information
    const fileId = ctx.message.video.file_id;
    console.log(`[${messageId}] Getting file link for file_id: ${fileId}`);
    const fileLink = await ctx.telegram.getFileLink(fileId);
    console.log(`[${messageId}] Got file link: ${fileLink.href}`);

    // Update status
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      'Downloading video...'
    );
    console.log(`[${messageId}] Updated status to Downloading`);

    // Download the video file
    const response = await axios({
      method: 'GET',
      url: fileLink.href,
      responseType: 'stream'
    });

    const fileExtension = ctx.message.video.mime_type ? `.${ctx.message.video.mime_type.split('/')[1]}` : '.mp4';
    tempVideoPath = path.join(tempDir, `${Date.now()}_${messageId}${fileExtension}`);
    const writer = fs.createWriteStream(tempVideoPath);
    console.log(`[${messageId}] Starting download to ${tempVideoPath}`);

    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`[${messageId}] Finished downloading video file`);
        resolve();
      });
      writer.on('error', (err) => {
        console.error(`[${messageId}] Error writing video file: ${err.message}`);
        reject(err);
      });
    });

    // Update status for audio extraction
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      'Extracting audio...'
    );
    console.log(`[${messageId}] Updated status to Extracting Audio`);

    // Extract audio using ffmpeg
    tempAudioPath = path.join(tempDir, `${Date.now()}_${messageId}.mp3`); // Output as mp3
    const ffmpegCommand = `ffmpeg -i "${tempVideoPath}" -vn -acodec libmp3lame -q:a 2 "${tempAudioPath}"`;
    console.log(`[${messageId}] Running ffmpeg command: ${ffmpegCommand}`);

    try {
      const { stdout, stderr } = await execPromise(ffmpegCommand);
      if (stderr) {
        console.log(`[${messageId}] ffmpeg stderr: ${stderr}`); // Log stderr even if command succeeds
      }
      console.log(`[${messageId}] ffmpeg stdout: ${stdout}`);
      console.log(`[${messageId}] Successfully extracted audio to ${tempAudioPath}`);
    } catch (ffmpegError) {
      console.error(`[${messageId}] ffmpeg execution failed: ${ffmpegError.message}`);
      console.error(`[${messageId}] ffmpeg stderr: ${ffmpegError.stderr}`); // Log stderr on error
      throw new Error(`Failed to extract audio: ${ffmpegError.message}`); // Rethrow to trigger main catch block
    }

    // Update status for transcription
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      'Transcribing extracted audio with Whisper API...'
    );
    console.log(`[${messageId}] Updated status to Transcribing`);

    // Prepare form data with the extracted audio file
    const formData = new FormData();
    formData.append('audio_file', fs.createReadStream(tempAudioPath));
    console.log(`[${messageId}] Prepared form data with audio file ${tempAudioPath}`);

    // Send request to Whisper API
    console.log(`[${messageId}] Sending request to Whisper API: ${whisperApiUrl}`);
    const whisperResponse = await axios.post(whisperApiUrl, formData, {
      headers: {
        ...formData.getHeaders(),
      },
    });
    console.log(`[${messageId}] Received response from Whisper API`);

    // Clean up temporary files (audio first, then video)
    console.log(`[${messageId}] Deleting temporary audio file: ${tempAudioPath}`);
    fs.unlinkSync(tempAudioPath);
    tempAudioPath = null;
    console.log(`[${messageId}] Deleting temporary video file: ${tempVideoPath}`);
    fs.unlinkSync(tempVideoPath);
    tempVideoPath = null;

    // Get the transcription text
    let transcription = 'No transcription returned';
    if (whisperResponse && whisperResponse.data) {
      console.log(`[${messageId}] Whisper API response (video):`, JSON.stringify(whisperResponse.data));
      if (typeof whisperResponse.data === 'string') {
        transcription = whisperResponse.data;
      } else if (whisperResponse.data.text) {
        transcription = whisperResponse.data.text;
      } else if (whisperResponse.data.result) {
        transcription = whisperResponse.data.result;
      } else {
         console.log(`[${messageId}] Unexpected Whisper API response format.`);
         transcription = 'Could not parse transcription from API response.';
      }
    } else {
       console.log(`[${messageId}] No data received from Whisper API.`);
    }

    // Send the transcription to the user
    console.log(`[${messageId}] Sending transcription to user`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      `Transcription complete! Here's the audio from your video:\n\n${transcription}`
    );
    console.log(`[${messageId}] Successfully sent transcription.`);

  } catch (error) {
    console.error(`[${messageId}] Error processing video:`, error.message);
    if (error.response) {
      console.error(`[${messageId}] API Response data:`, error.response.data);
      console.error(`[${messageId}] API Status code:`, error.response.status);
    } else if (error.stderr) { // Check for ffmpeg specific stderr
       console.error(`[${messageId}] Process stderr:`, error.stderr);
    } else {
      console.error(`[${messageId}] Full error object:`, error);
    }

    // Clean up temp files if they exist and an error occurred
    if (tempAudioPath && fs.existsSync(tempAudioPath)) {
        console.log(`[${messageId}] Cleaning up temp audio file due to error: ${tempAudioPath}`);
        try { fs.unlinkSync(tempAudioPath); } catch (e) { console.error(`[${messageId}] Error deleting temp audio file: ${e.message}`); }
    }
    if (tempVideoPath && fs.existsSync(tempVideoPath)) {
        console.log(`[${messageId}] Cleaning up temp video file due to error: ${tempVideoPath}`);
        try { fs.unlinkSync(tempVideoPath); } catch (e) { console.error(`[${messageId}] Error deleting temp video file: ${e.message}`); }
    }

    // Try to inform the user about the error
    try {
      if (statusMessage) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          'Sorry, there was an error processing your video. Please try again later.'
        );
         console.log(`[${messageId}] Edited status message to show error.`);
      } else {
        await ctx.reply('Sorry, there was an error processing your video. Please try again later.');
        console.log(`[${messageId}] Sent new reply to show error.`);
      }
    } catch (replyError) {
      console.error(`[${messageId}] Failed to notify user about the error: ${replyError.message}`);
    }
  }
});

// Handle video note messages (circular videos) - MOVED TO TOP LEVEL
bot.on('video_note', async (ctx) => {
  let statusMessage;
  let tempVideoPath; // Path for downloaded video note
  let tempAudioPath; // Path for extracted audio
  const messageId = ctx.message?.message_id || 'unknown_video_note';
  console.log(`[${messageId}] Received video note from user ${ctx.from.id}`);

  try {
    // Send initial processing message
    statusMessage = await ctx.reply('Receiving your video note...');
    console.log(`[${messageId}] Sent initial status message ${statusMessage.message_id}`);

    // Get file information
    const fileId = ctx.message.video_note.file_id;
    console.log(`[${messageId}] Getting file link for file_id: ${fileId}`);
    const fileLink = await ctx.telegram.getFileLink(fileId);
    console.log(`[${messageId}] Got file link: ${fileLink.href}`);

    // Update status
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      'Downloading video note...'
    );
    console.log(`[${messageId}] Updated status to Downloading`);

    // Download the video note file (typically mp4)
    const response = await axios({
      method: 'GET',
      url: fileLink.href,
      responseType: 'stream'
    });

    tempVideoPath = path.join(tempDir, `${Date.now()}_${messageId}.mp4`);
    const writer = fs.createWriteStream(tempVideoPath);
    console.log(`[${messageId}] Starting download to ${tempVideoPath}`);

    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`[${messageId}] Finished downloading video note file`);
        resolve();
      });
      writer.on('error', (err) => {
        console.error(`[${messageId}] Error writing video note file: ${err.message}`);
        reject(err);
      });
    });

    // Update status for audio extraction
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      'Extracting audio...'
    );
    console.log(`[${messageId}] Updated status to Extracting Audio`);

    // Extract audio using ffmpeg
    tempAudioPath = path.join(tempDir, `${Date.now()}_${messageId}.mp3`); // Output as mp3
    const ffmpegCommand = `ffmpeg -i "${tempVideoPath}" -vn -acodec libmp3lame -q:a 2 "${tempAudioPath}"`;
    console.log(`[${messageId}] Running ffmpeg command: ${ffmpegCommand}`);

    try {
      const { stdout, stderr } = await execPromise(ffmpegCommand);
      if (stderr) {
        console.log(`[${messageId}] ffmpeg stderr: ${stderr}`); // Log stderr even if command succeeds
      }
      console.log(`[${messageId}] ffmpeg stdout: ${stdout}`);
      console.log(`[${messageId}] Successfully extracted audio to ${tempAudioPath}`);
    } catch (ffmpegError) {
      console.error(`[${messageId}] ffmpeg execution failed: ${ffmpegError.message}`);
      console.error(`[${messageId}] ffmpeg stderr: ${ffmpegError.stderr}`); // Log stderr on error
      throw new Error(`Failed to extract audio: ${ffmpegError.message}`); // Rethrow to trigger main catch block
    }

    // Update status for transcription
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      'Transcribing extracted audio with Whisper API...'
    );
    console.log(`[${messageId}] Updated status to Transcribing`);

    // Prepare form data with the extracted audio file
    const formData = new FormData();
    formData.append('audio_file', fs.createReadStream(tempAudioPath));
    console.log(`[${messageId}] Prepared form data with audio file ${tempAudioPath}`);

    // Send request to Whisper API
    console.log(`[${messageId}] Sending request to Whisper API: ${whisperApiUrl}`);
    const whisperResponse = await axios.post(whisperApiUrl, formData, {
      headers: {
        ...formData.getHeaders(),
      },
    });
    console.log(`[${messageId}] Received response from Whisper API`);

    // Clean up temporary files (audio first, then video)
    console.log(`[${messageId}] Deleting temporary audio file: ${tempAudioPath}`);
    fs.unlinkSync(tempAudioPath);
    tempAudioPath = null;
    console.log(`[${messageId}] Deleting temporary video file: ${tempVideoPath}`);
    fs.unlinkSync(tempVideoPath);
    tempVideoPath = null;

    // Get the transcription text
    let transcription = 'No transcription returned';
    if (whisperResponse && whisperResponse.data) {
      console.log(`[${messageId}] Whisper API response (video_note):`, JSON.stringify(whisperResponse.data));
      if (typeof whisperResponse.data === 'string') {
        transcription = whisperResponse.data;
      } else if (whisperResponse.data.text) {
        transcription = whisperResponse.data.text;
      } else if (whisperResponse.data.result) {
        transcription = whisperResponse.data.result;
      } else {
         console.log(`[${messageId}] Unexpected Whisper API response format.`);
         transcription = 'Could not parse transcription from API response.';
      }
    } else {
       console.log(`[${messageId}] No data received from Whisper API.`);
    }

    // Send the transcription to the user
    console.log(`[${messageId}] Sending transcription to user`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      `Transcription complete! Here's the audio from your video note:\n\n${transcription}`
    );
    console.log(`[${messageId}] Successfully sent transcription.`);

  } catch (error) {
    console.error(`[${messageId}] Error processing video note:`, error.message);
     if (error.response) {
      console.error(`[${messageId}] API Response data:`, error.response.data);
      console.error(`[${messageId}] API Status code:`, error.response.status);
    } else if (error.stderr) { // Check for ffmpeg specific stderr
       console.error(`[${messageId}] Process stderr:`, error.stderr);
    } else {
      console.error(`[${messageId}] Full error object:`, error);
    }

    // Clean up temp files if they exist and an error occurred
    if (tempAudioPath && fs.existsSync(tempAudioPath)) {
        console.log(`[${messageId}] Cleaning up temp audio file due to error: ${tempAudioPath}`);
        try { fs.unlinkSync(tempAudioPath); } catch (e) { console.error(`[${messageId}] Error deleting temp audio file: ${e.message}`); }
    }
    if (tempVideoPath && fs.existsSync(tempVideoPath)) {
        console.log(`[${messageId}] Cleaning up temp video file due to error: ${tempVideoPath}`);
        try { fs.unlinkSync(tempVideoPath); } catch (e) { console.error(`[${messageId}] Error deleting temp video file: ${e.message}`); }
    }

    // Try to inform the user about the error
    try {
      if (statusMessage) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          'Sorry, there was an error processing your video note. Please try again later.'
        );
         console.log(`[${messageId}] Edited status message to show error.`);
      } else {
        await ctx.reply('Sorry, there was an error processing your video note. Please try again later.');
        console.log(`[${messageId}] Sent new reply to show error.`);
      }
    } catch (replyError) {
      console.error(`[${messageId}] Failed to notify user about the error: ${replyError.message}`);
    }
  }
});

// Launch the bot
bot.launch();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Bot is running. Send a voice message to get started!'); 