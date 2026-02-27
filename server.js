const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
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

// Get media info
app.post('/api/media-info', async (req, res) => {
    const { url } = req.body;

    if (!url || !isValidUrl(url)) {
        return res.status(400).json({ error: 'Valid URL is required' });
    }

    try {
        // Use 'python' on Windows, 'python3' on Linux/Mac
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        
        // Different strategies for different platforms
        const platform = detectPlatform(url);
        let extraArgs = '';
        
        // Use aggressive bypass without cookies (works for most platforms)
        const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        
        if (platform === 'YouTube') {
            // For YouTube: use android client which works without cookies
            extraArgs = `--extractor-args "youtube:player_client=android" --user-agent "${userAgent}"`;
        } else if (platform === 'Instagram') {
            // For Instagram: basic approach
            extraArgs = `--user-agent "${userAgent}"`;
        } else {
            // Generic for other platforms
            extraArgs = `--user-agent "${userAgent}"`;
        }
        
        const command = `${pythonCmd} -m yt_dlp -J --no-warnings --skip-download --no-playlist ${extraArgs} "${url}"`;
        const { stdout } = await execPromise(command, { 
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30000
        });

        const info = JSON.parse(stdout);
        const videoFormats = processFormats(info.formats);
        const audioFormat = info.formats
            .filter(f => f.acodec !== 'none' && f.vcodec === 'none')
            .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

        res.json({
            success: true,
            data: {
                title: sanitizeFilename(info.title || 'video'),
                thumbnail: info.thumbnail || info.thumbnails?.[0]?.url,
                duration: formatDuration(info.duration),
                uploader: info.uploader || 'Unknown',
                platform: platform,
                formats: videoFormats,
                audioFormatId: audioFormat?.format_id
            }
        });
    } catch (error) {
        console.error('Error fetching media info:', error.message);
        console.error('Full error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch media info. The platform may be blocking server requests.',
            details: error.message 
        });
    }
});

// Download media
app.post('/api/download', async (req, res) => {
    const { url, formatId, audioFormatId, title } = req.body;

    if (!url || !formatId) {
        return res.status(400).json({ error: 'URL and format ID required' });
    }

    const filename = `${sanitizeFilename(title || 'video')}_${Date.now()}.mp4`;
    const outputPath = path.join(TEMP_DIR, filename);

    try {
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
            extraArgs = `--extractor-args "youtube:player_client=android" --user-agent "${userAgent}"`;
        } else if (platform === 'Instagram') {
            extraArgs = `--user-agent "${userAgent}"`;
        } else {
            extraArgs = `--user-agent "${userAgent}"`;
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
        res.status(500).json({ error: 'Download failed: ' + error.message });
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

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
