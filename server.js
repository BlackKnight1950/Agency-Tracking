require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const SS_TOKEN = process.env.SMARTSHEET_TOKEN;
const SS_BASE  = 'https://api.smartsheet.com/2.0';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// All 16 department report IDs — Reports (Approved Request) folder
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

// Editable columns — users can update these cells inline in the table
// Maps column title -> source sheet column ID (from Post-Approval Task sheet)
const EDITABLE_COLS = {
  'Agency Staff Name':      '8242762721480580',
  'Vendor (Agency Company)':'8605331287134084',
  'Badge #':                '7940057361764228',
  'CCH Start Date':         '924413327003524',
  'CCH End Date':           '5428012954374020',
  "Manager's Comment":      '2868040647266180',
};

// The 11 display columns in order
const DISPLAY_COLS = [
  'Request ID',
  'Requestor Name:',
  'Job Position/Title',
  'Job Code:',
  'Work Location',
  'Agency Staff Name',
  'Vendor (Agency Company)',
  'Badge #',
  'CCH Start Date',
  'CCH End Date',
  "Manager's Comment",
];

async function ssReq(method, endpoint, body) {
  const opts = {
    method,
    headers: { Authorization: `Bearer ${SS_TOKEN}`, 'Content-Type': 'application/json' },
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

// GET /api/report/:deptId — fetch paginated rows
// Uses virtual_column_id for correct cell mapping in reports
app.get('/api/report/:deptId', async (req, res) => {
  if (!SS_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not set.' });
  const reportId = REPORT_IDS[req.params.deptId];
  if (!reportId) return res.status(404).json({ error: `No report for: ${req.params.deptId}` });

  const page     = parseInt(req.query.page)     || 1;
  const pageSize = parseInt(req.query.pageSize) || 25;

  try {
    const { status, data } = await ssReq('GET', `/reports/${reportId}?pageSize=${pageSize}&page=${page}`);
    if (status !== 200) return res.status(status).json({ error: data.message || 'Smartsheet error' });

    // Build virtual_id -> column title map
    const vidToTitle = {};
    (data.columns || []).forEach(col => {
      const vid = String(col.virtual_id ?? col.virtualId ?? '');
      if (vid && col.title) vidToTitle[vid] = col.title;
    });

    const rows = (data.rows || []).map(row => {
      const obj = { _rowId: row.id, _sheetId: row.sheetId || row.sheet_id };
      (row.cells || []).forEach(cell => {
        const vid   = String(cell.virtual_column_id ?? cell.virtualColumnId ?? '');
        const title = vidToTitle[vid];
        if (title) obj[title] = cell.display_value ?? cell.displayValue ?? cell.value ?? '';
      });
      return obj;
    });

    res.json({
      reportName:   data.name,
      totalRows:    data.total_row_count ?? data.totalRowCount ?? rows.length,
      displayCols:  DISPLAY_COLS,
      editableCols: Object.keys(EDITABLE_COLS),
      rows,
      page,
      pageSize,
    });
  } catch (e) {
    console.error('GET /api/report error:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/row/:sheetId/:rowId — update specific cells on an existing row
app.patch('/api/row/:sheetId/:rowId', async (req, res) => {
  if (!SS_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not set.' });

  const { sheetId, rowId } = req.params;
  const updates = req.body; // { "Agency Staff Name": "Jane Doe", "Badge #": "12345", ... }

  try {
    const cells = Object.entries(updates)
      .map(([title, value]) => {
        const columnId = EDITABLE_COLS[title];
        if (!columnId) return null;
        return { columnId: parseInt(columnId), value: value === '' ? null : String(value) };
      })
      .filter(Boolean);

    if (!cells.length) {
      return res.status(400).json({ error: 'No editable columns matched. Received: ' + Object.keys(updates).join(', ') });
    }

    const { status, data } = await ssReq('PUT', `/sheets/${sheetId}/rows`, [{
      id: parseInt(rowId),
      cells,
    }]);

    if (status !== 200) return res.status(status).json({ error: data.message || 'Update failed', detail: data });
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /api/row error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`CCH Agency Staff Tracking on port ${PORT}`));
