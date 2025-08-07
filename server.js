const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const Minio = require('minio');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// -- KONFIGURACJA MINIO (zewnętrzny kontener) --
const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || 'minio',
    port: parseInt(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'media-uploads';

// Inicjalizacja bucketa z retry logic
async function initMinioBucket() {
    let retries = 5;
    while (retries > 0) {
        try {
            console.log('Sprawdzam połączenie z MinIO...');
            const exists = await minioClient.bucketExists(BUCKET_NAME);
            if (!exists) {
                await minioClient.makeBucket(BUCKET_NAME, 'us-east-1');
                console.log(`✅ Bucket ${BUCKET_NAME} created successfully`);
            } else {
                console.log(`✅ Bucket ${BUCKET_NAME} already exists`);
            }
            return;
        } catch (error) {
            retries--;
            console.error(`❌ MinIO connection failed (${5-retries}/5):`, error.message);
            if (retries > 0) {
                console.log('Ponawiam za 3 sekundy...');
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                console.error('⚠️ Nie udało się połączyć z MinIO po 5 próbach');
                process.exit(1);
            }
        }
    }
}

// -- KONFIGURACJA BASIC AUTH --
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'password';

function adminAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
        return res.status(401).send('Authentication required.');
    }
    
    const [scheme, encoded] = auth.split(' ');
    if (scheme !== 'Basic') return res.status(400).send('Bad request');
    
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
    
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    res.status(401).send('Authentication required.');
}

// -- Inicjalizacja bazy SQLite --
const dbPath = process.env.NODE_ENV === 'production' ? '/app/data/db.sqlite' : './db.sqlite';
const db = new sqlite3.Database(dbPath, err => {
    if (err) { 
        console.error('❌ Database error:', err); 
        process.exit(1); 
    }
    console.log('✅ Database connected');
    db.run(`
        CREATE TABLE IF NOT EXISTS guests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            message TEXT,
            mediaUrl TEXT NOT NULL,
            filename TEXT NOT NULL,
            fileSize INTEGER,
            mimeType TEXT,
            timestamp INTEGER NOT NULL
        )
    `);
});

// -- Multer konfiguracja dla pamięci --
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|webm|ogg/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Nieprawidłowy typ pliku. Dozwolone: JPEG, PNG, GIF, MP4, WebM, OGG'));
        }
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/', express.static(path.join(__dirname, 'public')));

// -- Middleware sprawdzający połączenie MinIO --
let minioHealthy = false;
setInterval(async () => {
    try {
        await minioClient.listBuckets();
        minioHealthy = true;
    } catch (error) {
        minioHealthy = false;
    }
}, 30000);

// -- Endpoint do uploadu z MinIO --
app.post('/api/upload', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        if (!minioHealthy) {
            return res.status(503).json({ error: 'MinIO service unavailable' });
        }

        const { name, message } = req.body;
        const timestamp = Date.now();
        const fileExtension = path.extname(req.file.originalname);
        const filename = `${timestamp}-${Buffer.from(req.file.originalname).toString('base64').slice(0, 20)}${fileExtension}`;
        
        console.log(`📤 Uploading file: ${filename} (${req.file.size} bytes)`);
        
        // Upload do MinIO
        await minioClient.putObject(
            BUCKET_NAME, 
            filename, 
            req.file.buffer,
            req.file.size,
            {
                'Content-Type': req.file.mimetype,
                'Original-Name': req.file.originalname,
                'Upload-Date': new Date().toISOString()
            }
        );

        // Generuj URL do pliku
        const mediaUrl = `/api/media/${filename}`;

        // Zapisz do bazy danych
        db.run(
            `INSERT INTO guests (name, message, mediaUrl, filename, fileSize, mimeType, timestamp) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name, message || '', mediaUrl, filename, req.file.size, req.file.mimetype, timestamp],
            function(err) {
                if (err) {
                    console.error('❌ Database error:', err);
                    return res.status(500).json({ error: 'Database error' });
                }
                console.log(`✅ Entry saved: ${name} - ${filename}`);
                res.json({ 
                    success: true, 
                    id: this.lastID,
                    mediaUrl: mediaUrl
                });
            }
        );

    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
});

// -- Endpoint do pobierania plików z MinIO --
app.get('/api/media/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        console.log(`📥 Fetching file: ${filename}`);
        
        const dataStream = await minioClient.getObject(BUCKET_NAME, filename);
        
        // Pobierz metadata
        const stat = await minioClient.statObject(BUCKET_NAME, filename);
        res.setHeader('Content-Type', stat.metaData['content-type'] || 'application/octet-stream');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'public, max-age=86400'); // 24h cache
        
        dataStream.pipe(res);
    } catch (error) {
        console.error('❌ Media fetch error:', error);
        res.status(404).json({ error: 'Media not found' });
    }
});

// -- PUBLICZNE API dla galerii --
app.get('/api/guests', (req, res) => {
    db.all(
        `SELECT mediaUrl, timestamp FROM guests ORDER BY timestamp DESC LIMIT 50`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error' });
            res.json(rows.map(r => r.mediaUrl));
        }
    );
});

// -- ZABEZPIECZONE API dla pełnych wpisów --
app.get('/api/entries', adminAuth, (req, res) => {
    db.all(
        `SELECT id, name, message, mediaUrl, filename, fileSize, mimeType, timestamp FROM guests ORDER BY timestamp DESC`,
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB error' });
            res.json(rows);
        }
    );
});

// -- STATUS CHECK ENDPOINT --
app.get('/api/status', adminAuth, async (req, res) => {
    const status = {
        timestamp: new Date().toISOString(),
        database: false,
        minio: false,
        bucket: false,
        minioEndpoint: `${minioClient.host}:${minioClient.port}`,
        bucketName: BUCKET_NAME,
        errors: []
    };

    // Test bazy danych
    try {
        await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM guests', (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        status.database = true;
    } catch (error) {
        status.errors.push(`Database: ${error.message}`);
    }

    // Test MinIO connection
    try {
        await minioClient.listBuckets();
        status.minio = true;
    } catch (error) {
        status.errors.push(`MinIO: ${error.message}`);
    }

    // Test bucket
    try {
        const exists = await minioClient.bucketExists(BUCKET_NAME);
        status.bucket = exists;
        if (!exists) {
            status.errors.push(`Bucket ${BUCKET_NAME} does not exist`);
        }
    } catch (error) {
        status.errors.push(`Bucket check: ${error.message}`);
    }

    res.json(status);
});

// -- STATYSTYKI ENDPOINT --
app.get('/api/statistics', adminAuth, (req, res) => {
    const queries = [
        'SELECT COUNT(*) as totalEntries FROM guests',
        'SELECT COUNT(*) as todayEntries FROM guests WHERE timestamp > ?',
        'SELECT SUM(fileSize) as totalStorage FROM guests',
        'SELECT COUNT(DISTINCT name) as uniqueUsers FROM guests',
        'SELECT mimeType, COUNT(*) as count FROM guests GROUP BY mimeType'
    ];
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    Promise.all([
        new Promise((resolve, reject) => {
            db.get(queries[0], (err, row) => err ? reject(err) : resolve(row));
        }),
        new Promise((resolve, reject) => {
            db.get(queries[1], [todayStart.getTime()], (err, row) => err ? reject(err) : resolve(row));
        }),
        new Promise((resolve, reject) => {
            db.get(queries[2], (err, row) => err ? reject(err) : resolve(row));
        }),
        new Promise((resolve, reject) => {
            db.get(queries[3], (err, row) => err ? reject(err) : resolve(row));
        }),
        new Promise((resolve, reject) => {
            db.all(queries[4], (err, rows) => err ? reject(err) : resolve(rows));
        })
    ]).then(results => {
        res.json({
            totalEntries: results[0].totalEntries || 0,
            todayEntries: results[1].todayEntries || 0,
            totalStorage: results[2].totalStorage || 0,
            uniqueUsers: results[3].uniqueUsers || 0,
            fileTypes: results[4] || [],
            timestamp: new Date().toISOString()
        });
    }).catch(error => {
        console.error('❌ Statistics error:', error);
        res.status(500).json({ error: 'Statistics error' });
    });
});

// -- Endpoint do usuwania wpisu --
app.delete('/api/entries/:id', adminAuth, async (req, res) => {
    const id = req.params.id;
    
    try {
        // Pobierz informacje o pliku przed usunięciem
        const entry = await new Promise((resolve, reject) => {
            db.get('SELECT filename FROM guests WHERE id = ?', [id], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (!entry) {
            return res.status(404).json({ error: 'Entry not found' });
        }

        // Usuń plik z MinIO
        await minioClient.removeObject(BUCKET_NAME, entry.filename);
        console.log(`🗑️ Deleted file: ${entry.filename}`);

        // Usuń wpis z bazy danych
        await new Promise((resolve, reject) => {
            db.run('DELETE FROM guests WHERE id = ?', [id], function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Delete error:', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// -- Health check endpoint --
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        minio: minioHealthy 
    });
});

// -- Serwowanie admin.html --
app.get('/admin', adminAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    db.close();
    process.exit(0);
});

// Inicjalizacja i start serwera
initMinioBucket().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Serwer działa na http://0.0.0.0:${PORT}`);
        console.log(`📦 MinIO endpoint: ${minioClient.host}:${minioClient.port}`);
        console.log(`🪣 Bucket: ${BUCKET_NAME}`);
        console.log(`👤 Admin panel: http://localhost:${PORT}/admin`);
    });
}).catch(error => {
    console.error('❌ Initialization failed:', error);
    process.exit(1);
});
