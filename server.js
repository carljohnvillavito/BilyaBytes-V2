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

// --- FIX: Create 'uploads' folder automatically if missing ---
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
    console.log('Created uploads directory');
}

// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.log('DB Error:', err));

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

// Multer Disk Storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/') 
    },
    filename: function (req, file, cb) {
        // Sanitize filename to prevent issues
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
        cb(null, Date.now() + '-' + safeName)
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

            // Upload to Cloudinary
            const result = await cloudinary.uploader.upload(filePath, {
                resource_type: "auto",
                folder: "cloud_share_pro"
            });

            // Delete local temp file
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

            uploadedFiles.push({
                originalName: file.originalname,
                url: result.secure_url,
                publicId: result.public_id,
                size: file.size,
                format: result.format || 'file'
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
        console.error("UPLOAD ERROR:", err); // Looking at logs is easier now
        
        // Clean up temp files if error occurs
        if(req.files) {
            req.files.forEach(f => {
                if(fs.existsSync(f.path)) fs.unlinkSync(f.path);
            });
        }
        
        // Send the ACTUAL error message to the frontend for easier debugging
        res.status(500).json({ error: err.message || 'Server Error' });
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
