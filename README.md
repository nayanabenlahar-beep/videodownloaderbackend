# Video Downloader Backend

Backend API for downloading videos from YouTube, Instagram, TikTok, Twitter, and Facebook.

## Features

- Download videos from multiple platforms
- Automatic audio merging
- Multiple quality options
- RESTful API

## Tech Stack

- Node.js + Express
- yt-dlp for video downloading
- FFmpeg for video processing

## API Endpoints

- `GET /api/health` - Health check
- `POST /api/media-info` - Get video information
- `POST /api/download` - Download video

## Deployment

This backend is deployed on Render.com

## Local Development

```bash
npm install
npm start
```

Server runs on http://localhost:3001
