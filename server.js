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

// All 16 department reports — IDs hard-coded from Smartsheet
const REPORT_IDS = {
  achn:         '144361036664708',
  ancillary:    '5196665016242052',
  bh:           '145993124237188',
  clinical:     '849285429022596',
  correctional: '8240443109101444',
  countycare:   '4141245522726788',
  finance:      '2730597874093956',
  his:          '3961386519449476',
  hr:           '7713459211816836',
  patient_exp:  '5478208712429444',
  provider:     '4134330625380228',
  pub_health:   '4018833854517124',
  quality:      '7287020498931588',
  scm:          '4863842900201348',
  support:      '1463565341904772',
  unlicensed:   '7654099274125188',
};

async function ssRequest(method, endpoint, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${SS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${SS_BASE}${endpoint}`, opts);
  const data = await res.json();
  return { status: res.status, data };
}

// GET /api/health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, tokenSet: !!SS_TOKEN, ts: new Date().toISOString() });
});

// GET /api/reports — return the hardcoded report ID map so the frontend can use it
app.get('/api/reports', (_req, res) => {
  res.json(REPORT_IDS);
});

// GET /api/report/:deptId — fetch rows from that dept's Smartsheet report
app.get('/api/report/:deptId', async (req, res) => {
  if (!SS_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured on server.' });
  const reportId = REPORT_IDS[req.params.deptId];
  if (!reportId) return res.status(404).json({ error: `No report configured for department: ${req.params.deptId}` });

  const page     = parseInt(req.query.page)     || 1;
  const pageSize = parseInt(req.query.pageSize) || 25;

  try {
    const { status, data } = await ssRequest(
      'GET',
      `/reports/${reportId}?pageSize=${pageSize}&page=${page}`
    );
    if (status !== 200) return res.status(status).json({ error: data.message || 'Smartsheet error', detail: data });

    const colMap = {};
    (data.columns || []).forEach(c => { colMap[c.id] = c.title; });

    const rows = (data.rows || []).map(r => {
      const obj = { _rowId: r.id, _sheetId: r.sheetId };
      (r.cells || []).forEach(cell => {
        const title = colMap[cell.columnId] || cell.columnId;
        obj[title] = cell.displayValue ?? cell.value ?? '';
      });
      return obj;
    });

    res.json({
      reportName: data.name,
      totalRows:  data.totalRowCount || rows.length,
      columns:    (data.columns || []).map(c => c.title),
      rows,
      page,
      pageSize,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/report/:deptId/rows — add a new row to the SOURCE sheet behind the report
// We first peek at the report to discover the source sheetId, then POST to that sheet
app.post('/api/report/:deptId/rows', async (req, res) => {
  if (!SS_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not configured on server.' });
  const reportId = REPORT_IDS[req.params.deptId];
  if (!reportId) return res.status(404).json({ error: `No report for dept: ${req.params.deptId}` });

  try {
    // 1. Pull one row from the report to discover source sheet ID and column IDs
    const { status: rs, data: rd } = await ssRequest('GET', `/reports/${reportId}?pageSize=1`);
    if (rs !== 200) return res.status(rs).json({ error: rd.message || 'Could not load report' });

    // Get column map from report columns
    const colTitleToId = {};
    (rd.columns || []).forEach(c => { colTitleToId[c.title] = c.id; });

    // Get the source sheet ID from the report's sourceSheets or from first row
    let sourceSheetId = null;
    if (rd.sourceSheets && rd.sourceSheets.length > 0) {
      sourceSheetId = rd.sourceSheets[0].id;
    } else if (rd.rows && rd.rows.length > 0) {
      sourceSheetId = rd.rows[0].sheetId;
    }

    if (!sourceSheetId) {
      // Fallback: try to get sheet columns directly from report column metadata
      // Use the report ID itself to add a row (some Smartsheet plans support this)
      return res.status(400).json({
        error: 'Could not determine source sheet. The report may be empty — please ensure it has at least one existing row, or provide the Sheet ID directly.',
      });
    }

    // 2. Fetch the actual source sheet columns to get correct column IDs
    const { status: cs, data: cd } = await ssRequest('GET', `/sheets/${sourceSheetId}?pageSize=1`);
    if (cs !== 200) return res.status(cs).json({ error: cd.message || 'Could not fetch source sheet columns' });

    const sheetColMap = {};
    (cd.columns || []).forEach(c => { sheetColMap[c.title] = c.id; });

    // 3. Build cells
    const cells = Object.entries(req.body)
      .map(([title, value]) => {
        const columnId = sheetColMap[title];
        if (!columnId) return null;
        return { columnId, value: String(value) };
      })
      .filter(Boolean);

    if (!cells.length) {
      return res.status(400).json({ error: 'No matching columns found. Check that column names match exactly.' });
    }

    // 4. Add row to source sheet
    const { status: addStatus, data: addData } = await ssRequest(
      'POST',
      `/sheets/${sourceSheetId}/rows`,
      { toBottom: true, cells }
    );

    if (addStatus !== 200) {
      return res.status(addStatus).json({ error: addData.message || 'Failed to add row', detail: addData });
    }

    res.json({ success: true, rowId: addData.result?.[0]?.id, sheetId: sourceSheetId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`CCH Agency Staff Tracking running on port ${PORT}`));
