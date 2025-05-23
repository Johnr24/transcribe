FROM node:18-slim

# Install dependencies for ffmpeg and whisper
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    git \
    && rm -rf /var/lib/apt/lists/*

# Create and activate virtual environment for whisper
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install whisper in the virtual environment
RUN pip3 install git+https://github.com/openai/whisper.git

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy app source
COPY . .

# Create temp directory for file processing
RUN mkdir -p /tmp/telegram-bot

# Set environment variables
ENV NODE_ENV=production
ENV TEMP_DIR=/tmp/telegram-bot

# Start the bot
CMD ["node", "index.js"]
