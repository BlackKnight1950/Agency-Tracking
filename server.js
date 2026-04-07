require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const SS_TOKEN = process.env.SMARTSHEET_TOKEN;
const SS_BASE  = 'https://api.smartsheet.com/2.0';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── helper: forward to Smartsheet ── */
async function ssRequest(method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${SS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${SS_BASE}${path}`, opts);
  const data = await res.json();
  return { status: res.status, data };
}

/* ── GET /api/sheet/:id  — fetch sheet rows ── */
app.get('/api/sheet/:id', async (req, res) => {
  if (!SS_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not set on server.' });
  try {
    const pageSize = req.query.pageSize || 50;
    const page     = req.query.page     || 1;
    const { status, data } = await ssRequest(
      'GET',
      `/sheets/${req.params.id}?pageSize=${pageSize}&page=${page}&includeAll=false`
    );
    if (status !== 200) return res.status(status).json({ error: data.message || 'Smartsheet error', detail: data });

    /* normalise rows into plain objects keyed by column title */
    const colMap = {};
    (data.columns || []).forEach(c => { colMap[c.id] = c.title; });

    const rows = (data.rows || []).map(r => {
      const obj = { _rowId: r.id };
      (r.cells || []).forEach(cell => {
        const title = colMap[cell.columnId];
        if (title) obj[title] = cell.displayValue ?? cell.value ?? '';
      });
      return obj;
    });

    res.json({
      sheetName:  data.name,
      totalRows:  data.totalRowCount,
      columns:    (data.columns || []).map(c => c.title),
      columnMeta: data.columns || [],
      rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── POST /api/sheet/:id/rows  — add a new row ── */
app.post('/api/sheet/:id/rows', async (req, res) => {
  if (!SS_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not set on server.' });
  try {
    /* First fetch columns to get IDs */
    const { status: cs, data: cd } = await ssRequest('GET', `/sheets/${req.params.id}?pageSize=1`);
    if (cs !== 200) return res.status(cs).json({ error: cd.message || 'Could not fetch columns' });

    const colTitleToId = {};
    (cd.columns || []).forEach(c => { colTitleToId[c.title] = c.id; });

    /* Build cells from request body  e.g. { "Agency Staff Name": "Jane Doe", ... } */
    const cells = Object.entries(req.body).map(([title, value]) => {
      const columnId = colTitleToId[title];
      if (!columnId) return null;
      return { columnId, value: String(value) };
    }).filter(Boolean);

    if (!cells.length) return res.status(400).json({ error: 'No matching columns found. Check Sheet ID and column names.' });

    const { status, data } = await ssRequest('POST', `/sheets/${req.params.id}/rows`, {
      toBottom: true,
      cells,
    });

    if (status !== 200) return res.status(status).json({ error: data.message || 'Failed to add row', detail: data });
    res.json({ success: true, rowId: data.result?.[0]?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── GET /api/health ── */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, tokenSet: !!SS_TOKEN, ts: new Date().toISOString() });
});

/* ── fallback: serve index.html ── */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`CCH Agency Staff Tracking running on port ${PORT}`));
