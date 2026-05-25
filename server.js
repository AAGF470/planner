const express = require('express')
const cors    = require('cors')
const fs      = require('fs')
const path    = require('path')

const app      = express()
const PORT     = process.env.PORT || 3000
const DATA_FILE = path.join(__dirname, 'data.json')

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// ── Ensure data file exists ───────────────────
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ nodes: [], edges: [], projects: [], version: 1 }, null, 2))
  console.log('Created fresh data.json')
}

// ── API: load full board state ────────────────
app.get('/api/board', (req, res) => {
  try {
    const raw  = fs.readFileSync(DATA_FILE, 'utf8')
    res.json(JSON.parse(raw))
  } catch (e) {
    res.status(500).json({ error: 'Could not read data file' })
  }
})

// ── API: save full board state ────────────────
app.post('/api/board', (req, res) => {
  try {
    const data = req.body
    data.lastSaved = new Date().toISOString()
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
    res.json({ ok: true, lastSaved: data.lastSaved })
  } catch (e) {
    res.status(500).json({ error: 'Could not write data file' })
  }
})

// ── API: export backup ────────────────────────
app.get('/api/export', (req, res) => {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const filename = `planner-backup-${new Date().toISOString().slice(0,10)}.json`
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Type', 'application/json')
    res.send(raw)
  } catch (e) {
    res.status(500).json({ error: 'Export failed' })
  }
})

// ── Fallback: serve index.html for all other routes ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Cryark Planner running on http://localhost:${PORT}`)
})
