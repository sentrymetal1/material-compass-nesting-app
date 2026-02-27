# Material Compass Nesting — Web App

## Overview
External web app (Railway-hosted) for running 1D/2D material nesting with a full UI.
Reads BOM data from Zoho Creator, runs nesting via the existing Railway API, and saves results back.

## Architecture
- **Express.js backend** — Zoho OAuth, proxies nesting API, reads/writes Zoho data
- **React frontend** — 3-step flow: Select BOM items → Configure kerf/grain → View results
- **Single Railway service** — backend serves the built React frontend

## Setup

### 1. Push to GitHub
Create a new repo and push this code.

### 2. Deploy on Railway
- Connect the GitHub repo
- Railway will auto-detect the Dockerfile

### 3. Set Environment Variables in Railway
```
ZOHO_CLIENT_ID=your_full_client_id
ZOHO_CLIENT_SECRET=your_full_client_secret
ZOHO_REFRESH_TOKEN=1000.8c9ec6c3fb59552779ae5e0cacfe92dd.935fe45659c7f98c13f492c9ee133c2a
ZOHO_ACCOUNT_OWNER=mark_sentrymetal
ZOHO_APP_LINK_NAME=type-formsheet-2-18-21
NESTING_API_URL=https://metal-nesting-api-production.up.railway.app/nest
PORT=3000
```

### 4. Access
Open the Railway-provided URL with a project ID:
```
https://your-app.up.railway.app/?project_id=ZOHO_PROJECT_ID
```

## Usage Flow
1. User clicks link in Zoho portal → opens web app with project ID
2. App loads BOM items from Zoho, user selects items to nest
3. User configures kerf settings and grain direction for panels
4. Clicks "Run Nesting" → calls existing nesting API
5. Results display with cut lists and visual bar layouts
6. "Import to Project" saves results back to Zoho

## Zoho API Scopes
```
ZohoCreator.report.READ
ZohoCreator.form.CREATE
ZohoCreator.form.UPDATE
```

## Report Names (may need adjustment)
The backend assumes these Zoho Creator report names:
- `All_Projects` — project records
- `Project_Bill_Of_Material_Detail_Form_Report` — BOM items
- `Nesting_Stock_Library_Report` — stock library
- `Nesting_Run_Header_Report` — nesting run headers

If your report names differ, update them in `server/index.js`.
