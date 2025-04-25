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

# Install Python requirements
# Note: whisper-node will install torch and torchaudio as dependencies
RUN pip install --no-cache-dir \
    whisper-node==1.2.0

# Rest of the Dockerfile remains the same...
COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p temp

# Set memory limits and garbage collection flags
ENV NODE_OPTIONS="--max-old-space-size=3072 --expose-gc"
CMD ["npm", "start"]
