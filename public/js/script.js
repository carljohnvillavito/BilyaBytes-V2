// DOM Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileStack = document.getElementById('file-stack');
const uploadBtn = document.getElementById('upload-btn');
const historyList = document.getElementById('history-list');

// State
let selectedFiles = [];

// Helper: Format File Size (Fixes the 0.00 MB bug)
function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

// 1. Initialize History on Load
document.addEventListener('DOMContentLoaded', renderHistory);

// 2. Drag & Drop Events
dropZone.addEventListener('click', () => fileInput.click());

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

dropZone.addEventListener('dragover', () => dropZone.classList.add('dragover'));
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', (e) => {
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

// 3. Handle File Selection
function handleFiles(files) {
    const newFiles = Array.from(files);
    selectedFiles = [...selectedFiles, ...newFiles];
    renderFileList();
}

function renderFileList() {
    fileStack.innerHTML = '';
    selectedFiles.forEach((file, index) => {
        const div = document.createElement('div');
        div.className = 'file-row';
        
        // --- UPDATED HERE: Uses formatBytes() instead of hardcoded math ---
        div.innerHTML = `
            <div class="file-header">
                <span>${file.name}</span>
                <span style="cursor:pointer; color:#ef4444;" onclick="removeFile(${index})">✖</span>
            </div>
            <div class="text-muted text-sm">${formatBytes(file.size)}</div> 
        `;
        fileStack.appendChild(div);
    });
}

window.removeFile = (index) => {
    selectedFiles.splice(index, 1);
    renderFileList();
};

// 4. Upload Logic with Progress
uploadBtn.addEventListener('click', () => {
    if (selectedFiles.length === 0) return alert('Please select files first.');

    const containerName = document.getElementById('container-name').value;
    const expiry = document.getElementById('expiry-duration').value;

    const progressModal = document.getElementById('progress-modal');
    const progressBar = document.getElementById('main-progress-bar');
    const progressText = document.getElementById('progress-text');
    progressModal.classList.remove('hidden');

    const formData = new FormData();
    selectedFiles.forEach(file => formData.append('files', file));
    formData.append('containerName', containerName);
    formData.append('expiryDuration', expiry);

    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = percent + '%';
            progressText.innerText = `Uploading: ${percent}%`;
            if(percent === 100) progressText.innerText = 'Processing on Cloud...';
        }
    });

    xhr.open('POST', '/api/upload');

    xhr.onload = function() {
        progressModal.classList.add('hidden');
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            if (data.success) {
                showSuccess(data);
                saveToHistory(data);
            } else {
                alert('Upload failed: ' + (data.error || 'Unknown error'));
            }
        } else {
            // Parse error message from server if available
            try {
                const err = JSON.parse(xhr.responseText);
                alert('Server Error: ' + err.error);
            } catch(e) {
                alert('Server Error. File might be too large.');
            }
        }
    };

    xhr.onerror = function() {
        progressModal.classList.add('hidden');
        alert('Network Error');
    };

    xhr.send(formData);
});

function showSuccess(data) {
    const successModal = document.getElementById('success-modal');
    const linkInput = document.getElementById('final-link');
    const openBtn = document.getElementById('open-btn');
    
    successModal.classList.remove('hidden');
    linkInput.value = data.shareLink;
    openBtn.href = data.shareLink;

    document.getElementById('copy-btn').onclick = () => {
        linkInput.select();
        document.execCommand('copy');
        document.getElementById('copy-btn').innerText = 'Copied!';
    };
}

function saveToHistory(data) {
    const historyItem = {
        name: data.containerName,
        link: data.shareLink,
        expiry: data.expiry,
        date: new Date().toISOString()
    };

    let history = JSON.parse(localStorage.getItem('uploadHistory') || '[]');
    history.unshift(historyItem);
    if (history.length > 10) history = history.slice(0, 10);
    
    localStorage.setItem('uploadHistory', JSON.stringify(history));
    renderHistory();
}

function renderHistory() {
    const history = JSON.parse(localStorage.getItem('uploadHistory') || '[]');
    historyList.innerHTML = '';

    if (history.length === 0) {
        historyList.innerHTML = '<li class="text-muted text-center text-sm">No recent uploads.</li>';
        return;
    }

    history.forEach(item => {
        const li = document.createElement('li');
        li.className = 'history-item';
        
        const isExpired = new Date() > new Date(item.expiry);
        const status = isExpired ? '<span style="color:red">(Expired)</span>' : '<span style="color:var(--success)">(Active)</span>';

        li.innerHTML = `
            <div><strong>${item.name || 'Untitled'}</strong> ${status}</div>
            <div class="history-meta">
                <span>${new Date(item.date).toLocaleDateString()}</span>
                <a href="${item.link}" target="_blank" class="history-link">Open Link</a>
            </div>
        `;
        historyList.appendChild(li);
    });
}

window.clearHistory = function() {
    localStorage.removeItem('uploadHistory');
    renderHistory();
}
