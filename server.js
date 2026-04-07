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

// Exact column titles in source sheet used for new-row submissions
const SUBMIT_COLS = {
  staffName:  'Agency Staff Name',
  vendor:     'Vendor (Agency Company)',
  badge:      'Badge #',
  startDate:  'CCH Start Date',
  endDate:    'CCH End Date',
};

// The 11 columns to display in the table, in order (exact Smartsheet titles)
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
  'Manager\'s Comment',
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, tokenSet: !!SS_TOKEN, ts: new Date().toISOString() });
});

// GET /api/report/:deptId — fetch paginated rows
// KEY: Smartsheet reports use virtual_column_id for cell mapping, not column_id
app.get('/api/report/:deptId', async (req, res) => {
  if (!SS_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not set on server.' });
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
      reportName:  data.name,
      totalRows:   data.total_row_count ?? data.totalRowCount ?? rows.length,
      displayCols: DISPLAY_COLS,
      rows,
      page,
      pageSize,
    });
  } catch (e) {
    console.error('GET /api/report error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/report/:deptId/rows — add a row to the source sheet
app.post('/api/report/:deptId/rows', async (req, res) => {
  if (!SS_TOKEN) return res.status(500).json({ error: 'SMARTSHEET_TOKEN not set on server.' });
  const reportId = REPORT_IDS[req.params.deptId];
  if (!reportId) return res.status(404).json({ error: `No report for: ${req.params.deptId}` });

  try {
    // 1. Get source sheet ID from report
    const { status: rs, data: rd } = await ssReq('GET', `/reports/${reportId}?pageSize=1&include=sourceSheets`);
    if (rs !== 200) return res.status(rs).json({ error: rd.message || 'Cannot load report' });

    let sourceSheetId = null;
    if (rd.sourceSheets?.length)        sourceSheetId = String(rd.sourceSheets[0].id);
    else if (rd.rows?.length)           sourceSheetId = String(rd.rows[0].sheetId ?? rd.rows[0].sheet_id);
    if (!sourceSheetId) return res.status(400).json({ error: 'Cannot determine source sheet (report may be empty).' });

    // 2. Fetch source sheet columns
    const { status: cs, data: cd } = await ssReq('GET', `/sheets/${sourceSheetId}?pageSize=1`);
    if (cs !== 200) return res.status(cs).json({ error: cd.message || 'Cannot fetch columns' });

    const colMap = {};
    (cd.columns || []).forEach(c => { colMap[c.title] = c.id; });

    // 3. Build cells
    const b = req.body;
    const cells = [
      { title: SUBMIT_COLS.staffName, value: b.staffName  },
      { title: SUBMIT_COLS.vendor,    value: b.vendor      },
      { title: SUBMIT_COLS.badge,     value: b.badge       },
      { title: SUBMIT_COLS.startDate, value: b.startDate   },
      { title: SUBMIT_COLS.endDate,   value: b.endDate     },
    ]
      .map(({ title, value }) => {
        const columnId = colMap[title];
        if (!columnId || !value) return null;
        return { columnId, value: String(value) };
      })
      .filter(Boolean);

    if (!cells.length) return res.status(400).json({ error: 'No matching columns. Available: ' + Object.keys(colMap).join(', ') });

    // 4. Add row
    const { status: as, data: ad } = await ssReq('POST', `/sheets/${sourceSheetId}/rows`, { toBottom: true, cells });
    if (as !== 200) return res.status(as).json({ error: ad.message || 'Failed to add row', detail: ad });

    res.json({ success: true, rowId: ad.result?.[0]?.id });
  } catch (e) {
    console.error('POST row error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`CCH Agency Staff Tracking on port ${PORT}`));
