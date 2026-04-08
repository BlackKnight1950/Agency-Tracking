# CCH Agency Staff Tracking Portal

Cook County Health · Project Management Office  
A web app for stakeholders to submit and view agency staff records across department Smartsheet logs.

---

## What it does

- **Submit** Agency Staff Name, Vendor, Badge #, CCH Start Date, CCH End Date directly into any department's Smartsheet
- **View live data** — fetches and paginates rows from the selected sheet in real time
- **16 departments** — ACHN, Ancillary, BH, Clinical Research, Correctional, CountyCare, Finance, HIS, HR, Patient Experience, Provider, Public Health, Quality Management, SCM, Support Services, Unlicensed Assistive Personnel

---

## Tech stack

| Layer | Tech |
|-------|------|
| Backend | Node.js + Express |
| Frontend | Vanilla HTML/CSS/JS (served as static from `public/`) |
| Smartsheet | Direct REST API v2 (token stored server-side) |
| Hosting | Render (web service) |

---

## Local development

### 1. Clone & install
```bash
git clone https://github.com/YOUR-ORG/cch-agency-staff-tracking.git
cd cch-agency-staff-tracking
npm install
```

### 2. Set up environment
```bash
cp .env.example .env
# Edit .env and paste your Smartsheet API token
```

Get your token: Smartsheet → Account (top-right) → Personal Settings → API Access → Generate new token

### 3. Run locally
```bash
npm run dev    # uses nodemon for auto-reload
# or
npm start
```

Open http://localhost:3000

---

## Deploy to Render

### Option A — One-click via render.yaml (recommended)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` — click **Apply**
5. When prompted, add the environment variable:
   - Key: `SMARTSHEET_TOKEN`
   - Value: your Smartsheet API access token
6. Click **Deploy**

Your app will be live at `https://cch-agency-staff-tracking.onrender.com` (or your custom domain).

### Option B — Manual setup on Render

| Setting | Value |
|---------|-------|
| Environment | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Environment Variable | `SMARTSHEET_TOKEN` = your token |

---

## Configuring Sheet IDs

Each department needs its own Smartsheet Sheet ID entered in the app:

1. Open the live app URL
2. Click **⚙ Sheet IDs** (top right)
3. Paste the Sheet ID for each department
4. Click Save — IDs persist in the browser's localStorage

**To find a Sheet ID:**  
Open the sheet in Smartsheet → File → Properties → Sheet ID

### Required column names

Each sheet must have these exact column names (case-sensitive):

| Column | Type |
|--------|------|
| Agency Staff Name | Text/Number |
| Vendor | Text/Number |
| Badge # | Text/Number |
| CCH Start Date | Date |
| CCH End Date | Date |

---

## API endpoints (internal)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Server + token status |
| GET | `/api/sheet/:id` | Fetch sheet rows (paginated) |
| POST | `/api/sheet/:id/rows` | Add a new row |

---

## Security notes

- `SMARTSHEET_TOKEN` is stored only on the server — never exposed to the browser
- `.env` is in `.gitignore` — never committed to GitHub
- All Smartsheet calls are proxied through the Express backend
