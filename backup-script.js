import fs from 'fs';
import path from 'path';
import moment from 'moment';
import archiver from 'archiver';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Konfigurasi backup
const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_RETENTION_DAYS = 7;
// File yang akan dibackup
const FILES_TO_BACKUP = [
    'otak.json',
    'user_cache.json',
    'config.js'
];
// Buat direktori backup jika belum ada
if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Fungsi untuk membersihkan backup lama
function cleanOldBackups() {
    const files = fs.readdirSync(BACKUP_DIR);
    const now = moment();
    files.forEach(file => {
        const filePath = path.join(BACKUP_DIR, file);
        const stat = fs.statSync(filePath);
        const fileAge = moment.duration(now.diff(moment(stat.mtime))).asDays();
        
        if (fileAge > BACKUP_RETENTION_DAYS) {
            fs.unlinkSync(filePath);
            console.log(`🧹 Menghapus backup lama: ${file}`);
        }
    });
}
// Fungsi untuk membuat backup
async function createBackup() {
    const timestamp = moment().format('YYYYMMDD_HHmmss');
    const backupFileName = `backup_${timestamp}.zip`;
    const backupPath = path.join(BACKUP_DIR, backupFileName);
    
    const output = fs.createWriteStream(backupPath);
    const archive = archiver('zip', {
        zlib: { level: 9 } // Kompresi maksimal
    });
    return new Promise((resolve, reject) => {
        output.on('close', () => {
            console.log(`✅ Backup berhasil dibuat: ${backupFileName}`);
            console.log(`📁 Ukuran: ${archive.pointer()} bytes`);
            resolve();
        });    
        archive.on('warning', (err) => {
            if (err.code === 'ENOENT') {
                console.warn('⚠️ Peringatan backup:', err);
            } else {
                reject(err);
            }
        });     
        archive.on('error', (err) => {
            reject(err);
        });      
        archive.pipe(output);      
        // Tambahkan file ke backup
        FILES_TO_BACKUP.forEach(file => {
            const filePath = path.join(__dirname, file);
            if (fs.existsSync(filePath)) {
                archive.file(filePath, { name: file });
            }
        });    
        // Tambahkan direktori logs
        archive.directory(path.join(__dirname, 'logs'), 'logs');
        
        archive.finalize();
    });
}
// Jalankan proses backup
(async () => {
    try {
        console.log('🔄 Memulai proses backup...');
        await createBackup();
        cleanOldBackups();
        console.log('✨ Proses backup selesai');
    } catch (error) {
        console.error('❌ Error saat backup:', error);
        process.exit(1);
    }
})();