require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const axios       = require('axios');
const path        = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
const SMARTSHEET_TOKEN = process.env.SMARTSHEET_TOKEN;
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN || '*';

if (!SMARTSHEET_TOKEN) {
  console.error('ERROR: SMARTSHEET_TOKEN environment variable is not set.');
  process.exit(1);
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));  // CSP handled in HTML meta
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

// Rate limit: 60 requests per minute per IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' }
}));

// Serve the frontend
app.use(express.static(path.join(__dirname, 'public')));

// ── Smartsheet helpers ─────────────────────────────────────────────────────────
const SS = axios.create({
  baseURL: 'https://api.smartsheet.com/2.0',
  headers: {
    Authorization: `Bearer ${SMARTSHEET_TOKEN}`,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/report/:reportId
 * Fetch a Smartsheet report and return structured JSON rows.
 */
app.get('/api/report/:reportId', async (req, res) => {
  try {
    const { reportId } = req.params;
    const page     = parseInt(req.query.page     || '1',   10);
    const pageSize = parseInt(req.query.pageSize || '500', 10);

    const response = await SS.get(`/reports/${reportId}`, {
      params: { page, pageSize, include: 'sourceSheets' }
    });

    const report  = response.data;
    const columns = report.columns || [];

    // Build virtual-id → title map
    const colMap = {};
    columns.forEach(col => {
      colMap[col.virtualId] = col.title;
      colMap[col.id]        = col.title;
    });

    // Normalize rows
    const rows = (report.rows || []).map(row => {
      const cells = {};
      const colIds = {};
      (row.cells || []).forEach(cell => {
        const title = colMap[cell.virtualColumnId] || colMap[cell.columnId] || String(cell.columnId);
        if (cell.displayValue != null) cells[title]  = cell.displayValue;
        else if (cell.value   != null) cells[title]  = String(cell.value);
        colIds[title] = cell.columnId;
      });
      return {
        rowId:     String(row.id),
        sheetId:   String(row.sheetId),
        createdAt: row.createdAt,
        cells,
        colIds
      };
    });

    res.json({
      reportId:  String(report.id),
      name:      report.name,
      totalRows: report.totalRowCount,
      page,
      pageSize,
      rows
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data   || err.message;
    console.error('GET /api/report error:', detail);
    res.status(status).json({ error: 'Failed to fetch report', detail });
  }
});

/**
 * GET /api/sheet-view/:sheetId
 * Fetch a Smartsheet sheet directly and return normalized rows.
 * Used for the Post-Approval Live View tab (editable fields).
 */
app.get('/api/sheet-view/:sheetId', async (req, res) => {
  try {
    const { sheetId } = req.params;
    const pageSize = parseInt(req.query.pageSize || '500', 10);

    const response = await SS.get(`/sheets/${sheetId}`, {
      params: { pageSize, include: 'rowPermalink' }
    });

    const sheet   = response.data;
    const columns = sheet.columns || [];

    // Build column id → title map
    const colMap = {};
    columns.forEach(col => { colMap[col.id] = col.title; });

    // Normalize rows — same shape as /api/report
    const rows = (sheet.rows || []).map(row => {
      const cells  = {};
      const colIds = {};
      (row.cells || []).forEach(cell => {
        const title = colMap[cell.columnId] || String(cell.columnId);
        if (cell.displayValue != null) cells[title]  = cell.displayValue;
        else if (cell.value   != null) cells[title]  = String(cell.value);
        colIds[title] = cell.columnId;
      });
      return {
        rowId:     String(row.id),
        sheetId:   String(sheet.id),
        createdAt: row.createdAt,
        cells,
        colIds
      };
    });

    res.json({
      sheetId:  String(sheet.id),
      name:     sheet.name,
      totalRows: sheet.totalRowCount,
      pageSize,
      rows
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data   || err.message;
    console.error('GET /api/sheet-view error:', detail);
    res.status(status).json({ error: 'Failed to fetch sheet', detail });
  }
});


/**
 * PATCH /api/sheet/:sheetId/row/:rowId
 * Update specific cells on a row.
 * Body: { cells: [ { columnId, value }, ... ] }
 */
app.patch('/api/sheet/:sheetId/row/:rowId', async (req, res) => {
  try {
    const { sheetId, rowId } = req.params;
    const { cells }          = req.body;

    if (!Array.isArray(cells) || cells.length === 0) {
      return res.status(400).json({ error: 'cells array is required' });
    }

    // Validate each cell has columnId + value
    for (const cell of cells) {
      if (!cell.columnId) {
        return res.status(400).json({ error: 'Each cell must include columnId' });
      }
    }

    const payload = [{ id: parseInt(rowId, 10), cells }];
    const response = await SS.put(`/sheets/${sheetId}/rows`, payload);

    res.json({ success: true, updated: response.data });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data   || err.message;
    console.error('PATCH /api/sheet row error:', detail);
    res.status(status).json({ error: 'Failed to update row', detail });
  }
});

/**
 * GET /api/health
 * Simple health check for Render.
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Catch-all: serve the SPA
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ARC Review App running on http://localhost:${PORT}`);
});
