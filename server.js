const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const session = require('express-session');

const app = express();
const port = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // sert les fichiers statiques (dont index.html)
app.use(session({
    secret: process.env.SESSION_SECRET || 'domotique_secret_change_me',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }  // passer à true si HTTPS
}));

const pool = mysql.createPool({
    host: 'domotique-db.cwf8oio8ys9d.us-east-1.rds.amazonaws.com',
    user: 'admin',
    password: 'admin123456',
    database: 'domotique',
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});
// Test de connexion
pool.getConnection()
    .then(conn => { console.log('✅ Connexion MySQL établie'); conn.release(); })
    .catch(err => { console.error('❌ Erreur de connexion MySQL :', err); process.exit(1); });

// ==================== MIDDLEWARES D'AUTHENTIFICATION ====================

// Pour l'ESP32 (clé API)
async function authenticateApiKey(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ error: 'API key required' });
    const [rows] = await pool.query('SELECT id FROM users WHERE api_key = ?', [apiKey]);
    if (rows.length === 0) return res.status(403).json({ error: 'Invalid API key' });
    req.userId = rows[0].id;
    next();
}

// Pour l'interface web (session)
function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    req.userId = req.session.userId;
    next();
}

// ==================== ROUTES D'AUTHENTIFICATION ====================

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Champs requis' });
    const [rows] = await pool.query('SELECT id, password_hash FROM users WHERE username = ?', [username]);
    if (rows.length === 0) return res.status(401).json({ error: 'Identifiants invalides' });
    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Identifiants invalides' });
    req.session.userId = rows[0].id;
    res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.get('/api/check_auth', (req, res) => {
    res.json({ authenticated: !!req.session.userId });
});

// ==================== ROUTES DE DONNÉES (filtrées par utilisateur) ====================

app.post('/api/consumption', authenticateApiKey, async (req, res) => {
    if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Corps invalide' });
    const { timestamp, elec_kwh, water_m3 } = req.body;
    if (elec_kwh === undefined || water_m3 === undefined) return res.status(400).json({ error: 'Champs manquants' });
    let ts = timestamp || new Date().toISOString().slice(0, 19).replace('T', ' ');
    try {
        const [result] = await pool.query(
            'INSERT INTO consommation (user_id, timestamp, elec_kwh, water_m3) VALUES (?, ?, ?, ?)',
            [req.userId, ts, elec_kwh, water_m3]
        );
        res.status(201).json({ id: result.insertId });
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/consumption', requireAuth, async (req, res) => {
    try {
        const { start, end } = req.query;
        let sql = 'SELECT * FROM consommation WHERE user_id = ? ORDER BY timestamp';
        const params = [req.userId];
        if (start && end) {
            const endWithTime = end + ' 23:59:59';
            sql = 'SELECT * FROM consommation WHERE user_id = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp';
            params.push(start, endWithTime);
        }
        const [rows] = await pool.query(sql, params);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/monthly', requireAuth, async (req, res) => {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'Paramètres year et month requis' });
    const startDate = `${year}-${month}-01`;
    try {
        const [rows] = await pool.query(
            `SELECT SUM(elec_kwh) as total_elec, SUM(water_m3) as total_water
             FROM consommation
             WHERE user_id = ? AND timestamp BETWEEN ? AND LAST_DAY(?) + INTERVAL 1 DAY - INTERVAL 1 SECOND`,
            [req.userId, startDate, startDate]
        );
        const totalElec = parseFloat(rows[0].total_elec) || 0;
        const totalWater = parseFloat(rows[0].total_water) || 0;
        // Tarifs Sénégal (exemple)
        let costElec = 0;
        if (totalElec <= 100) costElec = totalElec * 80;
        else if (totalElec <= 200) costElec = 100*80 + (totalElec-100)*95;
        else if (totalElec <= 500) costElec = 100*80 + 100*95 + (totalElec-200)*110;
        else costElec = 100*80 + 100*95 + 300*110 + (totalElec-500)*125;
        let costWater = 0;
        if (totalWater <= 10) costWater = totalWater * 500;
        else if (totalWater <= 20) costWater = 10*500 + (totalWater-10)*600;
        else costWater = 10*500 + 10*600 + (totalWater-20)*750;
        res.json({
            total_elec_kwh: parseFloat(totalElec.toFixed(3)),
            cost_elec_fcfa: Math.round(costElec),
            total_water_m3: parseFloat(totalWater.toFixed(3)),
            cost_water_fcfa: Math.round(costWater),
            total_fcfa: Math.round(costElec + costWater)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/latest', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM consommation WHERE user_id = ? ORDER BY timestamp DESC LIMIT 1', [req.userId]);
        res.json(rows[0] || {});
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/daily', requireAuth, async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start et end requis' });
    try {
        const endWithTime = end + ' 23:59:59';
        const [rows] = await pool.query(
            `SELECT DATE(timestamp) as date, SUM(elec_kwh) as elec, SUM(water_m3) as water
             FROM consommation
             WHERE user_id = ? AND timestamp BETWEEN ? AND ?
             GROUP BY DATE(timestamp) ORDER BY date`,
            [req.userId, start, endWithTime]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/weekly', requireAuth, async (req, res) => {
    const { year } = req.query;
    if (!year) return res.status(400).json({ error: 'year requis' });
    try {
        const start = `${year}-01-01`, end = `${year}-12-31 23:59:59`;
        const [rows] = await pool.query(
            `SELECT WEEK(timestamp, 3) as week, SUM(elec_kwh) as elec, SUM(water_m3) as water
             FROM consommation
             WHERE user_id = ? AND timestamp BETWEEN ? AND ?
             GROUP BY WEEK(timestamp, 3) ORDER BY week`,
            [req.userId, start, end]
        );
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/monthly_comparison', requireAuth, async (req, res) => {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'year et month requis' });
    const currentStart = `${year}-${month}-01`;
    let prevYear = year;
    let prevMonth = parseInt(month) - 1;
    if (prevMonth === 0) { prevMonth = 12; prevYear = parseInt(year) - 1; }
    const prevStart = `${prevYear}-${String(prevMonth).padStart(2,'0')}-01`;
    try {
        const [current] = await pool.query(
            `SELECT SUM(elec_kwh) as elec, SUM(water_m3) as water
             FROM consommation
             WHERE user_id = ? AND timestamp BETWEEN ? AND LAST_DAY(?) + INTERVAL 1 DAY - INTERVAL 1 SECOND`,
            [req.userId, currentStart, currentStart]
        );
        const [previous] = await pool.query(
            `SELECT SUM(elec_kwh) as elec, SUM(water_m3) as water
             FROM consommation
             WHERE user_id = ? AND timestamp BETWEEN ? AND LAST_DAY(?) + INTERVAL 1 DAY - INTERVAL 1 SECOND`,
            [req.userId, prevStart, prevStart]
        );
        res.json({
            current: { elec: parseFloat(current[0].elec) || 0, water: parseFloat(current[0].water) || 0 },
            previous: { elec: parseFloat(previous[0].elec) || 0, water: parseFloat(previous[0].water) || 0 },
            variation_elec: (parseFloat(current[0].elec) || 0) - (parseFloat(previous[0].elec) || 0),
            variation_water: (parseFloat(current[0].water) || 0) - (parseFloat(previous[0].water) || 0)
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats/average_max', requireAuth, async (req, res) => {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start et end requis' });
    try {
        const endWithTime = end + ' 23:59:59';
        const [rows] = await pool.query(
            `SELECT AVG(elec_kwh) as avg_elec, MAX(elec_kwh) as max_elec,
                    AVG(water_m3) as avg_water, MAX(water_m3) as max_water
             FROM consommation
             WHERE user_id = ? AND timestamp BETWEEN ? AND ?`,
            [req.userId, start, endWithTime]
        );
        res.json({
            avg_elec: parseFloat(rows[0].avg_elec) || 0,
            max_elec: parseFloat(rows[0].max_elec) || 0,
            avg_water: parseFloat(rows[0].avg_water) || 0,
            max_water: parseFloat(rows[0].max_water) || 0
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/thresholds', requireAuth, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT elec_threshold, water_threshold FROM seuils WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.userId]);
        res.json(rows[0] || { elec_threshold: 1000, water_threshold: 10 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/thresholds', requireAuth, async (req, res) => {
    const { elec_threshold, water_threshold } = req.body;
    if (elec_threshold === undefined || water_threshold === undefined) return res.status(400).json({ error: 'Champs manquants' });
    try {
        await pool.query('INSERT INTO seuils (user_id, elec_threshold, water_threshold) VALUES (?, ?, ?)', [req.userId, elec_threshold, water_threshold]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Route par défaut : sert le fichier HTML unique (connexion + tableau de bord)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Lancement du serveur
app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Serveur démarré sur http://0.0.0.0:${port}`);
});