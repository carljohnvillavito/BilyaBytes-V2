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

// Download Page (FIXED: Handles Backward Compatibility)
app.get('/share/:uuid', async (req, res) => {
    try {
        // Use .lean() to get a plain JS object, easier to modify
        const container = await Container.findOne({ uuid: req.params.uuid }).lean();
        
        if (!container) return res.render('download', { error: 'Link not found', container: null });
        if (new Date() > new Date(container.expiresAt)) return res.render('download', { error: 'Link Expired', container: null });
        
        // --- DATA PREPARATION (Fixes 500 Error) ---
        // We prepare the download links HERE instead of in the EJS template
        // This ensures old files (missing fields) still work.
        const d = new Date();
        const dateStr = String(d.getMonth() + 1).padStart(2, '0') + '-' + 
                        String(d.getDate()).padStart(2, '0') + '-' + 
                        d.getFullYear();

        container.files = container.files.map(file => {
            // Fallback for old data
            const ext = file.extension || path.extname(file.originalName);
            const cleanName = file.cleanName || path.basename(file.originalName, ext);
            
            // Generate Custom Filename: Name-MM-DD-YYYY.ext
            const newFilename = `${cleanName}-${dateStr}${ext}`;
            
            // Inject into Cloudinary URL
            // Handles cases where URL might already have options
            const dlUrl = file.url.replace('/upload/', `/upload/fl_attachment:${newFilename}/`);
            
            return {
                ...file,
                downloadUrl: dlUrl
            };
        });

        res.render('download', { container: container, error: null });
    } catch (err) {
        console.error("Download Error:", err);
        // Render a clean error page instead of generic 500
        res.render('download', { error: 'Server Error: ' + err.message, container: null });
    }
});

// Cron Job
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const expiredContainers = await Container.find({ expiresAt: { $lt: now } });
    for (const container of expiredContainers) {
        for (const file of container.files) {
            await cloudinary.uploader.destroy(file.publicId, { resource_type: "video" }).catch(()=>{});
            await cloudinary.uploader.destroy(file.publicId, { resource_type: "image" }).catch(()=>{});
            await cloudinary.uploader.destroy(file.publicId, { resource_type: "raw" }).catch(()=>{});
        }
        await Container.findByIdAndDelete(container._id);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
