FROM node:18-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
# Install ffmpeg for audio extraction and then install node modules
RUN apk update && apk add --no-cache ffmpeg && npm install

# Copy application files
COPY . .

# Create temp directory for audio files
RUN mkdir -p temp

# Run the bot
CMD ["npm", "start"]