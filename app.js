const express = require('express');
const multer = require('multer');
const { exec } = require("child_process");
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
const crypto = require('crypto');

const path = require('path');
const fs = require('fs');

const app = express();

// Ensure required folders exist on startup
const requiredDirs = [
  path.join(__dirname, "shared_media"),
  path.join(__dirname, "shared_videos"),
  path.join(__dirname, "public_videos"),
  path.join(__dirname, "temp")
];

requiredDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created folder: ${dir}`);
  }
});


// Set up multer to store the uploaded file in memory
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const PORT = 3000;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const ongoingDownloads = new Map();
const envatoCookies = "__cf_bm=BWzWWF5kGGQ3X6Mw0tyz3uP.cl5irFbcsUq2iCiz11M-1744121368-1.0.1.1-.NYaWae5V370Cb3HLFgyavuxPooJKOSR4jvpjnmQeKyKJnQYHScQE29xCM6Sdeo9UkRQgp8QrzcPGXkwohgpb54uloBq7t_ms1GTQ27ZIgc";

// Serve an HTML form at the root to manually upload a video file
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Upload Video</title>
    </head>
    <body>
      <h1>Upload Video</h1>
      <form action="/upload" method="POST" enctype="multipart/form-data">
        <input type="file" name="video" accept="video/*" required />
        <button type="submit">Upload Video</button>
      </form>
    </body>
    </html>
  `);
});


const runCommand = (cmd) =>
    new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(`Error: ${error.message}`);
                return;
            }
            resolve(stdout || stderr);
        });
    });



app.post("/video-previewV2", async (req, res) => {
    try {
        const { urls, duration } = req.body;
        if (!urls || !Array.isArray(urls) || urls.length === 0 || !duration) {
            return res.status(400).json({ error: "urls (as an array) and duration are required." });
        }

        // Determine target resolution based on the first URL's query parameter "ratio"
        // Default to vertical (v) if not provided.
        const firstUrlObj = new URL(urls[0]);
        const ratioParam = firstUrlObj.searchParams.get("ratio")?.toLowerCase() || "v";
        // Set vertical (v) to 9:16 and horizontal (h) to 16:9.
        // Here we choose fixed resolutions: vertical = 720x1280 and horizontal = 1280x720.
        const targetResolution = ratioParam === "h" ? "1280x720" : "720x1280";
        const [targetWidth, targetHeight] = targetResolution.split("x");
        console.log(`Target resolution set to: ${targetWidth}x${targetHeight} (${ratioParam === "h" ? 'Horizontal' : 'Vertical'})`);

        // Shared directory for downloaded media (caching)
        const sharedDir = path.join(__dirname, "shared_media");
        if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });

        // Create a unique temporary directory for this request
        const uniqueId = crypto.randomBytes(8).toString('hex');
        const tempDir = path.join(__dirname, "temp", uniqueId);
        fs.mkdirSync(tempDir, { recursive: true });

        // Each clip's duration is the total duration divided by the number of URLs
        const clipDuration = duration / urls.length;
        let clipFiles = [];
        let clipIndex = 0;

        // Define file extension lists for images and video links
        const imageExtensions = [".jpg", ".jpeg", ".png", ".gif"];
        const videoExtensions = [".mp4", ".mov", ".webm", ".avi", ".mkv"];

        for (const url of urls) {
            let startTime = 0; // default start time for video (images always start at 0)
            let mediaPath = "";
            let isImage = false;
            let isYouTube = false;
            let isDirectVideo = false;

            try {
                const urlObj = new URL(url);
                // Determine if the URL is a YouTube link
                if (urlObj.hostname.includes("youtube.com") || urlObj.hostname.includes("youtu.be")) {
                    isYouTube = true;
                } else {
                    // Check by file extension if it's an image
                    const ext = path.extname(urlObj.pathname).toLowerCase();
                    if (imageExtensions.includes(ext)) {
                        isImage = true;
                    } else if (videoExtensions.includes(ext)) {
                        isDirectVideo = true;
                    } else {
                        // Default to direct video if not an image and not YouTube
                        isDirectVideo = true;
                    }
                }

                // For video links (YouTube or direct), check if a "t" parameter is provided
                if (!isImage && urlObj.searchParams.has("t")) {
                    const tParam = parseFloat(urlObj.searchParams.get("t"));
                    if (!isNaN(tParam)) {
                        startTime = tParam;
                    }
                }

                if (isYouTube) {
                    // Extract video id from the URL (works for both youtu.be and youtube.com)
                    let videoId;
                    if (urlObj.hostname.includes("youtu.be")) {
                        videoId = urlObj.pathname.slice(1);
                    } else {
                        videoId = urlObj.searchParams.get("v");
                        if (!videoId) {
                            videoId = urlObj.pathname.split("/").pop();
                        }
                    }
                    if (!videoId) {
                        console.log(`Skipping URL ${url} because video id could not be determined.`);
                        continue;
                    }

                    // Build a filename in the shared directory for caching the YouTube video
                    mediaPath = path.join(sharedDir, `video_${videoId}.mp4`);

                    // Download the video if not already cached
                    if (!fs.existsSync(mediaPath)) {
                        if (ongoingDownloads.has(videoId)) {
                            console.log(`Video ${videoId} is already downloading. Waiting for download to complete...`);
                            await ongoingDownloads.get(videoId);
                        } else {
                            console.log(`🚀 Downloading YouTube video for ${url}...`);
                            // Remove the "t" parameter so that the full video is downloaded.
                            urlObj.searchParams.delete("t");
                            const downloadUrl = urlObj.toString();
                            const downloadPromise = runCommand(`yt-dlp -f "bestvideo[ext=mp4]+bestaudio=none/bestvideo[ext=mp4]" -o "${mediaPath}" "${downloadUrl}"`);
                            ongoingDownloads.set(videoId, downloadPromise);
                            try {
                                await downloadPromise;
                                console.log("✅ YouTube video downloaded successfully.");
                            } catch (downloadError) {
                                ongoingDownloads.delete(videoId);
                                throw downloadError;
                            }
                            ongoingDownloads.delete(videoId);
                        }
                    } else {
                        console.log(`Using cached YouTube video for ${url}.`);
                    }
                }
                else if (isDirectVideo) {
                    // For direct video links, use a hashed filename for caching
                    const hash = crypto.createHash('md5').update(url).digest('hex');
                    const ext = path.extname(urlObj.pathname).toLowerCase() || ".mp4";
                    mediaPath = path.join(sharedDir, `video_${hash}${ext}`);

                    if (!fs.existsSync(mediaPath)) {
                        if (ongoingDownloads.has(hash)) {
                            console.log(`Direct video for ${url} is already downloading. Waiting for download to complete...`);
                            await ongoingDownloads.get(hash);
                        } else {
                            console.log(`🚀 Downloading direct video from ${url}...`);
                            let command;

                            if (url.includes('elements.envatousercontent.com')) {
                                console.log(`🔐 Using cookies for Envato download: ${url}`);
                                command = `curl -L "${url}" -H "Cookie: ${envatoCookies}" -o "${mediaPath} "`;
                            } else {
                                console.log(`🌐 Downloading public file: ${url}`);
                                command = `curl -L "${url}" -o "${mediaPath}"`;
                            }

                            const downloadPromise = runCommand(command);

                            ongoingDownloads.set(hash, downloadPromise);
                            try {
                                await downloadPromise;
                                console.log("✅ Direct video downloaded successfully.");
                            } catch (downloadError) {
                                ongoingDownloads.delete(hash);
                                throw downloadError;
                            }
                            ongoingDownloads.delete(hash);
                        }
                    } else {
                        console.log(`Using cached direct video for ${url}.`);
                    }
                } else if (isImage) {
                    // For image links: download and convert the image to a video clip.
                    const hash = crypto.createHash('md5').update(url).digest('hex');
                    const ext = path.extname(urlObj.pathname).toLowerCase() || ".jpg";
                    const imagePath = path.join(sharedDir, `image_${hash}${ext}`);

                    if (!fs.existsSync(imagePath)) {
                        if (ongoingDownloads.has(hash)) {
                            console.log(`Image for ${url} is already downloading. Waiting for download to complete...`);
                            await ongoingDownloads.get(hash);
                        } else {
                            console.log(`🚀 Downloading image from ${url}...`);
                            let command;
                            if (url.includes('elements.envatousercontent.com')) {
                                console.log(`🔐 Using cookies for Envato download: ${url}`);
                                command = `curl -L "${url}" -H "Cookie: ${envatoCookies}" -o "${imagePath}"`;
                            } else {
                                console.log(`🌐 Downloading public file: ${url}`);
                                command = `curl -L "${url}" -o "${imagePath}"`;
                            }
                            const downloadPromise = runCommand(command);
                            ongoingDownloads.set(hash, downloadPromise);
                            try {
                                await downloadPromise;
                                console.log("✅ Image downloaded successfully.");
                            } catch (downloadError) {
                                ongoingDownloads.delete(hash);
                                throw downloadError;
                            }
                            ongoingDownloads.delete(hash);
                        }
                    } else {
                        console.log(`Using cached image for ${url}.`);
                    }

                    mediaPath = path.join(tempDir, `image_video_${clipIndex + 1}.mp4`);
                    const fps = 25;
                    const totalFrames = clipDuration * fps;
                    console.log(`🎥 Creating video from image ${imagePath} with smooth zoom-out for ${clipDuration}s...`);

                    // Build a filter chain that:
                    // 1. Crops the image to the target aspect ratio (center crop).
                    // 2. Scales the image to the fixed target resolution.
                    const filterChain =
                        // Crop to target aspect ratio.
                        `crop=w='if(gt(iw/ih,${targetWidth}/${targetHeight}),ih*${targetWidth}/${targetHeight},iw)':` +
                        `h='if(gt(iw/ih,${targetWidth}/${targetHeight}),ih,iw*${targetHeight}/${targetWidth})':` +
                        `x='(iw - if(gt(iw/ih,${targetWidth}/${targetHeight}),ih*${targetWidth}/${targetHeight},iw))/2':` +
                        `y='(ih - if(gt(iw/ih,${targetWidth}/${targetHeight}),ih,iw*${targetHeight}/${targetWidth}))/2',` +
                        // Scale the cropped image to fixed dimensions.
                        `scale=${targetWidth}:${targetHeight}`;

                    await runCommand(
                        `ffmpeg -y -loop 1 -framerate ${fps} -i "${imagePath}" -vf "${filterChain}" -t ${clipDuration} -c:v libx264 -pix_fmt yuv420p "${mediaPath}"`
                    );

                    clipFiles.push(mediaPath);
                    clipIndex++;
                    continue;
                }

                // At this point, mediaPath should refer to a downloaded video file (YouTube or direct video).
                // Extract the clip from the video starting at the specified startTime with the calculated clipDuration.
                const clipFile = path.join(tempDir, `clip_${clipIndex + 1}.mp4`);
                console.log(`🎥 Extracting clip from ${mediaPath} starting at ${startTime}s (duration ${clipDuration}s)....`);
                await runCommand(`ffmpeg -y -ss ${startTime} -i "${mediaPath}" -t ${clipDuration} -c:v libx264 -crf 23 -preset fast "${clipFile}"`);
                clipFiles.push(clipFile);
                clipIndex++;

            } catch (err) {
                console.error(`Error processing URL ${url}:`, err);
                continue;
            }
        }

        // Merge or scale the clips based on the number of clips available
        let mergedVideoPath = path.join(tempDir, "merged_video.mp4");

        if (clipFiles.length === 1) {
            console.log("Only one clip available, scaling it to the target resolution...");
            await runCommand(
                `ffmpeg -y -i "${clipFiles[0]}" -vf "scale=${targetWidth}:${targetHeight}" -c:v libx264 -pix_fmt yuv420p "${mergedVideoPath}"`
            );
        } else {
            console.log("📽️ Merging video clips using the concat filter...");

            // Build the ffmpeg inputs for each clip file.
            const inputsCommand = clipFiles.map(file => `-i "${file}"`).join(" ");

            // Build the filter_complex string.
            // Each input is scaled and padded to the target resolution.
            let filterComplex = "";
            clipFiles.forEach((file, i) => {
                filterComplex += `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
                    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
            });
            // Concatenate all scaled clips.
            const concatInputs = clipFiles.map((_, i) => `[v${i}]`).join("");
            filterComplex += `${concatInputs}concat=n=${clipFiles.length}:v=1:a=0[out]`;

            // Construct and execute the merge command.
            const mergeCommand = `ffmpeg -y ${inputsCommand} -filter_complex "${filterComplex}" -map "[out]" ` +
                `-c:v libx264 -pix_fmt yuv420p "${mergedVideoPath}"`;
            console.log("Merge command:", mergeCommand);
            await runCommand(mergeCommand);
        }


        // Remove audio from the merged video (optional step)
        const finalVideoPath = path.join(tempDir, "final_video_no_audio.mp4");
        console.log("🔇 Removing audio from the final video...");
        await runCommand(`ffmpeg -y -i "${mergedVideoPath}" -an -c copy "${finalVideoPath}"`);
        console.log("✅ Audio removed successfully!");

        // Copy the final video to a public directory so it persists
        const publicDir = path.join(__dirname, "public_videos");
        if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
        const finalPublicVideoPath = path.join(publicDir, `final_video_${uniqueId}.mp4`);
        fs.copyFileSync(finalVideoPath, finalPublicVideoPath);
        console.log("✅ Final video copied to public directory.");

        // Construct the file URL; ensure that you have added a static route for /videos
        console.log("req.protocol", req.protocol);
        const fileUrl = `${req.protocol}://${req.get("host")}/videos/${path.basename(finalPublicVideoPath)}`;

        res.json({ videoUrl: fileUrl });
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});




// API to generate a video preview
// Endpoint for video preview generation
app.post("/video-preview", async (req, res) => {

    try {
        console.log(req.body);
        const { youtubeUrls, duration } = req.body;
        if (!youtubeUrls || !Array.isArray(youtubeUrls) || youtubeUrls.length === 0 || !duration) {
            return res.status(400).json({ error: "youtubeUrls (as an array) and duration are required." });
        }

        // Shared directory for downloaded videos (caching)
        const sharedDir = path.join(__dirname, "shared_videos");
        if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });

        // Create a unique temporary directory for this request
        const uniqueId = crypto.randomBytes(8).toString('hex');
        const tempDir = path.join(__dirname, "temp", uniqueId);
        fs.mkdirSync(tempDir, { recursive: true });

        // Filter valid URLs that have a "t" query parameter
        const validUrls = youtubeUrls.filter(url => {
            try {
                const urlObj = new URL(url);
                return urlObj.searchParams.has("t");
            } catch (err) {
                console.error(`Invalid URL skipped: ${url}`);
                return false;
            }
        });

        if (validUrls.length === 0) {
            return res.status(400).json({ error: "No valid YouTube URLs with a 't' query parameter provided." });
        }

        // Each clip's duration is the total duration divided by the number of valid URLs
        const clipDuration = duration / validUrls.length;
        let clipFiles = [];
        let clipIndex = 0;

        for (const url of validUrls) {
            const urlObj = new URL(url);
            const startTime = parseFloat(urlObj.searchParams.get("t"));
            if (isNaN(startTime)) {
                console.log(`Skipping URL ${url} due to invalid 't' parameter.`);
                continue;
            }

            // Determine video id from URL (works for both youtu.be and youtube.com)
            let videoId;
            if (urlObj.hostname.includes("youtu.be")) {
                videoId = urlObj.pathname.slice(1);
            } else if (urlObj.hostname.includes("youtube.com")) {
                videoId = urlObj.searchParams.get("v");
                if (!videoId) {
                    videoId = urlObj.pathname.slice(1).split("/").pop();
                }
            }
            if (!videoId) {
                console.log(`Skipping URL ${url} because video id could not be determined.`);
                continue;
            }

            // Build a filename in the shared directory based on video id
            const videoPath = path.join(sharedDir, `video_${videoId}.mp4`);

            // Download the video only if it isn't already cached
            if (!fs.existsSync(videoPath)) {
                if (ongoingDownloads.has(videoId)) {
                    console.log(`Video ${videoId} is already downloading. Waiting for download to complete...`);
                    await ongoingDownloads.get(videoId);
                } else {
                    console.log(`🚀 Downloading video for ${url}...`);
                    // Remove the "t" parameter so that the full video is downloaded.
                    urlObj.searchParams.delete("t");
                    const downloadUrl = urlObj.toString();
                    // Start the download and store its promise
                    const downloadPromise = runCommand(`yt-dlp -f "bestvideo[ext=mp4]+bestaudio=none/bestvideo[ext=mp4]" -o "${videoPath}" "${downloadUrl}"`);
                    ongoingDownloads.set(videoId, downloadPromise);
                    try {
                        await downloadPromise;
                        console.log("✅ Video downloaded successfully.");
                    } catch (downloadError) {
                        ongoingDownloads.delete(videoId);
                        throw downloadError;
                    }
                    ongoingDownloads.delete(videoId);
                }
            } else {
                console.log(`Using cached video for ${url}.`);
            }

            // Extract a clip from the downloaded video at the specified start time
            const clipFile = path.join(tempDir, `clip_${clipIndex + 1}.mp4`);
            console.log(`🎥 Extracting clip from ${videoPath} starting at ${startTime}s (duration ${clipDuration}s)...`);
            // Using -c copy since we don't want to modify the original resolution
            await runCommand(`ffmpeg -ss ${startTime} -i "${videoPath}" -t ${clipDuration} -c copy "${clipFile}"`);
            clipFiles.push(clipFile);
            clipIndex++;
        }

        if (clipFiles.length === 0) {
            return res.status(400).json({ error: "No clips could be extracted. Check the input URLs and their 't' parameters." });
        }

        // Merge the clips using an ffmpeg concat file
        console.log("📽️ Merging video clips...");
        const concatFilePath = path.join(tempDir, "concat_list.txt");
        fs.writeFileSync(concatFilePath, clipFiles.map(file => `file '${file}'`).join("\n"));
        const mergedVideoPath = path.join(tempDir, "merged_video.mp4");
        await runCommand(`ffmpeg -f concat -safe 0 -i "${concatFilePath}" -c copy "${mergedVideoPath}"`);
        console.log("✅ Video merging complete.");

        // Remove audio from the merged video (optional step)
        const finalVideoPath = path.join(tempDir, "final_video_no_audio.mp4");
        console.log("🔇 Removing audio from the final video...");
        await runCommand(`ffmpeg -i "${mergedVideoPath}" -an -c copy "${finalVideoPath}"`);
        console.log("✅ Audio removed successfully!");

        // Copy final video to a public directory so it persists
        const publicDir = path.join(__dirname, "public_videos");
        if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
        const finalPublicVideoPath = path.join(publicDir, `final_video_${uniqueId}.mp4`);
        fs.copyFileSync(finalVideoPath, finalPublicVideoPath);

        // Log the final video path
        //console.log(`${new Date().toLocaleString()} ✅ Final video copied to public directory.`);
        console.log("✅ Final video copied to public directory.");

        // Remove temporary files (the final public file remains intact)
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log("🗑️ Temporary files removed.");

        // Construct the file URL; ensure that you have added a static route for /videos
        console.log("req.protocol", req.protocol);
        const fileUrl = `${req.protocol}://${req.get("host")}/videos/${path.basename(finalPublicVideoPath)}`;

        // Return the file URL in a JSON response
        res.json({ videoUrl: fileUrl });
    } catch (error) {
        console.error("❌ Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.use("/videos", express.static(path.join(__dirname, "public_videos")));

// Handle the file upload and conversion at /upload
app.post('/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // Define temporary file paths for the uploaded video and the output MP3 file
    const tempVideoPath = path.join(__dirname, 'temp_video.mp4');
    const outputAudioPath = path.join(__dirname, 'output_audio.mp3');

    // Write the uploaded video (from memory) to a temporary file
    fs.writeFileSync(tempVideoPath, req.file.buffer);
    console.log('Video file saved to:', tempVideoPath);

    // Use FFmpeg to extract audio and convert it to MP3 format
    ffmpeg(tempVideoPath)
        .output(outputAudioPath)
        .audioCodec('libmp3lame')
        .audioBitrate(192)
        .on('end', () => {
            console.log('Audio extraction complete.');
            // Send the converted MP3 file as the response
            res.sendFile(outputAudioPath, (err) => {
                if (err) {
                    console.error('Error sending file:', err);
                    res.status(500).send('Error sending file');
                } else {
                    // Clean up temporary files after sending
                    fs.unlinkSync(tempVideoPath);
                    fs.unlinkSync(outputAudioPath);
                    console.log('Temporary files removed.');
                }
            });
        })
        .on('error', (err) => {
            console.error('Error during FFmpeg process:', err);
            res.status(500).send('Error during audio extraction');
        })
        .run();
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
