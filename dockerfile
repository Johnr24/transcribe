FROM node:18-alpine

WORKDIR /app

# Install required system dependencies
RUN apk update && apk add --no-cache \
    ffmpeg \
    libgomp \
    python3 \
    py3-pip \
    build-base \
    libc6-compat \
    python3-dev

# Create and use Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python requirements for whisper-node with explicit indexes for Alpine compatibility
RUN pip install --no-cache-dir \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    torch==2.3.0 \
    torchaudio==2.3.0

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p temp

# Set memory limits and garbage collection flags
ENV NODE_OPTIONS="--max-old-space-size=3072 --expose-gc"
CMD ["npm", "start"]
