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

            let resType = 'auto';
            const lowerExt = ext.toLowerCase();
            if (['.apk', '.exe', '.msi', '.dmg', '.iso', '.bin', '.rar', '.zip', '.7z'].includes(lowerExt)) {
                resType = 'raw';
            }

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

// Download Page (View Only)
app.get('/share/:uuid', async (req, res) => {
    try {
        const container = await Container.findOne({ uuid: req.params.uuid }).lean();
        
        if (!container) return res.render('download', { error: 'Link not found', container: null });
        if (new Date() > new Date(container.expiresAt)) return res.render('download', { error: 'Link Expired', container: null });
        
        res.render('download', { container: container, error: null });
    } catch (err) {
        console.error("Download Page Error:", err);
        res.render('download', { error: 'Server Error: ' + err.message, container: null });
    }
});

// --- NEW: Dedicated Download Action Route (FIXED) ---
app.get('/action/download/:fileId', async (req, res) => {
    try {
        const container = await Container.findOne({ "files._id": req.params.fileId });
        
        if (!container) {
            return res.status(404).send("File not found or expired.");
        }

        const file = container.files.id(req.params.fileId);
        
        // --- FIX: Safety Check for Corrupt Data ---
        // Checks if 'file' exists AND if 'file.url' exists
        if (!file || !file.url) {
            console.error(`Error: File ID ${req.params.fileId} is missing a URL.`);
            return res.status(500).send("Error: This file is corrupted (missing download URL). Please upload it again.");
        }

        const d = new Date();
        const dateStr = String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                        String(d.getDate()).padStart(2, '0') + '-' + 
                        d.getFullYear();

        const cleanName = file.cleanName || 'download'; 
        const ext = file.extension || '';
        const finalFilename = `${cleanName}-${dateStr}${ext}`;

        let downloadUrl = file.url;
        
        // Safe check using ?. just in case
        if (file.url?.includes('/upload/')) {
            downloadUrl = file.url.replace(
                '/upload/', 
                `/upload/fl_attachment:${finalFilename}/`
            );
        }

        res.redirect(downloadUrl);

    } catch (err) {
        console.error("Download Action Error:", err);
        res.status(500).send("Server Error during download.");
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
