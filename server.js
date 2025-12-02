require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
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
    publicId: String, // Needed for deletion
    size: Number
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

// Middleware
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.json());

// Multer Config (Memory Storage)
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- ROUTES ---

// 1. Home Page
app.get('/', (req, res) => {
    res.render('index');
});

// 2. Upload Logic
app.post('/api/upload', upload.array('files'), async (req, res) => {
    try {
        const { containerName, expiryDuration } = req.body;
        const files = req.files;

        if (!files || files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

        // Calculate Expiry
        const expiryDate = new Date();
        expiryDate.setMinutes(expiryDate.getMinutes() + parseInt(expiryDuration));

        const uploadedFiles = [];

        // Upload loop
        for (const file of files) {
            const result = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    { resource_type: 'auto', folder: 'temp_share' },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                uploadStream.end(file.buffer);
            });

            uploadedFiles.push({
                originalName: file.originalname,
                url: result.secure_url,
                publicId: result.public_id,
                size: file.size
            });
        }

        // Save to DB
        const uniqueId = uuidv4();
        const newContainer = new Container({
            uuid: uniqueId,
            name: containerName || 'Untitled Folder',
            files: uploadedFiles,
            expiresAt: expiryDate
        });

        await newContainer.save();

        res.json({ 
            success: true, 
            shareLink: `${process.env.BASE_URL}/share/${uniqueId}` 
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// 3. Download Page
app.get('/share/:uuid', async (req, res) => {
    try {
        const container = await Container.findOne({ uuid: req.params.uuid });

        if (!container) {
            return res.render('download', { error: 'This link has expired or does not exist.' });
        }

        // check if expired just in case cron hasn't run yet
        if (new Date() > container.expiresAt) {
            return res.render('download', { error: 'This link has expired.' });
        }

        res.render('download', { container: container, error: null });
    } catch (err) {
        res.render('download', { error: 'Server Error' });
    }
});

// --- CRON JOB (Auto Deletion) ---
// Runs every minute to check for expired containers
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const expiredContainers = await Container.find({ expiresAt: { $lt: now } });

    for (const container of expiredContainers) {
        console.log(`Deleting expired container: ${container.name}`);
        
        // 1. Delete files from Cloudinary
        for (const file of container.files) {
            await cloudinary.uploader.destroy(file.publicId);
        }

        // 2. Delete from DB
        await Container.findByIdAndDelete(container._id);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
