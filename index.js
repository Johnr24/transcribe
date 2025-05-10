require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process'); // Import exec for running ffmpeg and whisper
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

// Whisper API URL from environment variables - No longer needed for local whisper CLI
// const whisperApiUrl = process.env.WHISPER_API_URL;
// if (!whisperApiUrl) {
//   console.error('WHISPER_API_URL is not set in .env file');
//   process.exit(1);
// }

// Get authorized users from environment variables
const authorizedUsersStr = process.env.AUTHORIZED_USERS || '';
const authorizedUsers = authorizedUsersStr.split(',').map(id => id.trim()).filter(Boolean);

if (authorizedUsers.length === 0) {
  console.warn('No AUTHORIZED_USERS specified in .env file. Bot will be accessible to everyone.');
}

// Create a new bot instance with increased handler timeout
// Set to 11 minutes (660000 ms) to accommodate long transcriptions
const bot = new Telegraf(token, {
  handlerTimeout: 660000
});

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
  ctx.reply('Welcome! Send me a voice note, audio, or video file, and I will transcribe it for you.');
});

// Handle help command
bot.help((ctx) => {
  ctx.reply('Send me a voice note, audio, or video file, and I will transcribe it for you!');
});

// Handle text messages
bot.on('text', (ctx) => {
  ctx.reply('Send me a voice note, audio, or video file, and I will transcribe it for you!');
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
    `Downloading ${fileType.replace(/_/g, ' ')}...` // Replace underscores for display
  );
  console.log(`[${messageId}] [${fileType}] Updated status to Downloading`);

  const response = await axios({
    method: 'GET',
    url: fileLink.href,
    responseType: 'stream'
  });

  // Determine file extension more robustly
  let fileExtension = '.dat'; // Default extension
  let originalFileName = `${Date.now()}_${messageId}`; // Base name

  if (ctx.message.voice) {
      fileExtension = '.oga';
  } else if (ctx.message.video) {
      fileExtension = `.${ctx.message.video.mime_type?.split('/')[1] || 'mp4'}`;
      originalFileName = ctx.message.video.file_name || originalFileName;
  } else if (ctx.message.video_note) {
      fileExtension = '.mp4';
  } else if (ctx.message.audio) {
      fileExtension = `.${ctx.message.audio.mime_type?.split('/')[1] || 'mp3'}`;
      originalFileName = ctx.message.audio.file_name || originalFileName;
  } else if (ctx.message.document) {
      fileExtension = path.extname(ctx.message.document.file_name || '.dat'); // Use original extension if available
      originalFileName = ctx.message.document.file_name || originalFileName;
  }

  // Sanitize filename and ensure extension is present
  const safeBaseName = path.basename(originalFileName, path.extname(originalFileName)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const tempFilePath = path.join(tempDir, `${safeBaseName}${fileExtension}`);

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

  // Use input filename base for output, ensuring uniqueness
  const inputBaseName = path.basename(inputPath, path.extname(inputPath));
  
  // Check if the input is an OPUS file
  const isOpus = path.extname(inputPath).toLowerCase() === '.opus';
  
  // For OPUS files, we need to transcode to a format Whisper can handle
  // For other files, proceed with standard extraction
  const outputFormat = isOpus ? 'wav' : 'mp3'; // Convert OPUS to WAV for better compatibility
  tempAudioPath = path.join(tempDir, `${inputBaseName}_converted.${outputFormat}`); // Output with new format

  // Use high quality encoding settings suitable for Whisper
  // For OPUS files, we'll do a more precise conversion
  const ffmpegCommand = isOpus 
    ? `ffmpeg -i "${inputPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${tempAudioPath}"` // Convert OPUS to WAV
    : `ffmpeg -i "${inputPath}" -vn -acodec libmp3lame -ab 192k -ar 16000 -ac 1 "${tempAudioPath}"`; // Existing MP3 conversion
  
  console.log(`[${messageId}] [${fileType}] Running ffmpeg command: ${ffmpegCommand}`);

  try {
    const { stdout, stderr } = await execPromise(ffmpegCommand);
    if (stderr) {
      console.log(`[${messageId}] [${fileType}] ffmpeg stderr: ${stderr}`);
    }
    // ffmpeg might output useful info to stdout too
    if (stdout) {
        console.log(`[${messageId}] [${fileType}] ffmpeg stdout: ${stdout}`);
    }
    console.log(`[${messageId}] [${fileType}] Successfully processed audio to ${tempAudioPath}`);
    return tempAudioPath;
  } catch (ffmpegError) {
    console.error(`[${messageId}] [${fileType}] ffmpeg execution failed: ${ffmpegError.message}`);
    console.error(`[${messageId}] [${fileType}] ffmpeg stderr: ${ffmpegError.stderr}`);
    // Clean up failed audio path if it exists
     if (tempAudioPath && fs.existsSync(tempAudioPath)) {
        try { fs.unlinkSync(tempAudioPath); } catch (e) { console.error(`[${messageId}] Error deleting failed temp audio file: ${e.message}`); }
    }
    throw new Error(`Failed to process audio: ${ffmpegError.message}`);
  }
}

// Function to transcribe an audio file using Whisper CLI
async function transcribeAudio(ctx, audioPath, fileType, statusMessage) {
  const messageId = ctx.message?.message_id || `unknown_${fileType}`;
  // Determine the expected output path based on Whisper's default naming convention
  // It uses the input filename base and places it in the output directory.
  const audioBaseName = path.basename(audioPath, path.extname(audioPath));
  const outputTxtPath = path.join(tempDir, `${audioBaseName}.txt`); // Whisper appends .txt by default

  try {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMessage.message_id,
      undefined,
      `Transcribing ${fileType.includes('audio') ? 'audio' : 'extracted audio'}... (using openai-whisper)`
    );
    console.log(`[${messageId}] [${fileType}] Updated status to Transcribing (openai-whisper)`);

    // Construct the whisper command
    // Using 'medium' model as per previous config/user request
    // Using 'en' language as suggested by the user (can be parameterized)
    // Outputting only TXT format to the tempDir
    // Using --fp16 False as suggested by the user (suitable for CPU)
    // Whisper will automatically name the output file based on the input file name within the output_dir
    const whisperCommand = `whisper "${audioPath}" --model medium --language en --output_dir "${tempDir}" --output_format txt --fp16 False`;

    console.log(`[${messageId}] [${fileType}] Running whisper command: ${whisperCommand}`);

    // Execute the command
    // Increase maxBuffer size for potentially long stderr output from whisper
    // Increase timeout significantly (e.g., 10 minutes) as transcription can be slow
    const execOptions = {
        maxBuffer: 1024 * 1024 * 5, // 5MB buffer
        timeout: 600000 // 10 minutes in milliseconds
    };
    const { stdout, stderr } = await execPromise(whisperCommand, execOptions);

    // Whisper often outputs progress and details to stderr
    if (stderr) {
      console.log(`[${messageId}] [${fileType}] whisper stderr:\n${stderr}`);
    }
    // stdout might be empty or contain final confirmation
    if (stdout) {
        console.log(`[${messageId}] [${fileType}] whisper stdout:\n${stdout}`);
    }

    console.log(`[${messageId}] [${fileType}] Transcription command finished`);

    // Check if the output file exists
    if (!fs.existsSync(outputTxtPath)) {
        console.error(`[${messageId}] [${fileType}] Transcription output file not found: ${outputTxtPath}`);
        // Log stderr again specifically in case of file not found error
        console.error(`[${messageId}] [${fileType}] stderr that might contain error: ${stderr}`);
        throw new Error('Transcription failed: Output file not generated.');
    }

    // Read the transcription from the file
    const transcription = fs.readFileSync(outputTxtPath, 'utf8').trim();
    console.log(`[${messageId}] [${fileType}] Transcription read successfully from ${outputTxtPath}`);

    // Basic check for empty transcription
    if (!transcription) {
        console.warn(`[${messageId}] [${fileType}] Transcription result is empty.`);
        // Optionally inform the user or return a specific message
        // return "[Transcription result was empty]";
    }

    return transcription;

  } catch (error) {
      console.error(`[${messageId}] [${fileType}] Error during whisper CLI execution: ${error.message}`);
      if (error.stderr) {
          console.error(`[${messageId}] [${fileType}] whisper stderr: ${error.stderr}`);
      }
      if (error.stdout) {
          console.error(`[${messageId}] [${fileType}] whisper stdout: ${error.stdout}`);
      }
      // Rethrow a more specific error if possible
      if (error.message.includes('FileNotFoundError')) {
           throw new Error(`Transcription failed: Could not find input file for whisper. ${error.message}`);
      }
      if (error.message.includes('torch.cuda.OutOfMemoryError')) {
          throw new Error(`Transcription failed: Out of memory. Try a smaller model or shorter audio. ${error.message}`);
      }
      throw error; // Re-throw the original or modified error
  } finally {
    // Clean up the generated transcription file(s)
    // Whisper might create other files if format changes or based on exact version.
    // We know the .txt path, let's clean that and potentially others with the same base name.
    const outputBaseName = path.basename(outputTxtPath, '.txt'); // Get the base name without .txt
    const possibleExtensions = ['.txt', '.vtt', '.srt', '.tsv', '.json'];
    possibleExtensions.forEach(ext => {
        const filePath = path.join(tempDir, `${outputBaseName}${ext}`);
        if (fs.existsSync(filePath)) {
            console.log(`[${messageId}] [${fileType}] Cleaning up whisper output file: ${filePath}`);
            try { fs.unlinkSync(filePath); } catch (e) { console.error(`[${messageId}] Error deleting whisper output file ${filePath}: ${e.message}`); }
        }
    });

    // No model cleanup needed for CLI approach
    // Garbage collection can still be useful for Node.js process itself
    if (global.gc) {
      global.gc();
      console.log(`[${messageId}] [${fileType}] Forced garbage collection`);
    }
  }
}

// Main processing function for media files
async function processMediaFile(ctx, fileId, fileType, needsAudioExtraction) {
  let statusMessage;
  let tempFilePath = null; // Path for downloaded file
  let tempAudioPath = null; // Path for extracted audio (if needed)
  const messageId = ctx.message?.message_id || `unknown_${fileType}`;
  console.log(`[${messageId}] [${fileType}] Received ${fileType.replace(/_/g, ' ')} from user ${ctx.from.id}`);

  try {
    statusMessage = await ctx.reply(`Receiving your ${fileType.replace(/_/g, ' ')}...`);
    console.log(`[${messageId}] [${fileType}] Sent initial status message ${statusMessage.message_id}`);

    // 1. Download file
    tempFilePath = await downloadTelegramFile(ctx, fileId, fileType, statusMessage);

    // 2. Extract Audio (if needed)
    let audioPathForTranscription = tempFilePath;
    if (needsAudioExtraction) {
      tempAudioPath = await extractAudio(ctx, tempFilePath, fileType, statusMessage);
      audioPathForTranscription = tempAudioPath; // Use extracted audio for transcription
    } else {
      // Optional: Convert non-mp3 audio to mp3 for consistency?
      // Whisper CLI handles many formats, but converting might improve robustness or allow specific ffmpeg preprocessing.
      // For now, we assume Whisper CLI handles the downloaded format directly if no extraction is needed.
      console.log(`[${messageId}] [${fileType}] Using original downloaded file for transcription: ${audioPathForTranscription}`);
    }

    // 3. Transcribe Audio
    const transcription = await transcribeAudio(ctx, audioPathForTranscription, fileType, statusMessage);

    // 4. Send Result
    console.log(`[${messageId}] [${fileType}] Sending transcription to user`);
    // Check if transcription is too long for a single message
    const MAX_MSG_LENGTH = 4096;
    const resultText = `Transcription:\n\n${transcription || "[No speech detected or transcription empty]"}`;

    if (resultText.length <= MAX_MSG_LENGTH) {
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            undefined,
            resultText
        );
    } else {
        // Send initial part in edited message
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMessage.message_id,
            undefined,
            resultText.substring(0, MAX_MSG_LENGTH)
        );
        // Send remaining parts in new messages
        for (let i = MAX_MSG_LENGTH; i < resultText.length; i += MAX_MSG_LENGTH) {
            await ctx.reply(resultText.substring(i, i + MAX_MSG_LENGTH));
        }
         console.log(`[${messageId}] [${fileType}] Sent long transcription in multiple parts.`);
    }

    console.log(`[${messageId}] [${fileType}] Successfully sent transcription.`);

  } catch (error) {
    console.error(`[${messageId}] [${fileType}] Error processing ${fileType}:`, error.message);
    if (error.response) { // Axios error details
      console.error(`[${messageId}] [${fileType}] API Response data:`, error.response.data);
      console.error(`[${messageId}] [${fileType}] API Status code:`, error.response.status);
    } else if (error.stderr) { // Check for stderr from execPromise errors (ffmpeg, whisper)
       console.error(`[${messageId}] [${fileType}] Process stderr:`, error.stderr);
    } else {
      console.error(`[${messageId}] [${fileType}] Full error object:`, error);
    }

    // Notify user about the error
    try {
      const userErrorMessage = `Sorry, there was an error processing your ${fileType.replace(/_/g, ' ')}. Details: ${error.message.substring(0, 100)}`; // Provide a snippet of the error
      if (statusMessage) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          undefined,
          userErrorMessage
        );
         console.log(`[${messageId}] [${fileType}] Edited status message to show error.`);
      } else {
        await ctx.reply(userErrorMessage);
        console.log(`[${messageId}] [${fileType}] Sent new reply to show error.`);
      }
    } catch (replyError) {
      console.error(`[${messageId}] [${fileType}] Failed to notify user about the error: ${replyError.message}`);
    }
  } finally {
    // 5. Cleanup ALL temporary files involved in this request
    const filesToDelete = [tempAudioPath, tempFilePath]; // Add paths that might exist

    // Also add potential whisper output files based on the *original* input file name base,
    // as transcribeAudio's finally block might not run if an error occurred before it.
    const originalInputBaseName = tempFilePath ? path.basename(tempFilePath, path.extname(tempFilePath)) : null;
    if (originalInputBaseName) {
        const possibleExtensions = ['.txt', '.vtt', '.srt', '.tsv', '.json'];
        possibleExtensions.forEach(ext => {
            filesToDelete.push(path.join(tempDir, `${originalInputBaseName}${ext}`));
        });
    }
    // If audio was extracted, also add potential whisper outputs based on the extracted file name
    const extractedAudioBaseName = tempAudioPath ? path.basename(tempAudioPath, path.extname(tempAudioPath)) : null;
     if (extractedAudioBaseName && extractedAudioBaseName !== originalInputBaseName) {
        const possibleExtensions = ['.txt', '.vtt', '.srt', '.tsv', '.json'];
        possibleExtensions.forEach(ext => {
            filesToDelete.push(path.join(tempDir, `${extractedAudioBaseName}${ext}`));
        });
    }

    // Use a Set to avoid trying to delete the same file multiple times
    const uniqueFilesToDelete = [...new Set(filesToDelete)];

    uniqueFilesToDelete.forEach(filePath => {
        if (filePath && fs.existsSync(filePath)) {
            console.log(`[${messageId}] [${fileType}] Cleaning up temp file: ${filePath}`);
            try { fs.unlinkSync(filePath); } catch (e) { console.error(`[${messageId}] Error deleting temp file ${filePath}: ${e.message}`); }
        }
    });
  }
}

// ================== Bot Handlers ==================

// Handle voice messages
bot.on('voice', async (ctx) => {
  const fileId = ctx.message.voice.file_id;
  await processMediaFile(ctx, fileId, 'voice', false); // Whisper CLI handles .oga directly
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

// Handle audio messages (sent as audio file)
bot.on('audio', async (ctx) => {
  console.log('>>> Audio handler entered <<<');
  const audio = ctx.message.audio;
  const fileId = audio.file_id;
  // Use 'audio' as fileType for logging/status messages
  await processMediaFile(ctx, fileId, 'audio', false); // Whisper CLI handles common audio formats
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
  // These are types Whisper CLI generally supports via ffmpeg backend
  const supportedAudioTypes = [
    'audio/ogg', 'audio/vorbis', // oga, ogg
    'audio/mpeg', 'audio/mp3', // mp3
    'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/x-pn-wav', // wav
    'audio/aac', // aac
    'audio/flac', 'audio/x-flac', // flac
    'audio/opus', // opus
    'audio/mp4', 'audio/x-m4a', // m4a
    'audio/amr', // amr
    'audio/webm', // webm audio
  ];
  const supportedVideoTypes = [
      'video/mp4',
      'video/mpeg',
      'video/quicktime', // mov
      'video/webm',
      'video/x-msvideo', // avi
      'video/x-matroska', // mkv
      'video/x-flv', // flv
      'video/3gpp', // 3gp
      'video/x-ms-wmv', // wmv
    ];

  if (supportedAudioTypes.includes(mimeType)) {
    console.log(`[${messageId}] [document] Processing as audio document.`);
    // Use 'audio_document' as fileType for logging/status messages
    await processMediaFile(ctx, fileId, 'audio_document', false); // Let Whisper handle format
  } else if (supportedVideoTypes.includes(mimeType)) {
    console.log(`[${messageId}] [document] Processing as video document.`);
    // Use 'video_document' as fileType for logging/status messages
    await processMediaFile(ctx, fileId, 'video_document', true); // Extract audio first
  } else {
    console.log(`[${messageId}] [document] Unsupported file type: ${mimeType} for file ${doc.file_name}`);
    await ctx.reply(`Sorry, I can only transcribe common audio and video file types. The received file type (${mimeType}) might not be supported directly.`);
  }
});

// Launch the bot
bot.launch().then(() => {
    console.log('Bot launched successfully!');
}).catch(err => {
    console.error('Failed to launch bot:', err);
});

// Enable graceful stop
process.once('SIGINT', () => { console.log('SIGINT received...'); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { console.log('SIGTERM received...'); bot.stop('SIGTERM'); });

console.log('Bot is starting...');
