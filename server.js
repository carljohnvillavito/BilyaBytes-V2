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

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.log(err));

// Schema
const fileSchema = new mongoose.Schema({
    originalName: String,
    url: String,
    publicId: String,
    size: Number,
    format: String
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

// --- MULTER DISK STORAGE (For Large Files) ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/') // Files saved here temporarily
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
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

        // Calculate Expiry
        const expiryDate = new Date();
        expiryDate.setMinutes(expiryDate.getMinutes() + parseInt(expiryDuration));

        const uploadedFiles = [];

        // Loop through files
        for (const file of files) {
            const filePath = file.path;

            // Upload to Cloudinary (Stream from Disk)
            // resource_type: "auto" allows video/raw/image
            const result = await cloudinary.uploader.upload(filePath, {
                resource_type: "auto",
                folder: "cloud_share_pro"
            });

            // Delete local temp file to save space
            fs.unlinkSync(filePath);

            uploadedFiles.push({
                originalName: file.originalname,
                url: result.secure_url,
                publicId: result.public_id,
                size: file.size,
                format: result.format || 'file'
            });
        }

        // Save to DB
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
        console.error(err);
        // Clean up temp files if error occurs
        if(req.files) {
            req.files.forEach(f => {
                if(fs.existsSync(f.path)) fs.unlinkSync(f.path);
            });
        }
        res.status(500).json({ error: 'Upload failed or File too large for Cloudinary Free Tier' });
    }
});

// Download Page
app.get('/share/:uuid', async (req, res) => {
    try {
        const container = await Container.findOne({ uuid: req.params.uuid });

        if (!container) return res.render('download', { error: 'Link not found', container: null });
        if (new Date() > container.expiresAt) return res.render('download', { error: 'Link Expired', container: null });

        res.render('download', { container: container, error: null });
    } catch (err) {
        res.render('download', { error: 'Server Error', container: null });
    }
});

// Auto Delete Cron
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const expiredContainers = await Container.find({ expiresAt: { $lt: now } });

    for (const container of expiredContainers) {
        console.log(`Cleaning up: ${container.name}`);
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
