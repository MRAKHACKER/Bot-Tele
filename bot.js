import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import chalk from 'chalk';
import os from 'os';
import winston from 'winston';
import { fileURLToPath } from 'url';
import moment from 'moment';
import config from './config.js';
import * as cheerio from 'cheerio';
import FormData from 'form-data';

// ======================== INISIALISASI ========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Konfigurasi logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: path.join(__dirname, 'logs', 'combined.log') }),
        new winston.transports.File({ filename: path.join(__dirname, 'logs', 'error.log'), level: 'error' })
    ]
});

const conversationHistory = {};
const MEMORY_FILE = path.join(__dirname, 'otak.json');
const USER_CACHE_FILE = path.join(__dirname, 'user_cache.json');
let userCache = new Set();

// Konfigurasi dari file
const { token: TELEGRAM_TOKEN, adminId: ADMIN_ID } = config.telegram;

const VREDEN_AI_API_URL = "https://api.vreden.my.id/api/mora";
const BOT_CONFIG = config.bot;

// Inisialisasi bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ======================== MANAJEMEN STATUS UPLOAD ========================
const UPLOAD_STATUS_FILE = path.join(__dirname, 'upload_status.json');
let uploadEnabled = true; // Default upload aktif

function loadUploadStatus() {
    if (fs.existsSync(UPLOAD_STATUS_FILE)) {
        try {
            const data = fs.readFileSync(UPLOAD_STATUS_FILE, 'utf8');
            uploadEnabled = JSON.parse(data).uploadEnabled;
            logger.info(`Status Upload berhasil dimuat: ${uploadEnabled ? 'Aktif' : 'Nonaktif'}`);
        } catch (error) {
            logger.error(`Error memuat status upload: ${error.message}`);
        }
    }
}

function saveUploadStatus() {
    try {
        fs.writeFileSync(UPLOAD_STATUS_FILE, JSON.stringify({ uploadEnabled }, null, 2), 'utf8');
        logger.info(`Status Upload berhasil disimpan: ${uploadEnabled ? 'Aktif' : 'Nonaktif'}`);
    } catch (error) {
        logger.error(`Error menyimpan status upload: ${error.message}`);
    }
}

// ======================== FUNGSI CATBOX UPLOAD ========================
async function uploadToCatbox(fileBuffer, fileName, userhash = null) {
    try {
        const formData = new FormData();
        formData.append('reqtype', 'fileupload');
        if (userhash) {
            formData.append('userhash', userhash);
        }
        formData.append('fileToUpload', fileBuffer, fileName);

        const response = await axios.post('https://catbox.moe/user/api.php', formData, {
            headers: {
                ...formData.getHeaders(),
            },
            timeout: 30000
        });

        if (response.data && response.data.startsWith('https://files.catbox.moe/')) {
            return {
                success: true,
                url: response.data.trim()
            };
        } else {
            return {
                success: false,
                error: response.data || 'Upload gagal'
            };
        }
    } catch (error) {
        logger.error(`Catbox upload error: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
}

async function downloadFileFromTelegram(fileId) {
    try {
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        
        const response = await axios.get(fileUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
        });

        return {
            success: true,
            buffer: Buffer.from(response.data),
            fileName: path.basename(file.file_path)
        };
    } catch (error) {
        logger.error(`Download file error: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
}

// ======================== MANAJEMEN MEMORI ========================
function loadConversationHistory() {
    if (fs.existsSync(MEMORY_FILE)) {
        try {
            const data = fs.readFileSync(MEMORY_FILE, 'utf8');
            const parsedData = JSON.parse(data);
            
            for (const chatId in parsedData) {
                conversationHistory[chatId] = parsedData[chatId]
                    .filter(msg => msg.role && msg.content)
                    .map(msg => ({
                        ...msg,
                        timestamp: msg.timestamp || Date.now()
                    }));
            }
            logger.info('Memori percakapan berhasil dimuat');
        } catch (error) {
            logger.error(`Error memuat memori: ${error.message}`);
            // Backup file corrupt
            fs.renameSync(MEMORY_FILE, `${MEMORY_FILE}.corrupted-${Date.now()}`);
        }
    }
}

function saveConversationHistory() {
    try {
        const validData = {};
        for (const chatId in conversationHistory) {
            validData[chatId] = conversationHistory[chatId].filter(
                msg => msg.role && msg.content
            );
        }
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(validData, null, 2), 'utf8');
    } catch (error) {
        logger.error(`Error menyimpan memori: ${error.message}`);
    }
}

function loadUserCache() {
    if (fs.existsSync(USER_CACHE_FILE)) {
        try {
            const data = fs.readFileSync(USER_CACHE_FILE, 'utf8');
            userCache = new Set(JSON.parse(data));
            logger.info('Cache pengguna berhasil dimuat');
        } catch (error) {
            logger.error(`Error memuat cache pengguna: ${error.message}`);
        }
    }
}

function saveUserCache() {
    try {
        fs.writeFileSync(USER_CACHE_FILE, JSON.stringify([...userCache]), 'utf8');
    } catch (error) {
        logger.error(`Error menyimpan cache pengguna: ${error.message}`);
    }
}

function getRelevantConversationContext(chatId, maxTokens = 900) {
    if (!conversationHistory[chatId]?.length) return [];
    
    let currentTokens = 0;
    const relevantMessages = [];
    
    // Iterasi dari pesan terbaru
    for (let i = conversationHistory[chatId].length - 1; i >= 0; i--) {
        const msg = conversationHistory[chatId][i];
        const messageTokens = msg.content.length + 10; // Estimasi token
        
        if (currentTokens + messageTokens <= maxTokens) {
            relevantMessages.unshift(msg);
            currentTokens += messageTokens;
        } else {
            break;
        }
    }
    
    return relevantMessages;
}

// ======================== FUNGSI AI ========================
async function getAIResponse(chatId, message, username = 'Pengguna') {
    if (!aiEnabled) {
        return BOT_CONFIG.errorMessages.aiDisabled;
    }

    // Inisialisasi memori jika belum ada
    if (!conversationHistory[chatId]) {
        conversationHistory[chatId] = [];     
        // Tambahkan system message jika ada
        if (BOT_CONFIG.defaultPersonality) {
            const personality = BOT_CONFIG.personalities[BOT_CONFIG.defaultPersonality];
            if (personality) {
                conversationHistory[chatId].push({
                    role: 'system',
                    content: personality.systemMessage,
                    timestamp: Date.now()
                });
            }
        }
    }

    // Tambahkan pesan user
    conversationHistory[chatId].push({ 
        role: 'user', 
        content: message, 
        timestamp: Date.now() 
    }); 

    try {
        const response = await axios.get(
            `${VREDEN_AI_API_URL}?query=${encodeURIComponent(message)}&username=${chatId}`,
            { timeout: 30000 }
        );     
        
        const aiResponse = response.data.result;

        // Tambahkan respon AI
        conversationHistory[chatId].push({ 
            role: 'assistant', 
            content: aiResponse, 
            timestamp: Date.now() 
        });      

        // Simpan memori secara async
        setImmediate(saveConversationHistory);   

        return aiResponse;
    } catch (error) {
        logger.error(`Error AI: ${error.response?.data || error.message}`);
        // Hapus pesan user yang gagal diproses
        conversationHistory[chatId].pop();    
        return BOT_CONFIG.errorMessages.apiFailure;
    }
}

// ======================== FUNGSI PENDUKUNG ========================
// [FITUR BARU] Fungsi untuk membuat akun panel
async function createPanelAccount(packageInfo, userId, userName) {
    try {
        // Generate username dan password
        const timestamp = Date.now().toString().slice(-6);
        const username = `user_${userId}_${timestamp}`;
        const password = generateRandomPassword(12);
        
        // Simulasi API call ke panel (ganti dengan API panel yang sebenarnya)
        const panelApiResponse = await callPanelAPI({
            action: 'create_user',
            username: username,
            password: password,
            quota: packageInfo.quota,
            duration: packageInfo.duration,
            package_type: packageInfo.size
        });
        
        if (panelApiResponse.success) {
            // Simpan data akun ke database/file (opsional)
            await savePanelAccountData({
                username: username,
                password: password,
                userId: userId,
                userName: userName,
                package: packageInfo.size,
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + (packageInfo.duration * 24 * 60 * 60 * 1000)).toISOString()
            });
            
            return {
                success: true,
                username: username,
                password: password,
                panelUrl: config.panel.url,
                panelPort: config.panel.port
            };
        } else {
            return {
                success: false,
                error: panelApiResponse.error || 'Gagal membuat akun di panel'
            };
        }
    } catch (error) {
        logger.error(`Create panel account error: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
}

// Fungsi untuk generate password random
function generateRandomPassword(length = 12) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < length; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

// Fungsi untuk memanggil API panel (simulasi)
async function callPanelAPI(data) {
    try {
        // Simulasi API call - ganti dengan API panel yang sebenarnya
        if (config.panel.apiKey && config.panel.apiUrl) {
            const response = await axios.post(config.panel.apiUrl, data, {
                headers: {
                    'Authorization': `Bearer ${config.panel.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            return response.data;
        } else {
            // Mode simulasi jika tidak ada API key
            logger.info(`Simulasi pembuatan akun panel: ${JSON.stringify(data)}`);
            return {
                success: true,
                message: 'Akun berhasil dibuat (simulasi)'
            };
        }
    } catch (error) {
        logger.error(`Panel API error: ${error.message}`);
        return {
            success: false,
            error: error.message
        };
    }
}

// Fungsi untuk menyimpan data akun panel
async function savePanelAccountData(accountData) {
    try {
        const accountsFile = path.join(__dirname, 'panel_accounts.json');
        let accounts = [];
        
        // Load existing accounts
        if (fs.existsSync(accountsFile)) {
            const data = fs.readFileSync(accountsFile, 'utf8');
            accounts = JSON.parse(data);
        }
        
        // Add new account
        accounts.push(accountData);
        
        // Save back to file
        fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2));
        logger.info(`Panel account data saved: ${accountData.username}`);
    } catch (error) {
        logger.error(`Save panel account error: ${error.message}`);
    }
}

async function getServerStats() {
    // Implementasi monitoring server
    return {
        cpu: '25%',
        memory: '1.2GB/4GB',
        storage: '15GB/50GB'
    };
}

async function createBackup(outputPath) {
    // Implementasi backup data
    if (!fs.existsSync(path.dirname(outputPath))) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    }
    // Contoh: backup file penting
    const filesToBackup = [MEMORY_FILE, USER_CACHE_FILE];
    // ... proses backup ke ZIP
    return outputPath;
}

// ======================== UTILITAS ========================

async function notifyAdmin(message) {
    try {
        await bot.sendMessage(ADMIN_ID, `🔔 ADMIN NOTIFIKASI:\n${message}`);
    } catch (error) {
        logger.error(`Gagal mengirim notifikasi admin: ${error.message}`);
    }
}

async function handleError(error, context = {}) {
    logger.error(`Error terdeteksi: ${error.message}`, { stack: error.stack, context });

    let errorMessageForUser = BOT_CONFIG.errorMessages.general;
    let adminNotificationMessage = `❌ *ERROR BOT TERDETEKSI!*\n\n*Pesan:* ${error.message}\n*Stack:*\n\`\`\`\n${error.stack ? error.stack.substring(0, 1000) : 'Tidak ada stack trace'}\n\`\`\``;

    if (context.chatId) {
        adminNotificationMessage += `\n*Chat ID:* ${context.chatId}`;
    }
    if (context.userId) {
        adminNotificationMessage += `\n*User ID:* ${context.userId}`;
    }
    if (context.userName) {
        adminNotificationMessage += `\n*User Name:* ${context.userName}`;
    }
    if (context.command) {
        adminNotificationMessage += `\n*Command:* ${context.command}`;
    }
    if (context.query) {
        adminNotificationMessage += `\n*Query:* ${context.query}`;
    }

    // Penanganan error spesifik Telegram API
    if (error.response && error.response.statusCode) {
        const telegramErrorCode = error.response.statusCode;
        adminNotificationMessage += `\n*Kode Error Telegram:* ${telegramErrorCode}`;
        adminNotificationMessage += `\n*Deskripsi Telegram:* ${error.response.description || 'Tidak ada deskripsi'}`;

        if (telegramErrorCode === 403) {
            errorMessageForUser = "❌ Maaf, saya tidak diizinkan untuk mengirim pesan di sini. Pastikan saya memiliki izin yang diperlukan.";
        } else if (telegramErrorCode === 400 && error.message.includes("bot was blocked by the user")) {
            errorMessageForUser = "❌ Anda memblokir bot. Silakan buka blokir bot untuk melanjutkan.";
        } else if (telegramErrorCode === 400 && error.message.includes("chat not found")) {
            errorMessageForUser = "❌ Obrolan tidak ditemukan. Mungkin bot dikeluarkan dari grup atau Anda belum memulai bot.";
        } else if (telegramErrorCode === 400 && error.message.includes("Bad Request: message to edit not found")) {
            // Ini sering terjadi pada callback query yang sudah kadaluarsa, tidak perlu notifikasi user
            errorMessageForUser = null; // Jangan kirim pesan ke user
        } else if (telegramErrorCode === 400 && error.message.includes("can't parse entities")) {
            errorMessageForUser = "❌ Terjadi kesalahan dalam format pesan. Mohon coba lagi dengan teks biasa.";
        } else {
            errorMessageForUser = `❌ Terjadi kesalahan Telegram API (${telegramErrorCode}). Silakan coba lagi nanti.`;
        }
    }

    // Kirim notifikasi ke admin
    await notifyAdmin(adminNotificationMessage);

    // Kirim pesan error ke user jika ada
    if (errorMessageForUser && context.chatId) {
        try {
            await bot.sendMessage(context.chatId, errorMessageForUser);
        } catch (e) {
            logger.error(`Gagal mengirim pesan error ke user ${context.chatId}: ${e.message}`);
        }
    }
}

function formatMessage(text, context = {}) {
    return text
        .replace(/{name}/g, context.name || 'Pengguna')
        .replace(/{botName}/g, BOT_CONFIG.name || 'Bot AI')
        .replace(/{userId}/g, context.userId || 'N/A');
}

// ======================== HANDLER FILE UPLOAD ========================
// Handler untuk foto
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Pengguna';
    
    // Cek apakah fitur upload aktif
    if (!uploadEnabled) {
        logger.info(`[${userName} (${userId})] mengirim foto, tapi upload dinonaktifkan`);
        return; // Tidak melakukan apa-apa jika upload dinonaktifkan
    }
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        
        // Ambil foto dengan resolusi tertinggi
        const photo = msg.photo[msg.photo.length - 1];
        
        // Download file dari Telegram
        const downloadResult = await downloadFileFromTelegram(photo.file_id);
        if (!downloadResult.success) {
            return bot.sendMessage(chatId, `❌ Gagal mengunduh foto: ${downloadResult.error}`);
        }
        
        // Upload ke Catbox
        const uploadResult = await uploadToCatbox(
            downloadResult.buffer, 
            `photo_${Date.now()}.jpg`
        );
        
        if (uploadResult.success) {
            const message = `📸 *Foto berhasil diupload ke Catbox!*\n\n🔗 Link: ${uploadResult.url}\n\n📋 Klik link untuk menyalin atau bagikan ke orang lain.`;
            
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔗 Buka Link', url: uploadResult.url },
                            { text: '📋 Salin Link', callback_data: `copy_link_${encodeURIComponent(uploadResult.url)}` }
                        ]
                    ]
                }
            });
            
            logger.info(`[${userName} (${userId})] upload foto ke Catbox: ${uploadResult.url}`);
        } else {
            await bot.sendMessage(chatId, `❌ Gagal mengupload foto: ${uploadResult.error}`);
        }
    } catch (error) {
        await handleError(error, { chatId, userId, userName, command: 'photo_upload' });
    }
});

// Handler untuk video
bot.on('video', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Pengguna';
    
    // Cek apakah fitur upload aktif
    if (!uploadEnabled) {
        logger.info(`[${userName} (${userId})] mengirim video, tapi upload dinonaktifkan`);
        return; // Tidak melakukan apa-apa jika upload dinonaktifkan
    }
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        
        const video = msg.video;
        
        // Cek ukuran file (maksimal 200MB sesuai limit Catbox)
        if (video.file_size > 200 * 1024 * 1024) {
            return bot.sendMessage(chatId, '❌ Ukuran video terlalu besar! Maksimal 200MB.');
        }
        
        // Download file dari Telegram
        const downloadResult = await downloadFileFromTelegram(video.file_id);
        if (!downloadResult.success) {
            return bot.sendMessage(chatId, `❌ Gagal mengunduh video: ${downloadResult.error}`);
        }
        
        // Upload ke Catbox
        const uploadResult = await uploadToCatbox(
            downloadResult.buffer, 
            `video_${Date.now()}.mp4`
        );
        
        if (uploadResult.success) {
            const message = `🎥 *Video berhasil diupload ke Catbox!*\n\n🔗 Link: ${uploadResult.url}\n📏 Ukuran: ${(video.file_size / (1024 * 1024)).toFixed(2)} MB\n⏱️ Durasi: ${video.duration}s\n\n📋 Klik link untuk menyalin atau bagikan ke orang lain.`;
            
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔗 Buka Link', url: uploadResult.url },
                            { text: '📋 Salin Link', callback_data: `copy_link_${encodeURIComponent(uploadResult.url)}` }
                        ]
                    ]
                }
            });
            
            logger.info(`[${userName} (${userId})] upload video ke Catbox: ${uploadResult.url}`);
        } else {
            await bot.sendMessage(chatId, `❌ Gagal mengupload video: ${uploadResult.error}`);
        }
    } catch (error) {
        await handleError(error, { chatId, userId, userName, command: 'video_upload' });
    }
});

// Handler untuk dokumen/file lainnya
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Pengguna';
    
    // Cek apakah fitur upload aktif
    if (!uploadEnabled) {
        logger.info(`[${userName} (${userId})] mengirim dokumen, tapi upload dinonaktifkan`);
        return; // Tidak melakukan apa-apa jika upload dinonaktifkan
    }
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        
        const document = msg.document;
        
        // Cek ukuran file (maksimal 200MB sesuai limit Catbox)
        if (document.file_size > 200 * 1024 * 1024) {
            return bot.sendMessage(chatId, '❌ Ukuran file terlalu besar! Maksimal 200MB.');
        }
        
        // Download file dari Telegram
        const downloadResult = await downloadFileFromTelegram(document.file_id);
        if (!downloadResult.success) {
            return bot.sendMessage(chatId, `❌ Gagal mengunduh file: ${downloadResult.error}`);
        }
        
        // Upload ke Catbox
        const uploadResult = await uploadToCatbox(
            downloadResult.buffer, 
            document.file_name || `file_${Date.now()}`
        );
        
        if (uploadResult.success) {
            const message = `📄 *File berhasil diupload ke Catbox!*\n\n📁 Nama: ${document.file_name || 'Unknown'}\n🔗 Link: ${uploadResult.url}\n📏 Ukuran: ${(document.file_size / (1024 * 1024)).toFixed(2)} MB\n\n📋 Klik link untuk menyalin atau bagikan ke orang lain.`;
            
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔗 Buka Link', url: uploadResult.url },
                            { text: '📋 Salin Link', callback_data: `copy_link_${encodeURIComponent(uploadResult.url)}` }
                        ]
                    ]
                }
            });
            
            logger.info(`[${userName} (${userId})] upload file ke Catbox: ${uploadResult.url}`);
        } else {
            await bot.sendMessage(chatId, `❌ Gagal mengupload file: ${uploadResult.error}`);
        }
    } catch (error) {
        await handleError(error, { chatId, userId, userName, command: 'document_upload' });
    }
});

// Handler untuk audio
bot.on('audio', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Pengguna';
    
    // Cek apakah fitur upload aktif
    if (!uploadEnabled) {
        logger.info(`[${userName} (${userId})] mengirim audio, tapi upload dinonaktifkan`);
        return; // Tidak melakukan apa-apa jika upload dinonaktifkan
    }
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        
        const audio = msg.audio;
        
        // Cek ukuran file (maksimal 200MB sesuai limit Catbox)
        if (audio.file_size > 200 * 1024 * 1024) {
            return bot.sendMessage(chatId, '❌ Ukuran audio terlalu besar! Maksimal 200MB.');
        }
        
        // Download file dari Telegram
        const downloadResult = await downloadFileFromTelegram(audio.file_id);
        if (!downloadResult.success) {
            return bot.sendMessage(chatId, `❌ Gagal mengunduh audio: ${downloadResult.error}`);
        }
        
        // Upload ke Catbox
        const uploadResult = await uploadToCatbox(
            downloadResult.buffer, 
            audio.file_name || `audio_${Date.now()}.mp3`
        );
        
        if (uploadResult.success) {
            const message = `🎵 *Audio berhasil diupload ke Catbox!*\n\n🎼 Judul: ${audio.title || 'Unknown'}\n👤 Artist: ${audio.performer || 'Unknown'}\n🔗 Link: ${uploadResult.url}\n📏 Ukuran: ${(audio.file_size / (1024 * 1024)).toFixed(2)} MB\n⏱️ Durasi: ${audio.duration}s\n\n📋 Klik link untuk menyalin atau bagikan ke orang lain.`;
            
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔗 Buka Link', url: uploadResult.url },
                            { text: '📋 Salin Link', callback_data: `copy_link_${encodeURIComponent(uploadResult.url)}` }
                        ]
                    ]
                }
            });
            
            logger.info(`[${userName} (${userId})] upload audio ke Catbox: ${uploadResult.url}`);
        } else {
            await bot.sendMessage(chatId, `❌ Gagal mengupload audio: ${uploadResult.error}`);
        }
    } catch (error) {
        await handleError(error, { chatId, userId, userName, command: 'audio_upload' });
    }
});

// Handler untuk voice note
bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Pengguna';
    
    // Cek apakah fitur upload aktif
    if (!uploadEnabled) {
        logger.info(`[${userName} (${userId})] mengirim voice note, tapi upload dinonaktifkan`);
        return; // Tidak melakukan apa-apa jika upload dinonaktifkan
    }
    
    try {
        await bot.sendChatAction(chatId, 'typing');
        
        const voice = msg.voice;
        
        // Download file dari Telegram
        const downloadResult = await downloadFileFromTelegram(voice.file_id);
        if (!downloadResult.success) {
            return bot.sendMessage(chatId, `❌ Gagal mengunduh voice note: ${downloadResult.error}`);
        }
        
        // Upload ke Catbox
        const uploadResult = await uploadToCatbox(
            downloadResult.buffer, 
            `voice_${Date.now()}.ogg`
        );
        
        if (uploadResult.success) {
            const message = `🎤 *Voice note berhasil diupload ke Catbox!*\n\n🔗 Link: ${uploadResult.url}\n📏 Ukuran: ${(voice.file_size / 1024).toFixed(2)} KB\n⏱️ Durasi: ${voice.duration}s\n\n📋 Klik link untuk menyalin atau bagikan ke orang lain.`;
            
            await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔗 Buka Link', url: uploadResult.url },
                            { text: '📋 Salin Link', callback_data: `copy_link_${encodeURIComponent(uploadResult.url)}` }
                        ]
                    ]
                }
            });
            
            logger.info(`[${userName} (${userId})] upload voice note ke Catbox: ${uploadResult.url}`);
        } else {
            await bot.sendMessage(chatId, `❌ Gagal mengupload voice note: ${uploadResult.error}`);
        }
    } catch (error) {
        await handleError(error, { chatId, userId, userName, command: 'voice_upload' });
    }
});

// ======================== HANDLER PESAN UTAMA ========================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;
    const userId = msg.from.id;
    const userName = msg.from.first_name || 'Pengguna';

    // Abaikan command dan pesan kosong, serta pesan yang mengandung file
    if (!messageText || messageText.startsWith("/") || msg.photo || msg.video || msg.document || msg.audio || msg.voice) return;

    // Jika AI dinonaktifkan, abaikan pesan non-command
    if (!aiEnabled) {
        logger.info(`AI dinonaktifkan, mengabaikan pesan dari [${userName} (${userId})]: ${messageText}`);
        return;
    }

    logger.info(`Pesan dari [${userName} (${userId})]: ${messageText}`);

    // Deteksi user baru
    if (!userCache.has(userId)) {
        userCache.add(userId);
        saveUserCache();
        await notifyAdmin(`👤 USER BARU:\n${userName} (${userId})\nPesan: "${messageText}"`);
    }

    try {
        await bot.sendChatAction(chatId, 'typing');
        const aiResponse = await getAIResponse(chatId, messageText);
        await bot.sendMessage(chatId, aiResponse);
        logger.info(`Respons untuk [${userName}]: ${aiResponse.substring(0, 50)}...`);
    } catch (error) {
        await handleError(error, { chatId, userId, userName, command: 'main_message' });
    }
});

// ======================== HANDLER COMMAND ========================
const commandHandlers = {
    start: async (msg) => {
        const chatId = msg.chat.id;
        const userName = msg.from.first_name || 'Pengguna';
        const userId = msg.from.id;
        
        try {
            const welcomeMessage = formatMessage(BOT_CONFIG.welcomeMessage, {
                name: userName,
                userId: userId
            });
            const randomStartImage = await getWaifuImage();

            const uploadStatus = uploadEnabled ? 'Aktif' : 'Nonaktif';
            await bot.sendPhoto(chatId, randomStartImage, {
                caption: welcomeMessage + `\n\n📤 *Fitur Upload:* ${uploadStatus}\n${uploadEnabled ? 'Kirim foto, video, audio, atau file apapun untuk diupload ke Catbox.moe secara otomatis!' : 'Fitur upload sedang dinonaktifkan. Gunakan /bot untuk mengaktifkan.'}`,
                parse_mode: 'Markdown'
            });
            logger.info(`[${userName}] memulai bot`);
        } catch (error) {
            await handleError(error, { chatId, userId, userName, command: 'start' });
        }
    },

    help: async (msg) => {
        const chatId = msg.chat.id;
        try {
            const randomHelpImage = await getWaifuImage();
            const uploadStatus = uploadEnabled ? 'Aktif' : 'Nonaktif';
            const helpMessage = formatMessage(BOT_CONFIG.helpMessage) + `

📤 *FITUR UPLOAD CATBOX (${uploadStatus}):*
${uploadEnabled ? `• Kirim foto → Auto upload ke Catbox
• Kirim video → Auto upload ke Catbox  
• Kirim audio → Auto upload ke Catbox
• Kirim file → Auto upload ke Catbox
• Kirim voice note → Auto upload ke Catbox

✨ Semua file akan diupload otomatis dan kamu akan mendapat link untuk dibagikan!` : `• Fitur upload sedang dinonaktifkan
• Gunakan /bot untuk mengaktifkan fitur upload
• Ketika aktif, semua file akan otomatis diupload ke Catbox.moe`}`;

            bot.sendPhoto(
                chatId,
                randomHelpImage,
                {
                    caption: helpMessage,
                    parse_mode: 'Markdown'
                }
            );
        } catch (error) {
            await handleError(error, { chatId: msg.chat.id, userId: msg.from.id, userName: msg.from.first_name, command: 'help' });
        }
    },


    stats: async (msg) => {
        const chatId = msg.chat.id;   
        try {
            const uploadStatus = uploadEnabled ? '✅ Aktif' : '❌ Nonaktif';
            const statsMessage = `
📊 *STATISTIK BOT*
• 👥 Pengguna: ${userCache.size}
• 💬 Percakapan aktif: ${Object.keys(conversationHistory).length}
• 🧠 Ukuran memori: ${Math.round(fs.statSync(MEMORY_FILE)?.size / 1024 || 0)} KB
• ⚙️ Versi: ${BOT_CONFIG.version}
• 📤 Fitur Upload: ${uploadStatus}
            `.trim();
            await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
        } catch (error) {
            await handleError(error, { chatId: msg.chat.id, userId: msg.from.id, userName: msg.from.first_name, command: 'stats' });
        }
    },


    clear: async (msg) => {
        const chatId = msg.chat.id;
        try {
            conversationHistory[chatId] = [];
            saveConversationHistory();
            await bot.sendMessage(chatId, '🧹 Memori percakapan berhasil dihapus!');
            logger.info(`[${chatId}] hapus memori`);
        } catch (error) {
            await handleError(error, { chatId: msg.chat.id, userId: msg.from.id, userName: msg.from.first_name, command: 'clear' });
        }
    },


    pin: async (msg, match) => {
        const chatId = msg.chat.id;
        const query = match[1];
        if (!query) {
            return bot.sendMessage(
                chatId, 
                formatMessage(BOT_CONFIG.errorMessages.invalidQuery), 
                { parse_mode: 'Markdown' }
            );
        }

        try {
            await bot.sendChatAction(chatId, 'upload_photo');
            const response = await axios.get(
                `https://api.vreden.my.id/api/pinterest?query=${encodeURIComponent(query)}`,
                { timeout: 10000 }
            );

            const imageUrls = response.data?.result || [];
            if (imageUrls.length > 0) {
                await bot.sendPhoto(chatId, imageUrls[0], { 
                    caption: `📌 Hasil untuk: *${query}*`,
                    parse_mode: 'Markdown'
                });
            } else {
                await bot.sendMessage(chatId, `❌ Tidak ditemukan gambar untuk "${query}"`);
            }
        } catch (error) {
            await handleError(error, { chatId, userId: msg.from.id, userName: msg.from.first_name, command: 'pin', query });
        }
    },

    ig: async (msg, match) => {
        const chatId = msg.chat.id;
        const url = match[1];
        if (!url) {
            return bot.sendMessage(chatId, `❌ Mohon berikan URL Instagram setelah perintah /ig. Contoh: /ig https://www.instagram.com/reel/DNdEFAKJFWY/`);
        }

        try {
            await bot.sendChatAction(chatId, 'upload_video');
            const apiUrl = `https://api.vreden.my.id/api/download/instagram2?url=${encodeURIComponent(url)}`;
            const response = await axios.get(apiUrl, { timeout: 30000 });
            const result = response.data.result;

            if (result && result.media && result.media.length > 0) {
                const videoMedia = result.media.find(m => m.type === 'video');
                const imageMedia = result.media.find(m => m.type === 'image');

                if (videoMedia) {
                    await bot.sendVideo(chatId, videoMedia.url, {
                        caption: `✅ Video berhasil diunduh dari Instagram!\nJudul: ${result.title || 'Tidak ada judul'}`,
                        parse_mode: 'Markdown'
                    });
                } else if (imageMedia) {
                    await bot.sendPhoto(chatId, imageMedia.url, {
                        caption: `✅ Gambar berhasil diunduh dari Instagram!\nJudul: ${result.title || 'Tidak ada judul'}`,
                        parse_mode: 'Markdown'
                    });
                }
            } else {
                await bot.sendMessage(chatId, '❌ Gagal mengunduh media dari Instagram. Pastikan URL valid.');
            }
        } catch (error) {
            await handleError(error, { chatId, userId: msg.from.id, userName: msg.from.first_name, command: 'ig', query: url });
        }
    },


    yt: async (msg, match) => {
        const chatId = msg.chat.id;
        const url = match[1];
        if (!url) {
            return bot.sendMessage(chatId, `❌ Mohon berikan URL YouTube setelah perintah /yt. Contoh: /yt https://youtu.be/dQw4w9WgXcQ`);
        }

        try {
            await bot.sendChatAction(chatId, 'upload_video');
            const apifyApiUrl = `https://api.apify.com/v2/acts/streamers~youtube-video-downloader/run-sync-get-dataset-items?token=${config.apify.apiKey}`;
            
            const response = await axios.post(apifyApiUrl, {
                videos: [{
                    url: url
                }]
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 60000 // Meningkatkan timeout karena download bisa lama
            });

            const result = response.data?.items?.[0];

            if (result && result.url) {
                await bot.sendVideo(chatId, result.url, {
                    caption: `✅ Video berhasil diunduh dari YouTube!\nJudul: ${result.title || 'Tidak ada judul'}`,
                    parse_mode: 'Markdown'
                });
            } else {
                await bot.sendMessage(chatId, '❌ Gagal mengunduh video dari YouTube. Pastikan URL valid atau coba lagi nanti.');
            }
        } catch (error) {
            await handleError(error, { chatId, userId: msg.from.id, userName: msg.from.first_name, command: 'yt', query: url });
        }
    },
    bot: async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const userName = msg.from.first_name || 'Pengguna';
        
        try {
            const botImage = await getWaifuImage();
            await bot.sendPhoto(chatId, botImage, {
                caption: `🤖 *PANEL KONTROL BOT*\n\nKelola fitur bot dengan mudah:`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: `AI: ${aiEnabled ? '✅ Aktif' : '❌ Nonaktif'}`, callback_data: 'toggle_ai' },
                            { text: `Upload: ${uploadEnabled ? '✅ Aktif' : '❌ Nonaktif'}`, callback_data: 'toggle_upload' }
                        ],
                        [
                            { text: '✨ Atur Kepribadian', callback_data: 'set_personality' },
                            { text: '🔄 Reset Percakapan', callback_data: 'reset_conversation' }
                        ],
                        [
                            { text: '📸 Screenshot Web', callback_data: 'screenshot_web' },
                            { text: 'ℹ️ Info Bot', callback_data: 'bot_info' }
                        ],
                        [
                            { text: '🖼️ Random Image', callback_data: 'random_image' },
                            { text: '🔧 Create Panel', callback_data: 'create_panel_menu' }
                        ],
                        [
                            { text: '📤 Upload Info', callback_data: 'upload_info' }
                        ]
                    ]
                }
            });
            
            logger.info(`[${userName} (${userId})] mengakses panel kontrol bot`);
        } catch (error) {
            await handleError(error, { chatId, userId, userName, command: 'bot' });
        }
    }, play: async (msg, match) => {
        const chatId = msg.chat.id;
        const query = match[1];
        if (!query) {
            return bot.sendMessage(chatId, `🎵 Masukkan judul lagu yang ingin dicari!\n\nContoh: /play dj tiktok viral`);
        }

        try {
            await bot.sendChatAction(chatId, 'upload_audio');
            const apifyApiUrl = `https://api.apify.com/v2/acts/scrapearchitect~youtube-audio-mp3-downloader/run-sync-get-dataset-items?token=${config.apify.apiKey}`;
            
            const response = await axios.post(apifyApiUrl, {
                video_urls: [{
                    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
                }]
            }, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 60000 // Meningkatkan timeout karena download bisa lama
            });

            const result = response.data?.items?.[0];

            if (result && result.audio_url) {
                await bot.sendAudio(chatId, result.audio_url, {
                    caption: `✅ Audio berhasil diunduh dari YouTube!\nJudul: ${result.title || 'Tidak ada judul'}`,
                    parse_mode: 'Markdown'
                });
            } else {
                await bot.sendMessage(chatId, `❌ Tidak ditemukan lagu untuk "${query}" atau gagal mengunduh audio. Pastikan judul valid atau coba lagi nanti.`);
            }
        } catch (error) {
            await handleError(error, { chatId, userId: msg.from.id, userName: msg.from.first_name, command: 'play', query });
        }
    },
    screenshot: async (msg, match) => {
        const chatId = msg.chat.id;
        const input = match[1];
        if (!input) {
            return bot.sendMessage(chatId, `📸 *Screenshot Web*\n\nMasukkan URL website yang ingin di-screenshot!\n\n📝 Format: /ssweb [URL] [device]\n\n📱 Device types:\n• desktop (default)\n• mobile\n• tablet\n\n🔗 Contoh:\n• /ssweb https://google.com\n• /ssweb https://github.com mobile\n• /ssweb https://youtube.com tablet`, { parse_mode: 'Markdown' });
        }

        // Parse input untuk URL dan device type
        const parts = input.split(' ');
        const url = parts[0];
        let deviceType = parts[1] || 'desktop';

        // Validasi URL
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            return bot.sendMessage(chatId, '❌ URL harus dimulai dengan http:// atau https://');
        }

        // Validasi device type
        const validDeviceTypes = ['desktop', 'mobile', 'tablet'];
        if (!validDeviceTypes.includes(deviceType)) {
            deviceType = 'desktop';
        }

        try {
            await bot.sendChatAction(chatId, 'upload_photo');
            const response = await axios.get(
                `https://api.vreden.my.id/api/ssweb?url=${encodeURIComponent(url)}&type=${deviceType}`,
                { 
                    timeout: 30000,
                    responseType: 'arraybuffer' 
                }
            );

            // Simpan screenshot sementara
            const tempFile = path.join(__dirname, 'temp', `screenshot_${Date.now()}.jpg`);
            fs.writeFileSync(tempFile, response.data);

            // Kirim screenshot
            await bot.sendPhoto(
                chatId,
                tempFile,
                {
                    caption: `📸 Screenshot ${url}\nDevice: ${deviceType}`,
                    parse_mode: 'Markdown'
                }
            );

            // Hapus file temp
            fs.unlinkSync(tempFile);
        } catch (error) {
            await handleError(error, { chatId, userId: msg.from.id, userName: msg.from.first_name, command: 'ssweb', query: url });
        }
    },
    tiktok: async (msg, match) => {
        const chatId = msg.chat.id;
        const text = match[1];
        if (!text) {
            return bot.sendMessage(chatId, `🔗 Masukkan link TikTok!\n\nContoh: /tiktok https://vt.tiktok.com/xxxx/`);
        }

        if (!text.includes('tiktok.com')) {
            return bot.sendMessage(chatId, '❌ Link yang Anda masukkan bukan link TikTok.');
        }

        await bot.sendMessage(chatId, 'Sedang memproses, mohon tunggu...');

        try {
            // === 🖼️ Jika slideshow (photo)
            if (text.includes('/photo/')) {
                const slideResponse = await axios.get(`https://dlpanda.com/id?url=${text}&token=G7eRpMaa`);
                const $ = cheerio.load(slideResponse.data);
                let images = [];

                $("div.col-md-12 > img").each((i, el) => {
                    const src = $(el).attr("src");
                    if (src && src.startsWith('http')) images.push(src);
                });

                if (images.length === 0) {
                    return bot.sendMessage(chatId, '❌ Gagal mengunduh slideshow. Coba link lain atau pastikan link benar.');
                }

                await bot.sendMessage(chatId, `✅ Berhasil mengunduh ${images.length} foto dari slideshow. Mengirim gambar...`);

                for (const imageUrl of images) {
                    await bot.sendPhoto(chatId, imageUrl);
                    await new Promise(resolve => setTimeout(resolve, 1000)); // sleep
                }
            } else {
                // === 🎥 Jika video biasa
                const params = new URLSearchParams();
                params.set("url", text);
                params.set("hd", "1");

                const videoResponse = await axios.post("https://tikwm.com/api/", params, {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "Cookie": "current_language=en",
                        "User-Agent": "Mozilla/5.0 (Linux; Android 10)"
                    }
                });

                const result = videoResponse?.data?.data;
                if (!result || !result.play) {
                    return bot.sendMessage(chatId, '❌ Gagal mendapatkan video. Mungkin link salah atau tidak didukung.');
                }

                let caption = `🎬 *${result.title || 'Tanpa Judul'}*\n\n✅ Video berhasil diunduh tanpa watermark.`;

                await bot.sendVideo(chatId, result.play, {
                    caption: caption,
                    parse_mode: 'Markdown'
                });
            }
        } catch (err) {
            await handleError(err, { chatId, userId: msg.from.id, userName: msg.from.first_name, command: 'tiktok', query: text });
        }
    },

    // [FITUR BARU] Hentai Video - Hanya untuk Premium dan Owner
    hentai: async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        try {
            await bot.sendChatAction(chatId, 'upload_video');        

            // Panggil API hentai video
            const response = await axios.get('https://api.vreden.my.id/api/hentaivid', { 
                timeout: 15000 
            });  

            // API mengembalikan array, ambil item pertama
            const result = response.data?.result;
            let videoUrl = null;    

            if (Array.isArray(result) && result.length > 0) {
                // Ambil video random dari array
                const randomIndex = Math.floor(Math.random() * result.length);
                const selectedVideo = result[randomIndex];      

                // Coba ambil URL dari berbagai field yang mungkin
                videoUrl = selectedVideo.video_1 || selectedVideo.video_2 || selectedVideo.link;
            } else if (result?.url) {
                // Fallback jika format berbeda
                videoUrl = result.url;
            }

            if (videoUrl) {
                logger.info(`Mengirim video dari URL: ${videoUrl}`);
                await bot.sendVideo(chatId, videoUrl, {
                    caption: '🔞 *Video Hentai*\n\n⚠️ Konten dewasa - 18+',
                    parse_mode: 'Markdown'
                });

                // Log penggunaan fitur
                logger.info(`[${userId}] menggunakan fitur hentai`);
            } else {
                await bot.sendMessage(chatId, '❌ Gagal mendapatkan video hentai. Coba lagi nanti.');
                logger.error(`Hentai API response: ${JSON.stringify(response.data)}`);
            }
        } catch (error) {
            await handleError(error, { chatId, userId, userName: msg.from.first_name, command: 'hentai' });
        }
    },

    // [FITUR BARU] Create Panel - Pembuatan akun panel
    createpanel: async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const userName = msg.from.first_name || 'User';
        
        try {
            const panelImage = await getWaifuImage();
            await bot.sendPhoto(chatId, panelImage, {
                caption: `🔧 *CREATE PANEL*\n\nPilih paket yang diinginkan:`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📦 1GB User,idtele', callback_data: 'create_panel_1gb' },
                            { text: '📦 2GB User,idtele', callback_data: 'create_panel_2gb' }
                        ],
                        [
                            { text: '📦 3GB User,idtele', callback_data: 'create_panel_3gb' },
                            { text: '📦 4GB User,idtele', callback_data: 'create_panel_4gb' }
                        ],
                        [
                            { text: '📦 5GB User,idtele', callback_data: 'create_panel_5gb' },
                            { text: '📦 6GB User,idtele', callback_data: 'create_panel_6gb' }
                        ],
                        [
                            { text: '📦 7GB User,idtele', callback_data: 'create_panel_7gb' },
                            { text: '📦 8GB User,idtele', callback_data: 'create_panel_8gb' }
                        ],
                        [
                            { text: '📦 9GB User,idtele', callback_data: 'create_panel_9gb' },
                            { text: '📦 10GB User,idtele', callback_data: 'create_panel_10gb' }
                        ],
                        [
                            { text: '📦 Unli User,idtele', callback_data: 'create_panel_unli' }
                        ],
                        [
                            { text: '👑 Create Admin User,idtele', callback_data: 'create_panel_admin' }
                        ]
                    ]
                }
            });
            
            logger.info(`[${userName} (${userId})] mengakses menu create panel`);
        } catch (error) {
            await handleError(error, { chatId, userId, userName, command: 'createpanel' });
        }
    },

    // [FITUR BARU] QR Code Generator
    qr: async (msg, match) => {
        const chatId = msg.chat.id;
        const data = match[1];
        const userId = msg.from.id;
        const userName = msg.from.first_name || 'Pengguna';
        
        if (!data) {
            return bot.sendMessage(chatId, `📱 *QR Code Generator*\n\nMasukkan teks atau URL yang ingin diubah menjadi QR code!\n\n📝 Contoh:\n• /qr Hello World\n• /qr https://google.com\n• /qr 6283850540570\n• /qr Ini adalah pesan rahasia`, { parse_mode: 'Markdown' });
        }

        try {
            await bot.sendChatAction(chatId, 'upload_photo');
            
            // Generate QR code menggunakan API qrserver.com
            const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(data)}`;
            
            // Kirim QR code sebagai foto
            await bot.sendPhoto(chatId, qrApiUrl, {
                caption: `📱 *QR Code berhasil dibuat!*\n\n📝 Data: \`${data}\`\n📏 Ukuran: 400x400 px\n\n✨ Scan QR code ini dengan kamera atau aplikasi QR scanner untuk melihat isinya!`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔗 Buka Link QR', url: qrApiUrl },
                            { text: '📋 Salin Data', callback_data: `copy_qr_data_${encodeURIComponent(data)}` }
                        ]
                    ]
                }
            });
            
            logger.info(`[${userName} (${userId})] membuat QR code untuk: ${data.substring(0, 50)}...`);
        } catch (error) {
            await handleError(error, { chatId, userId, userName, command: 'qr', query: data });
        }
    },

    // [FITUR BARU] Sfile Search
    sc: async (msg, match) => {
        const chatId = msg.chat.id;
        const query = match[1];
        const userId = msg.from.id;
        const userName = msg.from.first_name || 'Pengguna';

        if (!query) {
            return bot.sendMessage(chatId, `🔍 *Sfile Search*\n\nMasukkan kata kunci untuk mencari file di Sfile.mobi!\n\n📝 Contoh:\n• /sc ddos\n• /sc film terbaru\n• /sc aplikasi pro`, { parse_mode: 'Markdown' });
        }

        try {
            await bot.sendChatAction(chatId, 'typing');
            const apiUrl = `https://api.vreden.my.id/api/sfile-search?query=${encodeURIComponent(query)}`;
            const response = await axios.get(apiUrl, { timeout: 30000 });
            const results = response.data?.result;

            if (results && results.length > 0) {
                let message = `🔍 *Hasil Pencarian Sfile.mobi untuk "${query}":*\n\n`;
                results.slice(0, 10).forEach((item, index) => {
                    message += `${index + 1}. *${item.title}*\n   Ukuran: ${item.size}\n   Link: ${item.link}\n\n`;
                });
                if (results.length > 10) {
                    message += `_Menampilkan 10 hasil teratas. Ada ${results.length - 10} hasil lainnya._\n`;
                }
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                logger.info(`[${userName} (${userId})] mencari sfile: ${query}. Ditemukan ${results.length} hasil.`);
            } else {
                await bot.sendMessage(chatId, `❌ Tidak ditemukan hasil untuk "${query}" di Sfile.mobi.`);
                logger.info(`[${userName} (${userId})] mencari sfile: ${query}. Tidak ditemukan hasil.`);
            }
        } catch (error) {
            await handleError(error, { chatId, userId, userName, command: 'sc', query });
        }
    },

    // [FITUR BARU] Profil TikTok - Menampilkan foto profil TikTok
    profil: async (msg, match) => {
        const chatId = msg.chat.id;
        const username = match[1];
        const userId = msg.from.id;
        const userName = msg.from.first_name || 'Pengguna';

        if (!username) {
            return bot.sendMessage(chatId, `👤 *Profil TikTok*\n\nMasukkan username TikTok untuk melihat foto profil!\n\n📝 Contoh:\n• /profil rizky.cyber\n• /profil username_tiktok\n• /profil @username`, { parse_mode: 'Markdown' });
        }

        // Bersihkan username dari @ jika ada
        const cleanUsername = username.replace('@', '');

        try {
            await bot.sendChatAction(chatId, 'upload_photo');
            
            // Panggil API TikTok stalk
            const apiUrl = `https://api.vreden.my.id/api/tiktokStalk?query=${encodeURIComponent(cleanUsername)}`;
            const response = await axios.get(apiUrl, { timeout: 30000 });
            const result = response.data?.result;

            if (result && result.user) {
                const user = result.user;
                const stats = result.stats || result.statsV2;
                
                // Ambil foto profil dengan kualitas terbaik
                const profileImage = user.avatarLarger || user.avatarMedium || user.avatarThumb;
                
                if (profileImage) {
                    const caption = `👤 *Profil TikTok*\n\n` +
                        `🆔 Username: @${user.uniqueId}\n` +
                        `📝 Nama: ${user.nickname || 'Tidak ada nama'}\n` +
                        `👥 Followers: ${stats?.followerCount || '0'}\n` +
                        `➡️ Following: ${stats?.followingCount || '0'}\n` +
                        `❤️ Total Likes: ${stats?.heartCount || '0'}\n` +
                        `🎥 Video: ${stats?.videoCount || '0'}\n` +
                        `📝 Bio: ${user.signature || 'Tidak ada bio'}\n` +
                        `✅ Verified: ${user.verified ? 'Ya' : 'Tidak'}\n` +
                        `🔒 Private: ${user.privateAccount ? 'Ya' : 'Tidak'}`;

                    await bot.sendPhoto(chatId, profileImage, {
                        caption: caption,
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '🔗 Lihat Profil TikTok', url: `https://www.tiktok.com/@${user.uniqueId}` }
                                ]
                            ]
                        }
                    });

                    logger.info(`[${userName} (${userId})] melihat profil TikTok: @${user.uniqueId}`);
                } else {
                    await bot.sendMessage(chatId, `❌ Tidak dapat mengambil foto profil untuk username "${cleanUsername}".`);
                }
            } else {
                await bot.sendMessage(chatId, `❌ Username TikTok "${cleanUsername}" tidak ditemukan. Pastikan username benar dan akun tidak private.`);
            }
        } catch (error) {
            await handleError(error, { chatId, userId, userName, command: 'profil', query: username });
        }
    }
};

// Daftarkan handler command
bot.onText(/\/start/, commandHandlers.start);
bot.onText(/\/help/, commandHandlers.help);
bot.onText(/\/stats/, commandHandlers.stats);
bot.onText(/\/clear/, commandHandlers.clear);
bot.onText(/\/pin\s*(.*)/, commandHandlers.pin);
bot.onText(/\/ig\s*(.*)/, commandHandlers.ig);
bot.onText(/\/yt\s*(.*)/, commandHandlers.yt);
bot.onText(/\/bot/, commandHandlers.bot);
bot.onText(/\/play(?: (.+))?/, commandHandlers.play);
bot.onText(/\/ssweb(?: (.+))?/, commandHandlers.screenshot);
bot.onText(/\/tiktok(?: (.+))?/, commandHandlers.tiktok);
bot.onText(/\/hentai/, commandHandlers.hentai); // [FITUR BARU]
bot.onText(/\/createpanel/, commandHandlers.createpanel); // [FITUR BARU] Create Panel
bot.onText(/\/qr(?: (.+))?/, commandHandlers.qr); // [FITUR BARU] QR Code Generator
bot.onText(/\/sc(?: (.+))?/, commandHandlers.sc); // [FITUR BARU] Sfile Search
bot.onText(/\/profil(?: (.+))?/, commandHandlers.profil); // [FITUR BARU] Profil TikTok

// ======================== HANDLER CALLBACK ========================
bot.on('callback_query', async (callbackQuery) => {
    const { message, data } = callbackQuery;
    const chatId = message.chat.id;
    await bot.answerCallbackQuery(callbackQuery.id);

    try {
        if (data === 'reset_conversation') {
            conversationHistory[chatId] = [];
            saveConversationHistory();
            await bot.sendMessage(chatId, '🧹 Memori percakapan direset!');
        }
        else if (data === 'set_personality') {
            const keyboard = [];
            let row = [];
            for (const [key, personality] of Object.entries(BOT_CONFIG.personalities)) {
                row.push({
                    text: personality.buttonLabel,
                    callback_data: `set_personality_${key}`
                });
                if (row.length === 2) {
                    keyboard.push(row);
                    row = [];
                }
            }
            if (row.length > 0) {
                keyboard.push(row);
            }
            keyboard.push([{ text: '🔙 Kembali', callback_data: 'back_to_main' }]);       

            await bot.editMessageReplyMarkup({
                inline_keyboard: keyboard
            }, {
                chat_id: chatId,
                message_id: message.message_id
            });
        }
        else if (data.startsWith('set_personality_')) {
            const personalityKey = data.replace('set_personality_', '');
            const personality = BOT_CONFIG.personalities[personalityKey];        

            if (personality) {
                // Set kepribadian baru sebagai system message
                conversationHistory[chatId] = [{
                    role: 'system',
                    content: personality.systemMessage,
                    timestamp: Date.now()
                }];            

                saveConversationHistory();              

                await bot.sendMessage(
                    chatId, 
                    `🎭 *Kepribadian Diatur:* ${personality.name}\n\n${personality.description}`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
        else if (data === 'back_to_main') {
            await bot.editMessageReplyMarkup({
                inline_keyboard: [
                    [
                        { text: `AI: ${aiEnabled ? '✅ Aktif' : '❌ Nonaktif'}`, callback_data: 'toggle_ai' },
                        { text: `Upload: ${uploadEnabled ? '✅ Aktif' : '❌ Nonaktif'}`, callback_data: 'toggle_upload' }
                    ],
                    [
                        { text: '✨ Atur Kepribadian', callback_data: 'set_personality' },
                        { text: '🔄 Reset Percakapan', callback_data: 'reset_conversation' }
                    ],
                    [
                        { text: '📸 Screenshot Web', callback_data: 'screenshot_web' },
                        { text: 'ℹ️ Info Bot', callback_data: 'bot_info' }
                    ],
                    [
                        { text: '🖼️ Random Image', callback_data: 'random_image' },
                        { text: '🔧 Create Panel', callback_data: 'create_panel_menu' }
                    ],
                    [
                        { text: '📤 Upload Info', callback_data: 'upload_info' }
                    ]
                ]
            }, {
                chat_id: chatId,
                message_id: message.message_id
            });
        }
        else if (data === 'toggle_ai') {
            aiEnabled = !aiEnabled;
            saveAIStatus();
            await bot.answerCallbackQuery(callbackQuery.id, `AI ${aiEnabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
            
            // Update button
            await bot.editMessageReplyMarkup({
                inline_keyboard: [
                    [
                        { text: `AI: ${aiEnabled ? '✅ Aktif' : '❌ Nonaktif'}`, callback_data: 'toggle_ai' },
                        { text: `Upload: ${uploadEnabled ? '✅ Aktif' : '❌ Nonaktif'}`, callback_data: 'toggle_upload' }
                    ],
                    [
                        { text: '✨ Atur Kepribadian', callback_data: 'set_personality' },
                        { text: '🔄 Reset Percakapan', callback_data: 'reset_conversation' }
                    ],
                    [
                        { text: '📸 Screenshot Web', callback_data: 'screenshot_web' },
                        { text: 'ℹ️ Info Bot', callback_data: 'bot_info' }
                    ],
                    [
                        { text: '🖼️ Random Image', callback_data: 'random_image' },
                        { text: '🔧 Create Panel', callback_data: 'create_panel_menu' }
                    ],
                    [
                        { text: '📤 Upload Info', callback_data: 'upload_info' }
                    ]
                ]
            }, {
                chat_id: chatId,
                message_id: message.message_id
            });
        }
        else if (data === 'toggle_upload') {
            uploadEnabled = !uploadEnabled;
            saveUploadStatus();
            await bot.answerCallbackQuery(callbackQuery.id, `Upload ${uploadEnabled ? 'diaktifkan' : 'dinonaktifkan'}!`, true);
            
            // Update button
            await bot.editMessageReplyMarkup({
                inline_keyboard: [
                    [
                        { text: `AI: ${aiEnabled ? '✅ Aktif' : '❌ Nonaktif'}`, callback_data: 'toggle_ai' },
                        { text: `Upload: ${uploadEnabled ? '✅ Aktif' : '❌ Nonaktif'}`, callback_data: 'toggle_upload' }
                    ],
                    [
                        { text: '✨ Atur Kepribadian', callback_data: 'set_personality' },
                        { text: '🔄 Reset Percakapan', callback_data: 'reset_conversation' }
                    ],
                    [
                        { text: '📸 Screenshot Web', callback_data: 'screenshot_web' },
                        { text: 'ℹ️ Info Bot', callback_data: 'bot_info' }
                    ],
                    [
                        { text: '🖼️ Random Image', callback_data: 'random_image' },
                        { text: '🔧 Create Panel', callback_data: 'create_panel_menu' }
                    ],
                    [
                        { text: '📤 Upload Info', callback_data: 'upload_info' }
                    ]
                ]
            }, {
                chat_id: chatId,
                message_id: message.message_id
            });
        }
           else if (data === 'bot_info') {
            const uploadStatus = uploadEnabled ? '✅ Aktif' : '❌ Nonaktif';
            const aiStatus = aiEnabled ? '✅ Aktif' : '❌ Nonaktif';
            const infoMessage = `
🤖 *INFO BOT*

• *Nama Bot:* ${BOT_CONFIG.name}
• *Versi:* ${BOT_CONFIG.version}
• *Deskripsi:* ${BOT_CONFIG.description}
• *Update Terakhir:* ${BOT_CONFIG.lastUpdate}
• *Status AI:* ${aiStatus}
• *Status Upload:* ${uploadStatus}

Terima kasih telah menggunakan bot ini! 😊
            `.trim();
            await bot.sendMessage(chatId, infoMessage, { parse_mode: 'Markdown' });
        }
        else if (data === 'upload_info') {
            const uploadStatus = uploadEnabled ? '✅ Aktif' : '❌ Nonaktif';
            const uploadInfoMessage = `
📤 *INFO FITUR UPLOAD CATBOX*

Status: ${uploadStatus}

${uploadEnabled ? `Ketika aktif, bot akan secara otomatis mengupload file yang Anda kirim (foto, video, audio, dokumen, voice note) ke Catbox.moe dan memberikan link langsung kepada Anda.

*Cara Penggunaan:*
1. Kirim foto, video, audio, atau dokumen ke bot.
2. Bot akan menguploadnya dan membalas dengan link Catbox.moe.
3. Anda bisa langsung membuka atau menyalin link tersebut.

*Keuntungan:*
• Berbagi file dengan mudah.
• Tidak perlu upload manual ke platform lain.
• Link langsung dan permanen (selama file tidak dihapus dari Catbox).

*Catatan:*
• Ukuran file maksimal mengikuti batasan Telegram dan Catbox.moe.
• Pastikan Anda tidak mengupload konten ilegal atau melanggar hak cipta.` : `Fitur upload saat ini dinonaktifkan. Anda bisa mengaktifkannya melalui menu /bot jika diperlukan.`}
            `.trim();
            await bot.sendMessage(chatId, uploadInfoMessage, { parse_mode: 'Markdown' });
        }
        else if (data === 'create_panel_menu') {
            await commandHandlers.createpanel({ chat: { id: chatId }, from: { id: callbackQuery.from.id, first_name: callbackQuery.from.first_name } });
        }
        else if (data.startsWith('create_panel_')) {
            const packageType = data.replace('create_panel_', '');
            const userId = callbackQuery.from.id;
            const userName = callbackQuery.from.first_name || 'User';
            
            // Definisi paket
            const packageInfo = {
                '1gb': { size: '1GB', quota: 1024, duration: 30 },
                '2gb': { size: '2GB', quota: 2048, duration: 30 },
                '3gb': { size: '3GB', quota: 3072, duration: 30 },
                '4gb': { size: '4GB', quota: 4096, duration: 30 },
                '5gb': { size: '5GB', quota: 5120, duration: 30 },
                '6gb': { size: '6GB', quota: 6144, duration: 30 },
                '7gb': { size: '7GB', quota: 7168, duration: 30 },
                '8gb': { size: '8GB', quota: 8192, duration: 30 },
                '9gb': { size: '9GB', quota: 9216, duration: 30 },
                '10gb': { size: '10GB', quota: 10240, duration: 30 },
                'unli': { size: 'Unlimited', quota: -1, duration: 30 },
                'admin': { size: 'Admin', quota: -1, duration: 365 }
            };
            
            const selectedPackage = packageInfo[packageType];
            if (!selectedPackage) {
                return bot.sendMessage(chatId, '❌ Paket tidak valid!');
            }
            
            try {
                // Simulasi pembuatan akun panel
                const panelAccount = await createPanelAccount(selectedPackage, userId, userName);
                
                if (panelAccount.success) {
                    const successMessage = `
✅ *AKUN PANEL BERHASIL DIBUAT*

👤 *Detail Akun:*
• Username: \`${panelAccount.username}\`
• Password: \`${panelAccount.password}\`
• Paket: ${selectedPackage.size}
• Durasi: ${selectedPackage.duration} hari
• Status: Aktif

🌐 *Panel Info:*
• URL Panel: ${config.panel.url}
• Port: ${config.panel.port}

⚠️ *Penting:*
• Simpan data login dengan baik
• Jangan share akun ke orang lain
• Hubungi admin jika ada masalah

🔗 *Link Panel:* ${config.panel.url}:${config.panel.port}
                    `.trim();
                    
                    await bot.sendMessage(chatId, successMessage, { 
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '🌐 Buka Panel', url: `${config.panel.url}:${config.panel.port}` }
                                ]
                            ]
                        }
                    });
                    
                    // Notifikasi admin
                    await notifyAdmin(`
🆕 *AKUN PANEL BARU*
👤 User: ${userName} (${userId})
📦 Paket: ${selectedPackage.size}
🔑 Username: ${panelAccount.username}
                    `.trim());
                    
                    logger.info(`Panel account created: ${panelAccount.username} for user ${userId}`);
                } else {
                    await bot.sendMessage(chatId, `❌ Gagal membuat akun panel: ${panelAccount.error}`);
                }
            } catch (error) {
                logger.error(`Create panel error: ${error.message}`);
                await bot.sendMessage(chatId, '❌ Terjadi kesalahan saat membuat akun panel.');
            }
        }
    } catch (error) {
        await handleError(error, { chatId, userId: callbackQuery.from.id, userName: callbackQuery.from.first_name, command: 'callback_query', query: data });
    }
});

// ======================== MANAJEMEN PROSES ========================
bot.on('error', error => logger.error(`Bot error: ${error.message}`));
bot.on('polling_error', error => logger.error(`Polling error: ${error.message}`));

async function gracefulShutdown() {
    logger.info('🛑 Menghentikan bot...');
    saveConversationHistory();
    saveUserCache();
    saveUploadStatus();
    await notifyAdmin('🔴 Bot dimatikan!');
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ======================== INISIALISASI BOT ========================
(async () => {
    try {
        // Buat folder yang diperlukan
        const folders = ['logs', 'temp', 'backups'];
        folders.forEach(folder => {
            if (!fs.existsSync(folder)) fs.mkdirSync(folder);
        });

        // Load data
        loadConversationHistory();
        loadUserCache();
        loadUploadStatus(); // Load status upload

        // Verifikasi koneksi bot
        const botInfo = await bot.getMe();
        logger.info(chalk.green.bold(`

🚀 Bot berhasil dijalankan!\n`));
        logger.info(chalk.cyan(`🤖 Nama Bot: ${botInfo.first_name}`));
        logger.info(chalk.cyan(`🔗 Username: @${botInfo.username}`));
        logger.info(chalk.magenta(`📆 Waktu Mulai: ${new Date().toLocaleString()}`));
        logger.info(chalk.yellow(`💻 Platform: ${os.platform()} ${os.release()}`));
        logger.info(chalk.yellow(`🟢 Node.js Version: ${process.version}`));
        logger.info(chalk.blue(`📤 Upload Status: ${uploadEnabled ? 'Aktif' : 'Nonaktif'}`));
        logger.info(chalk.green.bold(`
Bot siap melayani!\n`));

        const uploadStatus = uploadEnabled ? 'Aktif' : 'Nonaktif';
        await notifyAdmin(`🚀 Bot aktif! ${botInfo.first_name} siap melayani\n📤 Fitur upload Catbox.moe: ${uploadStatus}\n📱 Fitur QR Code Generator: Aktif\n🔍 Fitur Sfile Search: Aktif\n👤 Fitur Profil TikTok: Aktif`);

        // Backup otomatis setiap 24 jam
        setInterval(() => {
            logger.info('⏰ Memulai backup terjadwal');
            saveConversationHistory();
            saveUserCache();
            saveUploadStatus();
        }, 24 * 60 * 60 * 1000);

    } catch (error) {
        logger.error(`Gagal memulai bot: ${error.message}`);
        process.exit(1);
    }
})();

async function getWaifuImage() {
    try {
        const response = await axios.get("https://api.waifu.pics/sfw/neko");
        return response.data.url;
    } catch (error) {
        logger.error(`Error fetching Waifu image: ${error.message}`);
        return null;
    }
}

// ======================== HANDLER GRUP ========================
bot.on("new_chat_members", async (msg) => {
    const chatId = msg.chat.id;
    const newMembers = msg.new_chat_members;
    const chatTitle = msg.chat.title;

    for (const member of newMembers) {
        if (member.id === bot.options.id) {
            // Bot ditambahkan ke grup
            logger.info(`Bot ditambahkan ke grup: ${chatTitle} (${chatId})`);
            const uploadStatus = uploadEnabled ? 'Aktif' : 'Nonaktif';
            await bot.sendMessage(chatId, BOT_CONFIG.groupMessages.botAddedMessage + `\n\n📤 *Fitur Upload:* ${uploadStatus}\n${uploadEnabled ? 'Kirim file apapun untuk diupload ke Catbox.moe!' : 'Fitur upload dinonaktifkan. Admin dapat mengaktifkan dengan /bot'}\n\n📱 *Fitur QR Code:* Aktif\nGunakan /qr [teks/url] untuk membuat QR code!\n\n🔍 *Fitur Sfile Search:* Aktif\nGunakan /sc [query] untuk mencari file di Sfile.mobi!\n\n👤 *Fitur Profil TikTok:* Aktif\nGunakan /profil [username] untuk melihat foto profil TikTok!`);
        } else {
            // Anggota baru bergabung
            const memberName = member.first_name || member.username || "Seseorang";
            const welcomeMessage = formatMessage(BOT_CONFIG.groupMessages.welcomeMessage, {
                name: memberName,
                groupName: chatTitle
            });
            await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
            logger.info(`${memberName} bergabung ke grup: ${chatTitle} (${chatId})`);
        }
    }
});

bot.on("left_chat_member", async (msg) => {
    const chatId = msg.chat.id;
    const leftMember = msg.left_chat_member;
    const chatTitle = msg.chat.title;

    if (leftMember.id === bot.options.id) {
        // Bot dikeluarkan dari grup
        logger.info(`Bot dikeluarkan dari grup: ${chatTitle} (${chatId})`);
    } else {
        // Anggota keluar
        const memberName = leftMember.first_name || leftMember.username || "Seseorang";
        const farewellMessage = formatMessage(BOT_CONFIG.groupMessages.farewellMessage, {
            name: memberName,
            groupName: chatTitle
        });
        await bot.sendMessage(chatId, farewellMessage, { parse_mode: 'Markdown' });
        logger.info(`${memberName} keluar dari grup: ${chatTitle} (${chatId})`);
    }
});

// ======================== MANAJEMEN STATUS AI ========================
const AI_STATUS_FILE = path.join(__dirname, 'ai_status.json');
let aiEnabled = true; // Default AI aktif

function loadAIStatus() {
    if (fs.existsSync(AI_STATUS_FILE)) {
        try {
            const data = fs.readFileSync(AI_STATUS_FILE, 'utf8');
            aiEnabled = JSON.parse(data).aiEnabled;
            logger.info(`Status AI berhasil dimuat: ${aiEnabled ? 'Aktif' : 'Nonaktif'}`);
        } catch (error) {
            logger.error(`Error memuat status AI: ${error.message}`);
        }
    }
}

function saveAIStatus() {
    try {
        fs.writeFileSync(AI_STATUS_FILE, JSON.stringify({ aiEnabled }, null, 2), 'utf8');
        logger.info(`Status AI berhasil disimpan: ${aiEnabled ? 'Aktif' : 'Nonaktif'}`);
    } catch (error) {
        logger.error(`Error menyimpan status AI: ${error.message}`);
    }
}

// Panggil saat inisialisasi
loadAIStatus();

