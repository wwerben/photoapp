// na górze pliku
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

// -- KONFIGURACJA BASIC AUTH dla strony admin -- 
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

// -- Inicjalizacja bazy SQLite (jak wcześniej) --
const db = new sqlite3.Database(path.join(__dirname, 'db.sqlite'), err => {
  if (err) { console.error(err); process.exit(1); }
  db.run(`
    CREATE TABLE IF NOT EXISTS guests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      message TEXT,
      mediaUrl TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
});

// -- Multer i statyczne jak wcześniej --
const storage = multer.diskStorage({ /* ... */ });
const upload  = multer({ /* ... */ });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// -- Endpoint do uploadu (bez zmian) --
app.post('/api/upload', upload.single('media'), (req, res) => {
  /* zapis do DB jak wcześniej */
});

// -- PUBLICZNE API dla galerii: tylko URL-e mediów --
app.get('/api/guests', (req, res) => {
  db.all(
    `SELECT mediaUrl FROM guests ORDER BY timestamp DESC`,
    [], (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json(rows.map(r => r.mediaUrl));
    }
  );
});

// -- ZABEZPIECZONE API dla pełnych wpisów --
app.get('/api/entries', adminAuth, (req, res) => {
  db.all(
    `SELECT name, message, mediaUrl, timestamp FROM guests ORDER BY timestamp DESC`,
    [], (err, rows) => {
      if (err) return res.status(500).json({ error: 'DB error' });
      res.json(rows);
    }
  );
});

// -- Serwowanie admin.html pod /admin --
app.get('/admin', adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serwer działa na http://0.0.0.0:${PORT}`);
});
