require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.log('DB Error:', err));

// Schema
const fileSchema = new mongoose.Schema({
    originalName: String, 
    cleanName: String,    
    extension: String,    
    url: String,
    publicId: String,
    size: Number,
    format: String,
    resourceType: String 
});

const containerSchema = new mongoose.Schema({
    uuid: String,
    name: String,
    files: [fileSchema],
    createdAt: { type: Date, default: Date.now },
    expiresAt: Date
});

const Container = mongoose.model('Container', containerSchema);

// Cloudinary Config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_SECRET
});

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());

// Multer Storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/') 
    },
    filename: function (req, file, cb) {
        // Safe temp filename
        cb(null, Date.now() + '_' + file.originalname.replace(/ /g, '_'));
    }
});
const upload = multer({ storage: storage });

// --- ROUTES ---

app.get('/', (req, res) => {
    res.render('index');
});

// Upload Logic
app.post('/api/upload', upload.array('files'), async (req, res) => {
    try {
        const { containerName, expiryDuration } = req.body;
        const files = req.files;

        if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

        const expiryDate = new Date();
        expiryDate.setMinutes(expiryDate.getMinutes() + parseInt(expiryDuration));

        const uploadedFiles = [];

        for (const file of files) {
            const filePath = file.path;
            const originalName = file.originalname;
            const ext = path.extname(originalName);
            const cleanName = path.basename(originalName, ext);

            // Handle Resource Types
            let resType = 'auto';
            const lowerExt = ext.toLowerCase();
            if (['.apk', '.exe', '.msi', '.dmg', '.iso', '.bin', '.rar', '.zip', '.7z'].includes(lowerExt)) {
                resType = 'raw';
            }

            // Upload Large (>10MB support)
            const result = await cloudinary.uploader.upload_large(filePath, {
                resource_type: resType,
                folder: "cloud_share_pro",
                chunk_size: 6000000, 
                use_filename: true,
                unique_filename: true
            });

            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

            uploadedFiles.push({
                originalName: originalName,
                cleanName: cleanName,
                extension: ext,
                url: result.secure_url,
                publicId: result.public_id,
                size: file.size,
                format: result.format || ext.replace('.', ''),
                resourceType: result.resource_type
            });
        }

        const uniqueId = uuidv4();
        const newContainer = new Container({
            uuid: uniqueId,
            name: containerName || 'Untitled Transfer',
            files: uploadedFiles,
            expiresAt: expiryDate
        });

        await newContainer.save();

        res.json({ 
            success: true, 
            shareLink: `${process.env.BASE_URL}/share/${uniqueId}`,
            containerName: newContainer.name,
            expiry: newContainer.expiresAt
        });

    } catch (err) {
        console.error("UPLOAD ERROR:", err);
        if(req.files) {
            req.files.forEach(f => {
                if(fs.existsSync(f.path)) fs.unlinkSync(f.path);
            });
        }
        res.status(500).json({ error: err.message || 'Server Error' });
    }
});

 // --- DOWNLOAD PAGE (Robust Fix) ---
app.get('/share/:uuid', async (req, res) => {
    try {
        const container = await Container.findOne({ uuid: req.params.uuid }).lean();
        
        if (!container) return res.render('download', { error: 'Link not found', container: null });
        if (new Date() > new Date(container.expiresAt)) return res.render('download', { error: 'Link Expired', container: null });
        
        // Date String for filenames
        const d = new Date();
        const dateStr = String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                        String(d.getDate()).padStart(2, '0') + '-' + 
                        d.getFullYear();

        container.files = container.files.map(file => {
            // 1. Safe Defaults
            const originalName = file.originalName || 'file';
            const ext = file.extension || path.extname(originalName) || '';
            const cleanName = file.cleanName || path.basename(originalName, ext) || 'file';
            
            // 2. Default to original URL (So button ALWAYS works)
            let dlUrl = file.url; 

            // 3. Try to inject "Force Download" params
            if (file.url && file.url.includes('/upload/')) {
                const newFilename = `${cleanName}-${dateStr}${ext}`;
                // Inject fl_attachment to force download with new name
                dlUrl = file.url.replace('/upload/', `/upload/fl_attachment:${newFilename}/`);
            }

            return {
                ...file,
                originalName: originalName,
                downloadUrl: dlUrl
            };
        });

        res.render('download', { container: container, error: null });
    } catch (err) {
        console.error("Download Page Error:", err);
        res.render('download', { error: 'Server Error: ' + err.message, container: null });
    }
});

// Cron Job
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const expiredContainers = await Container.find({ expiresAt: { $lt: now } });
    for (const container of expiredContainers) {
        for (const file of container.files) {
            if(file.publicId) {
                await cloudinary.uploader.destroy(file.publicId, { resource_type: "video" }).catch(()=>{});
                await cloudinary.uploader.destroy(file.publicId, { resource_type: "image" }).catch(()=>{});
                await cloudinary.uploader.destroy(file.publicId, { resource_type: "raw" }).catch(()=>{});
            }
        }
        await Container.findByIdAndDelete(container._id);
    }
});

// ... (keep all your existing code above) ...

// --- NEW: Dedicated Download Action Route ---
app.get('/action/download/:fileId', async (req, res) => {
    try {
        // 1. Find the container that has this specific file ID
        const container = await Container.findOne({ "files._id": req.params.fileId });
        
        if (!container) {
            return res.status(404).send("File not found or expired.");
        }

        // 2. Extract the specific file object
        const file = container.files.id(req.params.fileId);
        
        // 3. Generate the Date String for the filename
        const d = new Date();
        const dateStr = String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                        String(d.getDate()).padStart(2, '0') + '-' + 
                        d.getFullYear();

        // 4. Construct the clean filename
        // Fallback to 'file' if names are missing
        const cleanName = file.cleanName || 'download'; 
        const ext = file.extension || '';
        const finalFilename = `${cleanName}-${dateStr}${ext}`;

        // 5. Generate the Cloudinary "Force Download" URL
        // We inject '/fl_attachment:FILENAME/' into the URL.
        // This tells Cloudinary: "When this link is hit, force the browser to save it."
        let downloadUrl = file.url;
        
        if (file.url.includes('/upload/')) {
            downloadUrl = file.url.replace(
                '/upload/', 
                `/upload/fl_attachment:${finalFilename}/`
            );
        }

        // 6. Redirect the user. 
        // The browser receives the new URL and immediately starts the download.
        res.redirect(downloadUrl);

    } catch (err) {
        console.error("Download Action Error:", err);
        res.status(500).send("Server Error during download.");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
