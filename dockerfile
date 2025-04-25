FROM node:18-alpine

WORKDIR /app

# Install required system dependencies
RUN apk update && apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip \
    build-base \
    libc6-compat

# Install Python requirements for whisper-node
RUN pip3 install --no-cache-dir torch torchaudio

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p temp

# Set memory limits and garbage collection flags
ENV NODE_OPTIONS="--max-old-space-size=3072 --expose-gc"
CMD ["npm", "start"]
