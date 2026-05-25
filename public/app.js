// ─────────────────────────────────────────────────────────────────
// CRYARK PLANNER — app.js
// Blueprint-style infinite canvas with draggable nodes and bezier edges
// ─────────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────
const S = {
  nodes:    [],   // { id, type, title, x, y, w, color, projectId, status, startDate, endDate, milestone, tasks, notes, path, url }
  edges:    [],   // { id, fromId, toId, label }
  projects: [],   // { id, name, color, desc }

  // viewport
  panX: 0, panY: 0,
  zoom: 1,

  // interaction
  tool: 'select',        // select | node | connect | pan
  draggingNode: null,    // { id, startX, startY, mouseX, mouseY }
  selectedNodes: new Set(),
  selectedEdge: null,

  // connection drawing
  connectingFrom: null,  // nodeId
  connectPreview: null,  // { x1,y1,x2,y2 }

  // panning
  isPanning: false,
  panStart: null,

  // pending node placement (click-to-place)
  pendingNodeData: null,

  // context menu target
  ctxTargetId: null,

  // modal editing
  editingNodeId: null,
  editingProjectId: null,

  // selected color in modal
  modalColor: '#1e6fff',
  projectModalColor: '#1e6fff',

  dirty: false,
  saveTimer: null
}

const COLORS = ['#1e6fff','#1a9e5c','#d4851a','#9b4dca','#c0392b','#16a085','#e67e22','#2980b9','#8e44ad','#27ae60']

const TYPE_ICONS = { phase: '◈', task: '□', note: '✎', doc: '⇗', project: '⬡' }

// ── Boot ──────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initGrid()
  initEdgeSVG()
  initEventListeners()
  loadBoard()
  buildColorSwatches('nm-color-swatches', 'modalColor')
  buildColorSwatches('pm-color-swatches', 'projectModalColor')
})

// ── API ───────────────────────────────────────────────────────────
async function loadBoard() {
  try {
    const res  = await fetch('/api/board')
    const data = await res.json()
    S.nodes    = data.nodes    || []
    S.edges    = data.edges    || []
    S.projects = data.projects || []
    renderAll()
    updateSaveStatus('saved')
  } catch (e) {
    // fallback: empty board (works when opening file:// locally too)
    console.warn('No server — running locally with no persistence.')
    updateSaveStatus('local')
  }
}

function scheduleSave() {
  S.dirty = true
  updateSaveStatus('saving')
  clearTimeout(S.saveTimer)
  S.saveTimer = setTimeout(saveBoard, 1200)
}

async function saveBoard() {
  try {
    const res = await fetch('/api/board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: S.nodes, edges: S.edges, projects: S.projects })
    })
    if (res.ok) { S.dirty = false; updateSaveStatus('saved') }
    else updateSaveStatus('error')
  } catch (e) {
    updateSaveStatus('error')
  }
}

function updateSaveStatus(s) {
  const el = document.getElementById('save-status')
  el.textContent = s === 'saving' ? 'saving…' : s === 'error' ? 'save error' : s === 'local' ? 'local mode' : 'saved'
  el.className = s
}

async function exportBackup() {
  try {
    window.location = '/api/export'
  } catch {
    const blob = new Blob([JSON.stringify({ nodes: S.nodes, edges: S.edges, projects: S.projects }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `planner-${new Date().toISOString().slice(0,10)}.json`
    a.click()
  }
}

function importBackup(e) {
  const file = e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result)
      if (!confirm('Replace current board with imported data?')) return
      S.nodes    = data.nodes    || []
      S.edges    = data.edges    || []
      S.projects = data.projects || []
      renderAll()
      scheduleSave()
    } catch { alert('Invalid JSON file') }
  }
  reader.readAsText(file)
  e.target.value = ''
}

// ── Grid canvas ───────────────────────────────────────────────────
function initGrid() {
  const canvas = document.getElementById('grid-canvas')
  const wrap   = document.getElementById('canvas-wrap')
  resizeGrid()
  window.addEventListener('resize', resizeGrid)
}

function resizeGrid() {
  const canvas = document.getElementById('grid-canvas')
  const wrap   = document.getElementById('canvas-wrap')
  canvas.width  = wrap.clientWidth
  canvas.height = wrap.clientHeight
  drawGrid()
}

function drawGrid() {
  const canvas = document.getElementById('grid-canvas')
  const ctx    = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height

  ctx.clearRect(0, 0, W, H)

  const spacing = 28 * S.zoom
  const offX = S.panX % spacing
  const offY = S.panY % spacing

  ctx.strokeStyle = 'rgba(30,111,255,0.07)'
  ctx.lineWidth   = 1
  ctx.setLineDash([1, spacing - 1])

  // Vertical lines
  for (let x = offX; x < W; x += spacing) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, H)
    ctx.stroke()
  }

  // Horizontal lines
  ctx.setLineDash([1, spacing - 1])
  for (let y = offY; y < H; y += spacing) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(W, y)
    ctx.stroke()
  }

  ctx.setLineDash([])

  // Origin dot
  const ox = S.panX, oy = S.panY
  if (ox > 0 && ox < W && oy > 0 && oy < H) {
    ctx.fillStyle = 'rgba(30,111,255,0.4)'
    ctx.beginPath()
    ctx.arc(ox, oy, 3, 0, Math.PI * 2)
    ctx.fill()
  }

  drawMinimap()
}

// ── Edge SVG layer ────────────────────────────────────────────────
function initEdgeSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.id = 'edge-svg'
  svg.setAttribute('width', '10000')
  svg.setAttribute('height', '10000')

  // Arrowhead marker
  const defs   = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
  defs.innerHTML = `
    <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="#2a3f5a"/>
    </marker>
    <marker id="arr-sel" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0, 8 3, 0 6" fill="#1e6fff"/>
    </marker>
  `
  svg.appendChild(defs)

  // Drag preview path
  const dragPath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  dragPath.id = 'drag-edge'
  dragPath.style.display = 'none'
  svg.appendChild(dragPath)

  document.getElementById('board').appendChild(svg)
}

// ── Rendering ─────────────────────────────────────────────────────
function renderAll() {
  applyViewport()
  renderNodes()
  renderEdges()
  updateProjectsPanel()
}

function applyViewport() {
  const board = document.getElementById('board')
  board.style.transform = `translate(${S.panX}px, ${S.panY}px) scale(${S.zoom})`
  document.getElementById('zoom-badge').textContent = Math.round(S.zoom * 100) + '%'
  drawGrid()
}

function renderNodes() {
  const board = document.getElementById('board')
  // Remove old node elements
  board.querySelectorAll('.node').forEach(el => el.remove())

  S.nodes.forEach(node => {
    const el = createNodeEl(node)
    board.appendChild(el)
  })
}

function createNodeEl(node) {
  const proj  = S.projects.find(p => p.id === node.projectId)
  const color = node.color || (proj ? proj.color : '#1e6fff')

  const el = document.createElement('div')
  el.className = 'node' + (S.selectedNodes.has(node.id) ? ' selected' : '')
  el.id   = 'node-' + node.id
  el.style.left = node.x + 'px'
  el.style.top  = node.y + 'px'
  if (node.w) el.style.width = node.w + 'px'

  const tasks     = node.tasks  || []
  const dateStr   = node.startDate || node.endDate
    ? [node.startDate, node.endDate].filter(Boolean).map(d => fmtDate(d)).join(' → ')
    : ''

  el.innerHTML = `
    <div class="node-port port-in"  data-port="in"  data-id="${node.id}"></div>
    <div class="node-port port-out" data-port="out" data-id="${node.id}"></div>
    <div class="node-header">
      <div class="node-color-bar" style="background:${color}"></div>
      <span class="node-type-icon">${TYPE_ICONS[node.type] || '◈'}</span>
      <span class="node-title" title="${esc(node.title)}">${esc(node.title)}</span>
      ${node.status ? `<span class="node-status st-${node.status}">${node.status}</span>` : ''}
    </div>
    <div class="node-body">
      ${dateStr  ? `<div class="node-dates">${dateStr}</div>` : ''}
      ${node.milestone ? `<div class="node-milestone">★ ${esc(node.milestone)}</div>` : ''}
      ${node.notes ? `<div style="color:var(--text2);margin-top:3px">${esc(trunc(node.notes, 80))}</div>` : ''}
      ${tasks.length ? `<div class="node-tasks-count">${tasks.length} task${tasks.length > 1 ? 's' : ''}</div>` : ''}
    </div>
  `

  // ── Node mouse events ─────────────────────────────────────────
  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    e.stopPropagation()

    // If clicking a port — start connection
    if (e.target.classList.contains('node-port')) {
      startConnection(node.id, e)
      return
    }

    if (S.tool === 'connect') {
      handleConnectClick(node.id)
      return
    }

    // Select
    if (!e.shiftKey) S.selectedNodes.clear()
    S.selectedNodes.add(node.id)
    S.selectedEdge = null
    updateSelectionVisuals()

    // Begin drag
    S.draggingNode = {
      id:     node.id,
      startX: node.x,
      startY: node.y,
      mouseX: e.clientX,
      mouseY: e.clientY
    }
    closeCtxMenu()
  })

  el.addEventListener('dblclick', e => {
    e.stopPropagation()
    openDetailPanel(node.id)
  })

  el.addEventListener('contextmenu', e => {
    e.preventDefault()
    e.stopPropagation()
    S.ctxTargetId = node.id
    showCtxMenu(e.clientX, e.clientY)
  })

  return el
}

function renderEdges() {
  const svg = document.getElementById('edge-svg')
  svg.querySelectorAll('.edge-group').forEach(el => el.remove())

  S.edges.forEach(edge => {
    const fromNode = S.nodes.find(n => n.id === edge.fromId)
    const toNode   = S.nodes.find(n => n.id === edge.toId)
    if (!fromNode || !toNode) return

    const fromEl = document.getElementById('node-' + edge.fromId)
    const toEl   = document.getElementById('node-' + edge.toId)
    if (!fromEl || !toEl) return

    const { x1, y1, x2, y2 } = getEdgePoints(fromNode, toNode, fromEl, toEl)
    const d    = bezierPath(x1, y1, x2, y2)
    const isSel = S.selectedEdge === edge.id

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.className = 'edge-group'
    g.dataset.id = edge.id

    // Hit area
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    hit.setAttribute('d', d)
    hit.setAttribute('fill', 'none')
    hit.setAttribute('stroke', 'transparent')
    hit.setAttribute('stroke-width', '12')
    hit.style.cursor = 'pointer'
    hit.addEventListener('click', ev => {
      ev.stopPropagation()
      S.selectedEdge = edge.id
      S.selectedNodes.clear()
      updateSelectionVisuals()
    })
    hit.addEventListener('contextmenu', ev => {
      ev.preventDefault()
      if (confirm('Delete this connection?')) {
        S.edges = S.edges.filter(e => e.id !== edge.id)
        renderEdges()
        scheduleSave()
      }
    })
    g.appendChild(hit)

    // Visual path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.className = 'edge-path' + (isSel ? ' selected' : '')
    path.setAttribute('d', d)
    path.setAttribute('marker-end', isSel ? 'url(#arr-sel)' : 'url(#arr)')
    g.appendChild(path)

    // Label
    if (edge.label) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      txt.className = 'edge-label'
      txt.setAttribute('x', mx)
      txt.setAttribute('y', my - 5)
      txt.setAttribute('text-anchor', 'middle')
      txt.textContent = edge.label
      g.appendChild(txt)
    }

    svg.appendChild(g)
  })
}

function getEdgePoints(fromNode, toNode, fromEl, toEl) {
  const fw = fromEl.offsetWidth  || 220
  const fh = fromEl.offsetHeight || 80
  const tw = toEl.offsetWidth    || 220
  const th = toEl.offsetHeight   || 80
  return {
    x1: fromNode.x + fw,
    y1: fromNode.y + fh / 2,
    x2: toNode.x,
    y2: toNode.y + th / 2
  }
}

function bezierPath(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1) * 0.5
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

// ── Connection drawing ────────────────────────────────────────────
function startConnection(nodeId, e) {
  S.connectingFrom = nodeId
  document.getElementById('node-' + nodeId).classList.add('connecting-source')
}

function handleConnectClick(nodeId) {
  if (!S.connectingFrom) {
    S.connectingFrom = nodeId
    document.getElementById('node-' + nodeId)?.classList.add('connecting-source')
    return
  }
  if (S.connectingFrom === nodeId) {
    cancelConnection()
    return
  }
  // Create edge
  const exists = S.edges.some(e =>
    (e.fromId === S.connectingFrom && e.toId === nodeId) ||
    (e.fromId === nodeId && e.toId === S.connectingFrom)
  )
  if (!exists) {
    S.edges.push({ id: uid(), fromId: S.connectingFrom, toId: nodeId, label: '' })
    scheduleSave()
  }
  document.getElementById('node-' + S.connectingFrom)?.classList.remove('connecting-source')
  S.connectingFrom = null
  renderEdges()
}

function cancelConnection() {
  if (S.connectingFrom) {
    document.getElementById('node-' + S.connectingFrom)?.classList.remove('connecting-source')
    S.connectingFrom = null
  }
  const drag = document.getElementById('drag-edge')
  if (drag) drag.style.display = 'none'
}

// ── Mouse event listeners ─────────────────────────────────────────
function initEventListeners() {
  const wrap = document.getElementById('canvas-wrap')

  wrap.addEventListener('mousedown', e => {
    if (e.button !== 0) return

    // Middle button pan or space+drag handled in keydown
    if (S.tool === 'pan') {
      startPan(e)
      return
    }

    // Clicking empty canvas
    if (e.target === wrap || e.target.id === 'grid-canvas' || e.target.id === 'board' || e.target.id === 'edge-svg') {
      if (S.tool === 'node' && S.pendingNodeData) {
        placeNodeAtCursor(e)
        return
      }
      if (S.connectingFrom) { cancelConnection(); return }
      S.selectedNodes.clear()
      S.selectedEdge = null
      updateSelectionVisuals()
      closeCtxMenu()
      startPan(e)
    }
  })

  wrap.addEventListener('mousemove', e => {
    if (S.draggingNode) {
      dragNode(e)
      return
    }
    if (S.isPanning) {
      doPan(e)
      return
    }
    if (S.connectingFrom) {
      updateDragEdge(e)
    }
  })

  wrap.addEventListener('mouseup', e => {
    if (S.draggingNode) { S.draggingNode = null; scheduleSave() }
    if (S.isPanning)    { S.isPanning = false }

    // If we were dragging a connection and released on a port
    if (S.connectingFrom && e.target.classList.contains('node-port')) {
      const targetId = e.target.dataset.id
      if (targetId && targetId !== S.connectingFrom) {
        handleConnectClick(targetId)
      } else {
        cancelConnection()
      }
    }
  })

  wrap.addEventListener('wheel', e => {
    e.preventDefault()
    const delta  = e.deltaY > 0 ? 0.9 : 1.1
    const newZoom = Math.max(0.15, Math.min(2.5, S.zoom * delta))
    const rect   = wrap.getBoundingClientRect()
    const mx     = e.clientX - rect.left
    const my     = e.clientY - rect.top
    S.panX = mx - (mx - S.panX) * (newZoom / S.zoom)
    S.panY = my - (my - S.panY) * (newZoom / S.zoom)
    S.zoom = newZoom
    applyViewport()
    renderEdges()
  }, { passive: false })

  wrap.addEventListener('contextmenu', e => e.preventDefault())

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    if (e.code === 'Space') { e.preventDefault(); setTool('pan') }
    if (e.key  === 'v' || e.key === 'V') setTool('select')
    if (e.key  === 'n' || e.key === 'N') setTool('node')
    if (e.key  === 'c' || e.key === 'C') setTool('connect')
    if (e.key  === 'f' || e.key === 'F') fitView()
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.closest('.modal')) deleteSelected()
    if (e.key === 'Escape') {
      cancelConnection()
      closeCtxMenu()
      closeDetailPanel()
      closeProjectsPanel()
      setTool('select')
    }
  })

  document.addEventListener('keyup', e => {
    if (e.code === 'Space') setTool('select')
  })

  document.addEventListener('click', () => closeCtxMenu())
}

// ── Drag node ─────────────────────────────────────────────────────
function dragNode(e) {
  const node   = S.nodes.find(n => n.id === S.draggingNode.id)
  if (!node) return
  const dx  = (e.clientX - S.draggingNode.mouseX) / S.zoom
  const dy  = (e.clientY - S.draggingNode.mouseY) / S.zoom
  node.x    = S.draggingNode.startX + dx
  node.y    = S.draggingNode.startY + dy
  const el  = document.getElementById('node-' + node.id)
  if (el) { el.style.left = node.x + 'px'; el.style.top = node.y + 'px' }
  renderEdges()
}

// ── Pan ───────────────────────────────────────────────────────────
function startPan(e) {
  S.isPanning = true
  S.panStart  = { x: e.clientX - S.panX, y: e.clientY - S.panY }
}

function doPan(e) {
  S.panX = e.clientX - S.panStart.x
  S.panY = e.clientY - S.panStart.y
  applyViewport()
  renderEdges()
}

// ── Drag edge preview ─────────────────────────────────────────────
function updateDragEdge(e) {
  const wrap   = document.getElementById('canvas-wrap')
  const rect   = wrap.getBoundingClientRect()
  const fromNode = S.nodes.find(n => n.id === S.connectingFrom)
  if (!fromNode) return
  const fromEl = document.getElementById('node-' + S.connectingFrom)
  if (!fromEl) return

  const x1 = fromNode.x + fromEl.offsetWidth
  const y1 = fromNode.y + fromEl.offsetHeight / 2
  // Convert screen mouse to board space
  const x2 = (e.clientX - rect.left - S.panX) / S.zoom
  const y2 = (e.clientY - rect.top  - S.panY) / S.zoom

  const drag = document.getElementById('drag-edge')
  drag.setAttribute('d', bezierPath(x1, y1, x2, y2))
  drag.style.display = 'block'
}

// ── Zoom / fit ────────────────────────────────────────────────────
function fitView() {
  if (S.nodes.length === 0) return
  const wrap = document.getElementById('canvas-wrap')
  const W = wrap.clientWidth, H = wrap.clientHeight
  const pad = 60

  const xs = S.nodes.map(n => n.x)
  const ys = S.nodes.map(n => n.y)
  const x2s = S.nodes.map(n => n.x + (n.w || 220))
  const y2s = S.nodes.map(n => n.y + 100)

  const minX = Math.min(...xs), maxX = Math.max(...x2s)
  const minY = Math.min(...ys), maxY = Math.max(...y2s)
  const bW   = maxX - minX, bH = maxY - minY

  S.zoom = Math.min(2, Math.max(0.15, Math.min((W - pad*2) / bW, (H - pad*2) / bH)))
  S.panX = (W - bW * S.zoom) / 2 - minX * S.zoom
  S.panY = (H - bH * S.zoom) / 2 - minY * S.zoom

  applyViewport()
  renderEdges()
}

// ── Tool management ───────────────────────────────────────────────
function setTool(tool) {
  S.tool = tool
  const wrap = document.getElementById('canvas-wrap')

  ;['select','node','connect','pan'].forEach(t => {
    document.getElementById('tool-' + t)?.classList.toggle('active', t === tool)
  })

  wrap.style.cursor = tool === 'pan' ? 'grab' : tool === 'node' ? 'crosshair' : tool === 'connect' ? 'crosshair' : 'default'

  if (tool !== 'connect') cancelConnection()
  if (tool !== 'node')    S.pendingNodeData = null
}

// ── Node placement ────────────────────────────────────────────────
function placeNodeAtCursor(e) {
  const wrap = document.getElementById('canvas-wrap')
  const rect = wrap.getBoundingClientRect()
  const x = (e.clientX - rect.left - S.panX) / S.zoom - 110
  const y = (e.clientY - rect.top  - S.panY) / S.zoom - 40
  S.pendingNodeData.x = x
  S.pendingNodeData.y = y
  S.nodes.push(S.pendingNodeData)
  S.pendingNodeData = null
  setTool('select')
  renderAll()
  scheduleSave()
}

// ── Node modal ────────────────────────────────────────────────────
function openNodeModal(editId = null) {
  S.editingNodeId = editId
  const node = editId ? S.nodes.find(n => n.id === editId) : null

  document.getElementById('node-modal-title').textContent = editId ? 'Edit Node' : 'New Node'
  document.getElementById('nm-type').value      = node ? node.type      : 'phase'
  document.getElementById('nm-title').value     = node ? node.title     : ''
  document.getElementById('nm-status').value    = node ? node.status    : 'planned'
  document.getElementById('nm-start').value     = node ? node.startDate : ''
  document.getElementById('nm-end').value       = node ? node.endDate   : ''
  document.getElementById('nm-milestone').value = node ? node.milestone : ''
  document.getElementById('nm-tasks').value     = node ? (node.tasks||[]).join('\n') : ''
  document.getElementById('nm-notes').value     = node ? node.notes     : ''
  document.getElementById('nm-path').value      = node ? node.path      : ''
  document.getElementById('nm-url').value       = node ? node.url       : ''

  // Project selector
  const sel = document.getElementById('nm-project')
  sel.innerHTML = '<option value="">— No project —</option>'
  S.projects.forEach(p => {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.name
    if (node && node.projectId === p.id) opt.selected = true
    sel.appendChild(opt)
  })

  S.modalColor = node ? (node.color || '#1e6fff') : '#1e6fff'
  updateSwatchSelection('nm-color-swatches', S.modalColor)

  onNodeTypeChange()
  document.getElementById('node-modal').style.display = 'flex'
  document.getElementById('nm-title').focus()
}

function onNodeTypeChange() {
  const t   = document.getElementById('nm-type').value
  const pf  = document.getElementById('nm-phase-fields')
  const df  = document.getElementById('nm-doc-fields')
  pf.style.display = (t === 'phase' || t === 'task' || t === 'project') ? 'flex' : 'none'
  pf.style.flexDirection = 'column'
  pf.style.gap = '10px'
  df.style.display = t === 'doc' ? 'flex' : 'none'
  df.style.flexDirection = 'column'
  df.style.gap = '10px'
}

function saveNodeModal() {
  const title = document.getElementById('nm-title').value.trim()
  if (!title) { alert('Title is required'); return }

  const tasks = document.getElementById('nm-tasks').value
    .split('\n').map(t => t.trim()).filter(Boolean)

  const data = {
    type:      document.getElementById('nm-type').value,
    title,
    projectId: document.getElementById('nm-project').value || null,
    status:    document.getElementById('nm-status').value,
    startDate: document.getElementById('nm-start').value,
    endDate:   document.getElementById('nm-end').value,
    milestone: document.getElementById('nm-milestone').value.trim(),
    tasks,
    notes:     document.getElementById('nm-notes').value.trim(),
    path:      document.getElementById('nm-path').value.trim(),
    url:       document.getElementById('nm-url').value.trim(),
    color:     S.modalColor
  }

  if (S.editingNodeId) {
    const node = S.nodes.find(n => n.id === S.editingNodeId)
    Object.assign(node, data)
  } else {
    // If tool is 'node', set to place mode
    if (S.tool === 'node') {
      S.pendingNodeData = { id: uid(), x: 100, y: 100, w: 220, ...data }
      closeModal('node-modal')
      return
    }
    // Otherwise place near center
    const wrap = document.getElementById('canvas-wrap')
    const cx = (wrap.clientWidth  / 2 - S.panX) / S.zoom
    const cy = (wrap.clientHeight / 2 - S.panY) / S.zoom
    S.nodes.push({ id: uid(), x: cx - 110, y: cy - 40, w: 220, ...data })
  }

  closeModal('node-modal')
  renderAll()
  scheduleSave()
}

// ── Project modal ─────────────────────────────────────────────────
function openProjectsPanel() {
  document.getElementById('projects-panel').classList.toggle('open')
  updateProjectsPanel()
}

function closeProjectsPanel() {
  document.getElementById('projects-panel').classList.remove('open')
}

function updateProjectsPanel() {
  const list = document.getElementById('projects-list')
  list.innerHTML = ''
  S.projects.forEach(p => {
    const el = document.createElement('div')
    el.className = 'proj-item'
    el.innerHTML = `
      <div class="proj-dot" style="background:${p.color}"></div>
      <span class="proj-name">${esc(p.name)}</span>
      <div class="proj-actions">
        <button class="proj-btn" onclick="event.stopPropagation();editProject('${p.id}')">Edit</button>
        <button class="proj-btn danger" onclick="event.stopPropagation();deleteProject('${p.id}')">Del</button>
      </div>
    `
    el.onclick = () => highlightProject(p.id)
    list.appendChild(el)
  })
}

function addProject() {
  S.editingProjectId = null
  document.getElementById('project-modal-title').textContent = 'New Project'
  document.getElementById('pm-name').value = ''
  document.getElementById('pm-desc').value = ''
  S.projectModalColor = '#1e6fff'
  updateSwatchSelection('pm-color-swatches', S.projectModalColor)
  document.getElementById('project-modal').style.display = 'flex'
  document.getElementById('pm-name').focus()
}

function editProject(id) {
  S.editingProjectId = id
  const p = S.projects.find(p => p.id === id)
  document.getElementById('project-modal-title').textContent = 'Edit Project'
  document.getElementById('pm-name').value = p.name
  document.getElementById('pm-desc').value = p.desc || ''
  S.projectModalColor = p.color || '#1e6fff'
  updateSwatchSelection('pm-color-swatches', S.projectModalColor)
  document.getElementById('project-modal').style.display = 'flex'
}

function saveProjectModal() {
  const name = document.getElementById('pm-name').value.trim()
  if (!name) { alert('Name required'); return }
  const data = { name, desc: document.getElementById('pm-desc').value.trim(), color: S.projectModalColor }

  if (S.editingProjectId) {
    Object.assign(S.projects.find(p => p.id === S.editingProjectId), data)
  } else {
    S.projects.push({ id: uid(), ...data })
  }
  closeModal('project-modal')
  updateProjectsPanel()
  renderNodes()
  scheduleSave()
}

function deleteProject(id) {
  const p = S.projects.find(p => p.id === id)
  if (!confirm(`Delete project "${p.name}"? Nodes will not be deleted but will lose their project association.`)) return
  S.projects = S.projects.filter(p => p.id !== id)
  S.nodes.forEach(n => { if (n.projectId === id) n.projectId = null })
  updateProjectsPanel()
  renderNodes()
  scheduleSave()
}

function highlightProject(id) {
  S.selectedNodes.clear()
  S.nodes.filter(n => n.projectId === id).forEach(n => S.selectedNodes.add(n.id))
  updateSelectionVisuals()
}

// ── Detail panel ──────────────────────────────────────────────────
function openDetailPanel(nodeId) {
  const node = S.nodes.find(n => n.id === nodeId)
  if (!node) return
  const proj  = S.projects.find(p => p.id === node.projectId)
  const color = node.color || (proj ? proj.color : '#1e6fff')
  const tasks = node.tasks || []

  const body = document.getElementById('detail-body')
  document.getElementById('detail-title').textContent = node.title

  const hasLink = node.url || node.path
  const href    = node.url || (node.path ? 'file://' + node.path : null)

  body.innerHTML = `
    ${proj ? `<div class="dp-section"><div class="dp-label">Project</div>
      <div class="dp-value" style="color:${proj.color}">⬡ ${esc(proj.name)}</div></div>` : ''}

    <div class="dp-section" style="display:flex;gap:8px;align-items:center">
      <div style="background:${color};width:10px;height:10px;border-radius:50%;flex-shrink:0"></div>
      <span style="font-size:11px;color:var(--text3)">${node.type}</span>
      ${node.status ? `<span class="node-status st-${node.status}" style="margin-left:auto">${node.status}</span>` : ''}
    </div>

    ${(node.startDate||node.endDate) ? `<div class="dp-section">
      <div class="dp-label">Dates</div>
      <div class="dp-value">${[node.startDate,node.endDate].filter(Boolean).map(fmtDate).join(' → ')}</div>
    </div>` : ''}

    ${node.milestone ? `<div class="dp-section">
      <div class="dp-label">Milestone</div>
      <div class="dp-milestone">★ ${esc(node.milestone)}</div>
    </div>` : ''}

    ${tasks.length ? `<div class="dp-section">
      <div class="dp-label">Tasks (${tasks.length})</div>
      <ul class="dp-task-list">${tasks.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>` : ''}

    ${node.notes ? `<div class="dp-section">
      <div class="dp-label">Notes</div>
      <div class="dp-value" style="white-space:pre-wrap">${esc(node.notes)}</div>
    </div>` : ''}

    ${hasLink ? `<div class="dp-section">
      <div class="dp-label">Document</div>
      <a href="${esc(href)}" target="_blank" style="color:var(--accent2);font-size:12px;word-break:break-all">
        ${esc(node.url || node.path)} ↗
      </a>
    </div>` : ''}

    <div class="dp-btn-row">
      <button class="full-btn" onclick="openNodeModal('${node.id}')">Edit node</button>
      <button class="full-btn" style="color:var(--s-blocked)" onclick="deleteNode('${node.id}');closeDetailPanel()">Delete</button>
    </div>
  `
  document.getElementById('detail-panel').classList.add('open')
}

function closeDetailPanel() {
  document.getElementById('detail-panel').classList.remove('open')
}

// ── Selection ─────────────────────────────────────────────────────
function updateSelectionVisuals() {
  document.querySelectorAll('.node').forEach(el => {
    const id = el.id.replace('node-', '')
    el.classList.toggle('selected', S.selectedNodes.has(id))
  })
  document.querySelectorAll('.edge-path').forEach(el => {
    const id = el.closest('.edge-group')?.dataset.id
    el.classList.toggle('selected', id === S.selectedEdge)
  })
}

function deleteSelected() {
  if (S.selectedNodes.size > 0) {
    if (!confirm(`Delete ${S.selectedNodes.size} node(s)?`)) return
    S.selectedNodes.forEach(id => {
      S.nodes  = S.nodes.filter(n => n.id !== id)
      S.edges  = S.edges.filter(e => e.fromId !== id && e.toId !== id)
    })
    S.selectedNodes.clear()
  }
  if (S.selectedEdge) {
    S.edges = S.edges.filter(e => e.id !== S.selectedEdge)
    S.selectedEdge = null
  }
  renderAll()
  scheduleSave()
}

function deleteNode(id) {
  S.nodes  = S.nodes.filter(n => n.id !== id)
  S.edges  = S.edges.filter(e => e.fromId !== id && e.toId !== id)
  S.selectedNodes.delete(id)
  renderAll()
  scheduleSave()
}

// ── Context menu ──────────────────────────────────────────────────
function showCtxMenu(x, y) {
  const m = document.getElementById('ctx-menu')
  m.style.left    = x + 'px'
  m.style.top     = y + 'px'
  m.style.display = 'block'
  if (!S.selectedNodes.has(S.ctxTargetId)) {
    S.selectedNodes.clear()
    S.selectedNodes.add(S.ctxTargetId)
    updateSelectionVisuals()
  }
}
function closeCtxMenu() { document.getElementById('ctx-menu').style.display = 'none' }
function ctxEdit()      { openNodeModal(S.ctxTargetId); closeCtxMenu() }
function ctxConnect()   { setTool('connect'); S.connectingFrom = S.ctxTargetId; document.getElementById('node-' + S.ctxTargetId)?.classList.add('connecting-source'); closeCtxMenu() }
function ctxDelete()    { S.selectedNodes.add(S.ctxTargetId); deleteSelected(); closeCtxMenu() }
function ctxDuplicate() {
  const src = S.nodes.find(n => n.id === S.ctxTargetId)
  if (!src) return
  const copy = { ...JSON.parse(JSON.stringify(src)), id: uid(), x: src.x + 30, y: src.y + 30 }
  S.nodes.push(copy)
  renderAll()
  scheduleSave()
  closeCtxMenu()
}

// ── Minimap ───────────────────────────────────────────────────────
function drawMinimap() {
  const canvas = document.getElementById('minimap')
  const ctx    = canvas.getContext('2d')
  const W = canvas.width = 160, H = canvas.height = 100

  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#090d12'
  ctx.fillRect(0, 0, W, H)

  if (S.nodes.length === 0) return

  const xs  = S.nodes.map(n => n.x)
  const ys  = S.nodes.map(n => n.y)
  const x2s = S.nodes.map(n => n.x + 220)
  const y2s = S.nodes.map(n => n.y + 80)

  const minX = Math.min(...xs)   - 40
  const minY = Math.min(...ys)   - 40
  const maxX = Math.max(...x2s)  + 40
  const maxY = Math.max(...y2s)  + 40
  const bW   = maxX - minX || 1
  const bH   = maxY - minY || 1

  const scale = Math.min(W / bW, H / bH) * 0.9
  const offX  = (W - bW * scale) / 2 - minX * scale
  const offY  = (H - bH * scale) / 2 - minY * scale

  // Draw nodes
  S.nodes.forEach(n => {
    const proj  = S.projects.find(p => p.id === n.projectId)
    const color = n.color || (proj ? proj.color : '#1e6fff')
    ctx.fillStyle = color + '88'
    ctx.fillRect(n.x * scale + offX, n.y * scale + offY, 220 * scale, 40 * scale)
  })

  // Draw viewport rect
  const wrap = document.getElementById('canvas-wrap')
  const vx   = (-S.panX / S.zoom) * scale + offX
  const vy   = (-S.panY / S.zoom) * scale + offY
  const vw   = (wrap.clientWidth  / S.zoom) * scale
  const vh   = (wrap.clientHeight / S.zoom) * scale

  ctx.strokeStyle = 'rgba(30,111,255,0.6)'
  ctx.lineWidth   = 1
  ctx.strokeRect(vx, vy, vw, vh)
}

// Click minimap to navigate
document.getElementById('minimap')?.addEventListener('click', e => {
  const canvas = document.getElementById('minimap')
  const rect   = canvas.getBoundingClientRect()
  const mx     = (e.clientX - rect.left) / canvas.width
  const my     = (e.clientY - rect.top)  / canvas.height
  const wrap   = document.getElementById('canvas-wrap')

  if (S.nodes.length === 0) return
  const xs = S.nodes.map(n => n.x), ys = S.nodes.map(n => n.y)
  const x2s = S.nodes.map(n => n.x + 220), y2s = S.nodes.map(n => n.y + 80)
  const minX = Math.min(...xs) - 40, minY = Math.min(...ys) - 40
  const maxX = Math.max(...x2s) + 40, maxY = Math.max(...y2s) + 40
  const bW = maxX - minX, bH = maxY - minY

  const worldX = minX + mx * bW
  const worldY = minY + my * bH
  S.panX = wrap.clientWidth  / 2 - worldX * S.zoom
  S.panY = wrap.clientHeight / 2 - worldY * S.zoom
  applyViewport()
  renderEdges()
})

// ── Color swatches ────────────────────────────────────────────────
function buildColorSwatches(containerId, stateKey) {
  const container = document.getElementById(containerId)
  COLORS.forEach(c => {
    const sw = document.createElement('div')
    sw.className = 'swatch' + (S[stateKey] === c ? ' selected' : '')
    sw.style.background = c
    sw.dataset.color = c
    sw.onclick = () => {
      S[stateKey] = c
      updateSwatchSelection(containerId, c)
    }
    container.appendChild(sw)
  })
}

function updateSwatchSelection(containerId, color) {
  document.querySelectorAll(`#${containerId} .swatch`).forEach(sw => {
    sw.classList.toggle('selected', sw.dataset.color === color)
  })
}

// ── Modal utils ───────────────────────────────────────────────────
function closeModal(id) {
  document.getElementById(id).style.display = 'none'
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('mousedown', e => {
    if (e.target === overlay) overlay.style.display = 'none'
  })
})

// ── Utils ─────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,6)
}

function esc(s) {
  if (!s) return ''
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function trunc(s, n) {
  return s && s.length > n ? s.slice(0, n) + '…' : (s || '')
}

function fmtDate(d) {
  if (!d) return ''
  const parts = d.split('-')
  if (parts.length < 2) return d
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return months[parseInt(parts[1])-1] + ' ' + parts[0].slice(2)
}

// Keyboard shortcut: N key opens node modal
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
  if (e.key === 'Enter' && S.tool === 'node') openNodeModal()
})
