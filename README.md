# Telegram Voice Note Transcription Bot

A Telegram bot that receives voice notes and transcribes them using a local Whisper API server.

## Setup

### Standard Setup

1. Install dependencies:
```
npm install
```

2. Create a `.env` file with your Telegram bot token and other settings:
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
WHISPER_API_URL=http://localhost:3017/asr
AUTHORIZED_USERS=123456789,987654321
```

For `AUTHORIZED_USERS`, enter the Telegram user IDs of users allowed to use the bot, separated by commas. 
If left empty, the bot will be accessible to anyone. You can find your Telegram ID by messaging @userinfobot on Telegram.

3. Make sure the Whisper API server is running:
```
docker run -d -p 3017:9000 \
  -e ASR_MODEL=base \
  -e ASR_ENGINE=openai_whisper \
  --restart=always \
  --name openai-whisper-asr-webservice \
  onerahmet/openai-whisper-asr-webservice:latest
```

4. Start the bot:
```
npm start
```

### Docker Setup (Recommended)

1. Create a `.env` file with your Telegram bot token and authorized users:
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
AUTHORIZED_USERS=123456789,987654321
```

2. Run with docker-compose:
```
docker-compose up -d
```

This will start both the Whisper API server and the Telegram bot in separate containers.

## Usage

Send a voice note to your bot, and it will transcribe it using Whisper and reply with the text.

## Technical Details

This bot uses:
- Telegraf framework for interacting with the Telegram Bot API
- Axios for making HTTP requests
- Whisper API for speech-to-text transcription
- User authorization to restrict access to specific Telegram users 