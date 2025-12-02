const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileList = document.getElementById('file-list');
const uploadBtn = document.getElementById('upload-btn');
const copyBtn = document.getElementById('copy-btn');
let filesToUpload = [];

// Handle Drag & Drop
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

function handleFiles(files) {
    Array.from(files).forEach(file => {
        filesToUpload.push(file);
        const div = document.createElement('div');
        div.className = 'file-item';
        div.innerHTML = `<span>${file.name}</span> <span style="cursor:pointer; color:red" onclick="removeFile(this, '${file.name}')">&times;</span>`;
        fileList.appendChild(div);
    });
}

window.removeFile = function(el, name) {
    filesToUpload = filesToUpload.filter(f => f.name !== name);
    el.parentElement.remove();
}

// Upload Logic
uploadBtn.addEventListener('click', async () => {
    if (filesToUpload.length === 0) return alert('Please select files first.');

    const containerName = document.getElementById('container-name').value;
    const expiry = document.getElementById('expiry-duration').value;

    const formData = new FormData();
    filesToUpload.forEach(file => formData.append('files', file));
    formData.append('containerName', containerName);
    formData.append('expiryDuration', expiry);

    // UI Feedback
    document.getElementById('loading-overlay').classList.remove('hidden');

    try {
        const res = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        document.getElementById('loading-overlay').classList.add('hidden');

        if (data.success) {
            document.getElementById('result-overlay').classList.remove('hidden');
            document.getElementById('share-link').value = data.shareLink;
        } else {
            alert('Upload failed');
        }
    } catch (e) {
        console.error(e);
        document.getElementById('loading-overlay').classList.add('hidden');
        alert('Error uploading files.');
    }
});

copyBtn.addEventListener('click', () => {
    const linkInput = document.getElementById('share-link');
    linkInput.select();
    document.execCommand('copy');
    copyBtn.innerText = 'Copied!';
    setTimeout(() => copyBtn.innerText = 'Copy Link', 2000);
});
