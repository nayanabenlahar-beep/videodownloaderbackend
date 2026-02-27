const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const https = require('https');
const http = require('http');
const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;
const TEMP_DIR = os.tmpdir(); // Use OS temp directory (works on Windows, Mac, Linux)

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Media Downloader API',
        endpoints: ['/api/media-info', '/api/download']
    });
});

app.get('/api/health', async (req, res) => {
    try {
        // Try python first (Windows), then python3 (Linux/Mac)
        let ytDlpInstalled = false;
        let ffmpegInstalled = false;
        
        try {
            const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
            await execPromise(`${pythonCmd} -m yt_dlp --version`);
            ytDlpInstalled = true;
        } catch (error) {
            console.error('yt-dlp not found:', error.message);
        }

        try {
            // Try ffmpeg in PATH first, then try common Windows location
            try {
                await execPromise('ffmpeg -version');
                ffmpegInstalled = true;
            } catch {
                if (process.platform === 'win32') {
                    await execPromise('C:\\ffmpeg\\bin\\ffmpeg.exe -version');
                    ffmpegInstalled = true;
                }
            }
        } catch (error) {
            console.error('ffmpeg not found:', error.message);
        }

        res.json({ 
            status: 'ok', 
            ytDlpInstalled, 
            ffmpegInstalled,
            platform: process.platform 
        });
    } catch (error) {
        res.json({ status: 'error', message: error.message });
    }
});

// Get media info using Cobalt API
app.post('/api/media-info', async (req, res) => {
    const { url } = req.body;

    if (!url || !isValidUrl(url)) {
        return res.status(400).json({ error: 'Valid URL is required' });
    }

    try {
        const platform = detectPlatform(url);
        
        // Use Cobalt API for all platforms
        const cobaltResponse = await callCobaltAPI(url);
        
        if (cobaltResponse.status === 'error') {
            throw new Error(cobaltResponse.text || 'Failed to fetch media info');
        }

        // Cobalt returns direct download URLs
        res.json({
            success: true,
            data: {
                title: extractTitleFromUrl(url),
                thumbnail: cobaltResponse.thumb || null,
                duration: 'Unknown',
                uploader: 'Unknown',
                platform: platform,
                downloadUrl: cobaltResponse.url,
                formats: [{
                    formatId: 'best',
                    quality: 'Best Available',
                    resolution: 'Auto',
                    fps: 30,
                    size: 'Unknown',
                    format: 'mp4',
                    hasAudio: true
                }],
                audioFormatId: null,
                useCobalt: true // Flag to indicate we're using Cobalt
            }
        });
    } catch (error) {
        console.error('Error fetching media info:', error.message);
        console.error('Full error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch media info',
            details: error.message 
        });
    }
});

// Download media
app.post('/api/download', async (req, res) => {
    const { url, formatId, audioFormatId, title, downloadUrl, useCobalt } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL required' });
    }

    try {
        // If using Cobalt, redirect to their download URL
        if (useCobalt && downloadUrl) {
            console.log('Using Cobalt download URL:', downloadUrl);
            
            // Proxy the download through our server
            const filename = `${sanitizeFilename(title || 'video')}_${Date.now()}.mp4`;
            
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            
            // Stream from Cobalt to client
            const protocol = downloadUrl.startsWith('https') ? https : http;
            protocol.get(downloadUrl, (downloadStream) => {
                downloadStream.pipe(res);
            }).on('error', (err) => {
                console.error('Download stream error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Download failed: ' + err.message });
                }
            });
            
            return;
        }

        // Fallback to yt-dlp (for platforms that work)
        if (!formatId) {
            return res.status(400).json({ error: 'Format ID required' });
        }

        const filename = `${sanitizeFilename(title || 'video')}_${Date.now()}.mp4`;
        const outputPath = path.join(TEMP_DIR, filename);

        let format = formatId;
        if (audioFormatId) {
            format = `${formatId}+${audioFormatId}`;
        }

        console.log('Download request:', { url, format, outputPath });

        // Use 'python' on Windows, 'python3' on Linux/Mac
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        
        // Specify ffmpeg location for Windows
        let ffmpegLocation = '';
        if (process.platform === 'win32') {
            ffmpegLocation = '--ffmpeg-location "C:\\ffmpeg\\bin"';
        }
        
        // Detect platform and add appropriate bypass flags
        const platform = detectPlatform(url);
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        let extraArgs = '';
        
        if (platform === 'YouTube') {
            extraArgs = `--extractor-args "youtube:player_client=android_creator,ios,web;skip=dash,hls" --user-agent "${userAgent}" --add-header "Accept-Language:en-US,en;q=0.9" --geo-bypass --no-check-certificate`;
        } else if (platform === 'Instagram') {
            extraArgs = `--user-agent "${userAgent}" --add-header "Accept-Language:en-US,en;q=0.9" --add-header "Accept:text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" --geo-bypass --no-check-certificate`;
        } else {
            extraArgs = `--user-agent "${userAgent}" --geo-bypass --no-check-certificate`;
        }
        
        const command = `${pythonCmd} -m yt_dlp -f "${format}" ${ffmpegLocation} --merge-output-format mp4 ${extraArgs} -o "${outputPath}" "${url}"`;
        console.log('Executing command:', command);
        console.log('Platform:', process.platform);
        
        const { stdout, stderr } = await execPromise(command, {
            maxBuffer: 100 * 1024 * 1024,
            timeout: 300000
        });

        console.log('yt-dlp stdout:', stdout);
        if (stderr) console.log('yt-dlp stderr:', stderr);

        // Check if file exists
        try {
            const stat = await fs.stat(outputPath);
            console.log('File created successfully:', outputPath, 'Size:', stat.size);
        } catch (err) {
            console.error('File not found after download:', outputPath);
            throw new Error('Download completed but file not found');
        }

        // Stream file to client
        const stat = await fs.stat(outputPath);
        
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', stat.size);

        const fileStream = require('fs').createReadStream(outputPath);
        fileStream.pipe(res);

        // Cleanup after streaming
        fileStream.on('end', async () => {
            try {
                await fs.unlink(outputPath);
                console.log('Cleaned up file:', outputPath);
            } catch (err) {
                console.error('Cleanup error:', err);
            }
        });

    } catch (error) {
        console.error('Download error:', error.message);
        console.error('Full error:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Download failed: ' + error.message });
        }
    }
});

// Helper functions
function processFormats(formats) {
    if (!formats) return [];

    const videoFormats = formats
        .filter(f => f.vcodec !== 'none' && f.height)
        .map(f => ({
            formatId: f.format_id,
            quality: `${f.height}p`,
            resolution: `${f.width}x${f.height}`,
            fps: f.fps || 30,
            size: formatBytes(f.filesize || f.filesize_approx || 0),
            format: f.ext,
            hasAudio: f.acodec !== 'none'
        }));

    // Group by quality and pick the best one for each
    const qualityMap = new Map();
    
    for (const format of videoFormats) {
        const key = format.quality;
        if (!qualityMap.has(key) || format.hasAudio) {
            qualityMap.set(key, format);
        }
    }

    return Array.from(qualityMap.values())
        .sort((a, b) => parseInt(b.quality) - parseInt(a.quality))
        .slice(0, 5);  // Show top 5 qualities only
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return 'Unknown';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function formatDuration(seconds) {
    if (!seconds) return 'Unknown';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hrs > 0) {
        return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function sanitizeFilename(filename) {
    return filename
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_+/g, '_')
        .substring(0, 100);
}

function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

function detectPlatform(url) {
    if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
    if (url.includes('instagram.com')) return 'Instagram';
    if (url.includes('tiktok.com')) return 'TikTok';
    if (url.includes('twitter.com') || url.includes('x.com')) return 'Twitter';
    if (url.includes('facebook.com') || url.includes('fb.watch')) return 'Facebook';
    return 'Unknown';
}

// Cobalt API helper function
function callCobaltAPI(url) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            url: url,
            vCodec: 'h264',
            vQuality: '1080',
            aFormat: 'mp3',
            filenamePattern: 'basic',
            isAudioOnly: false
        });

        const options = {
            hostname: 'api.cobalt.tools',
            port: 443,
            path: '/api/json',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    resolve(response);
                } catch (error) {
                    reject(new Error('Failed to parse Cobalt API response'));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

// Extract title from URL (fallback when API doesn't provide it)
function extractTitleFromUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        return pathParts[pathParts.length - 1] || 'video';
    } catch {
        return 'video';
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
