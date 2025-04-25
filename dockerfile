# Change base image to Debian-based
FROM node:18-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create and activate Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python requirements in the virtual environment
# Install openai-whisper and its dependencies (torch, torchaudio)
RUN pip install --no-cache-dir \
    openai-whisper \
    torch \
    torchaudio

# Rest of the Dockerfile remains the same...
COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p temp

# Set memory limits and garbage collection flags
ENV NODE_OPTIONS="--max-old-space-size=3072 --expose-gc"
CMD ["npm", "start"]
