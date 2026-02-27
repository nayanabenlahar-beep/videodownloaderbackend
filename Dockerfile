FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    nodejs \
    npm \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip install --no-cache-dir yt-dlp

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install --production

# Copy application files
COPY . .

# Expose port
EXPOSE 3001

# Start server
CMD ["node", "server.js"]
