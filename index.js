require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const initSqlJs = require('sql.js');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// ── Database setup (sql.js) ──
let db;
const DB_FILE = './linkvora.db';

async function openDatabase() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS backlinks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      status TEXT DEFAULT 'Pending',
      anchor TEXT,
      type TEXT,
      placement TEXT,
      rel REAL DEFAULT 0,
      bloat INTEGER DEFAULT 0,
      hops INTEGER DEFAULT 0,
      age INTEGER DEFAULT 0,
      target_ok INTEGER DEFAULT 1,
      schema_ok INTEGER DEFAULT 0,
      source TEXT DEFAULT 'Manual',
      seen TEXT,
      context TEXT,
      neighbors TEXT,
      domain TEXT
    )
  `);
  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS oauth_tokens (provider TEXT PRIMARY KEY, access_token TEXT, refresh_token TEXT, expires_at INTEGER)`);
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
  }
}

// Auto-save every 60 seconds
setInterval(saveDatabase, 60_000);

// ── Helper ──
function getRootDomain(url) {
  try {
    const hostname = new URL(url.startsWith('http') ? url : `https://${url}`).hostname;
    const parts = hostname.split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : hostname;
  } catch { return url.split('/')[0]; }
}

// ── Lightweight verification (no Puppeteer) ──
async function verifyBacklink(targetDomain, sourceUrl) {
  const fullUrl = sourceUrl.startsWith('http') ? sourceUrl : `https://${sourceUrl}`;
  try {
    const response = await axios.get(fullUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      maxRedirects: 2
    });
    const html = response.data;
    const $ = cheerio.load(html);
    const links = $('a[href]').filter((i, el) => {
      const href = $(el).attr('href');
      return href && href.includes(targetDomain);
    });
    const anchor = links.first().text().trim() || '—';
    const relAttr = (links.first().attr('rel') || '').toLowerCase();
    const type = relAttr.includes('nofollow') ? 'Nofollow' :
                 relAttr.includes('sponsored') ? 'Sponsored' :
                 relAttr.includes('ugc') ? 'UGC' : 'Dofollow';
    const placement = links.first().parent().text().length > 200 ? 'Body Content' : 'Navigation';
    const bloat = $('a[href]').length;
    const schemaOk = $('script[type="application/ld+json"]').length > 0;
    const context = $('p').first().text().slice(0, 200);
    return {
      status: 'Active',
      anchor,
      type,
      placement,
      rel: parseFloat((Math.random() * 0.6 + 0.1).toFixed(2)), // temporary random; will be replaced by real TF-IDF later
      bloat,
      hops: response.request._redirectCount || 0,
      age: 0,
      target_ok: 1,
      schema_ok: schemaOk ? 1 : 0,
      context
    };
  } catch (error) {
    return {
      status: 'Error',
      anchor: '—',
      type: 'Dofollow',
      placement: 'Unknown',
      rel: 0,
      bloat: 0,
      hops: 0,
      age: 0,
      target_ok: 0,
      schema_ok: 0,
      context: ''
    };
  }
}

// ── API Routes ──
app.get('/api/backlinks', (req, res) => {
  const rows = db.exec('SELECT * FROM backlinks');
  if (rows.length === 0) return res.json([]);
  const columns = rows[0].columns;
  const data = rows[0].values.map(row => {
    const obj = {};
    row.forEach((val, idx) => {
      obj[columns[idx]] = val;
    });
    // Parse neighbors if exists
    obj.neighbors = JSON.parse(obj.neighbors || '[]');
    obj.target_ok = !!obj.target_ok;
    obj.schema_ok = !!obj.schema_ok;
    return obj;
  });
  res.json(data);
});

app.post('/api/backlinks', (req, res) => {
  const { urls, targetDomain } = req.body;
  if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'Invalid urls' });
  const now = new Date().toISOString().split('T')[0];
  const domain = getRootDomain(targetDomain || '');
  const stmt = db.prepare('INSERT INTO backlinks (url, domain, seen, source, status) VALUES (?, ?, ?, ?, ?)');
  urls.forEach(url => {
    const cleanUrl = url.replace(/^https?:\/\//, '');
    stmt.run([cleanUrl, domain, now, 'Manual', 'Pending']);
  });
  stmt.free();
  saveDatabase();
  res.json({ success: true, count: urls.length });
});

app.post('/api/verify', async (req, res) => {
  const { urls, targetDomain } = req.body;
  if (!urls || !targetDomain) return res.status(400).json({ error: 'Missing urls or targetDomain' });
  const results = [];
  const updateStmt = db.prepare(`
    UPDATE backlinks SET 
      status = ?, anchor = ?, type = ?, placement = ?, rel = ?, bloat = ?, hops = ?, target_ok = ?, schema_ok = ?, context = ?
    WHERE url = ?
  `);
  for (const url of urls) {
    const cleanUrl = url.replace(/^https?:\/\//, '');
    const result = await verifyBacklink(targetDomain, url);
    updateStmt.run([
      result.status, result.anchor, result.type, result.placement,
      result.rel, result.bloat, result.hops,
      result.target_ok ? 1 : 0, result.schema_ok ? 1 : 0,
      result.context, cleanUrl
    ]);
    results.push(result);
  }
  updateStmt.free();
  saveDatabase();
  res.json({ success: true, verified: results.length });
});

app.post('/api/oauth/:provider', (req, res) => {
  const { provider } = req.params;
  db.run('INSERT OR REPLACE INTO oauth_tokens (provider, access_token, refresh_token, expires_at) VALUES (?, ?, ?, ?)',
    [provider, 'mock_token', 'mock_refresh', Date.now() + 3600000]);
  // Simulate discovery
  setTimeout(() => {
    const now = new Date().toISOString().split('T')[0];
    const insertStmt = db.prepare(`
      INSERT INTO backlinks (url, status, anchor, type, placement, rel, bloat, hops, age, target_ok, schema_ok, source, seen, context, neighbors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < 4; i++) {
      insertStmt.run([
        `${provider}-discovery-${Date.now()}-${i}.com/page`,
        'Active', 'Discovered link', 'Dofollow', 'Body Content',
        0.5, 12, 0, 120, 1, 0,
        provider === 'gsc' ? 'GSC' : 'Bing', now, '', '[]'
      ]);
    }
    insertStmt.free();
    saveDatabase();
  }, 2000);
  res.json({ message: `${provider} OAuth initiated, discovery will add links shortly` });
});

app.get('/api/settings', (req, res) => {
  const rows = db.exec('SELECT * FROM settings');
  const settings = {};
  if (rows.length > 0) {
    const cols = rows[0].columns;
    const vals = rows[0].values;
    vals.forEach(row => {
      settings[row[0]] = row[1];
    });
  }
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
  saveDatabase();
  res.json({ success: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', db: !!db }));

// ── Start server ──
const PORT = process.env.PORT || 3000;
openDatabase().then(() => {
  app.listen(PORT, () => console.log(`Linkvora backend running on port ${PORT}`));
});

// ── Nightly background job (no-op for now) ──
cron.schedule('0 2 * * *', () => {
  console.log('Nightly discovery tick');
});
