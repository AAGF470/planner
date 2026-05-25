// ─────────────────────────────────────────────────────
// CRYARK PLANNER — app.js
// Figma-style controls:
//   Middle mouse hold   → pan
//   Left drag on canvas → marquee select
//   Left drag on node   → move node
//   Left click canvas   → deselect
//   Scroll wheel        → zoom (toward cursor)
//   Space + drag        → pan (fallback)
//   Double-click node   → open detail panel
//   Right-click node    → context menu
// ─────────────────────────────────────────────────────

const S = {
  nodes: [], edges: [], projects: [],
  panX: 0, panY: 0, zoom: 1,

  // tool: 'select' | 'connect'  (no pan tool — middle mouse handles that)
  tool: 'select',

  // node dragging
  draggingNode: null,     // { id, startX, startY, mouseX, mouseY }

  // middle-mouse / space pan
  isPanning: false,
  panStart: null,

  // marquee select
  marquee: null,          // { startX, startY, x, y, w, h } in canvas coords

  // selection
  selectedNodes: new Set(),
  selectedEdge: null,

  // connection drawing
  connectingFrom: null,

  // space key held
  spaceDown: false,

  // pending node placement after modal
  pendingNodeData: null,

  // context menu
  ctxTargetId: null,

  // modal editing
  editingNodeId: null,
  editingProjectId: null,

  // color pickers
  modalColor: '#1e6fff',
  projectModalColor: '#1e6fff',

  dirty: false,
  saveTimer: null
}

const COLORS = ['#1e6fff','#1a9e5c','#d4851a','#9b4dca','#c0392b','#16a085','#e67e22','#2980b9','#8e44ad','#27ae60']
const TYPE_ICONS = { phase: '◈', task: '□', note: '✎', doc: '⇗', project: '⬡' }

// ── Boot ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  resizeGrid()
  window.addEventListener('resize', resizeGrid)
  initEdgeSVG()
  initMarqueeEl()
  initEventListeners()
  buildColorSwatches('nm-color-swatches', 'modalColor')
  buildColorSwatches('pm-color-swatches', 'projectModalColor')
  loadBoard()
})

// ── API ───────────────────────────────────────────────
async function loadBoard() {
  try {
    const res = await fetch('/api/board')
    const data = await res.json()
    S.nodes = data.nodes || []; S.edges = data.edges || []; S.projects = data.projects || []
    renderAll(); updateSaveStatus('saved')
  } catch { updateSaveStatus('local') }
}

function scheduleSave() {
  S.dirty = true; updateSaveStatus('saving')
  clearTimeout(S.saveTimer)
  S.saveTimer = setTimeout(saveBoard, 1200)
}

async function saveBoard() {
  try {
    const res = await fetch('/api/board', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: S.nodes, edges: S.edges, projects: S.projects })
    })
    if (res.ok) { S.dirty = false; updateSaveStatus('saved') }
    else updateSaveStatus('error')
  } catch { updateSaveStatus('error') }
}

function updateSaveStatus(s) {
  const el = document.getElementById('save-status')
  el.textContent = { saving:'saving…', error:'save error', local:'local mode', saved:'saved' }[s] || s
  el.className = s
}

async function exportBackup() {
  try { window.location = '/api/export' } catch {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ nodes:S.nodes, edges:S.edges, projects:S.projects }, null, 2)], { type:'application/json' }))
    a.download = `planner-${new Date().toISOString().slice(0,10)}.json`; a.click()
  }
}

function importBackup(e) {
  const file = e.target.files[0]; if (!file) return
  const reader = new FileReader()
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result)
      if (!confirm('Replace board with imported data?')) return
      S.nodes = data.nodes || []; S.edges = data.edges || []; S.projects = data.projects || []
      renderAll(); scheduleSave()
    } catch { alert('Invalid JSON') }
  }
  reader.readAsText(file); e.target.value = ''
}

// ── Grid ──────────────────────────────────────────────
function resizeGrid() {
  const canvas = document.getElementById('grid-canvas')
  const wrap   = document.getElementById('canvas-wrap')
  canvas.width = wrap.clientWidth; canvas.height = wrap.clientHeight
  drawGrid()
}

function drawGrid() {
  const canvas = document.getElementById('grid-canvas')
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0, 0, W, H)
  const spacing = 28 * S.zoom
  const offX = S.panX % spacing, offY = S.panY % spacing
  ctx.strokeStyle = 'rgba(30,111,255,0.07)'; ctx.lineWidth = 1
  ctx.setLineDash([1, spacing - 1])
  for (let x = offX; x < W; x += spacing) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke() }
  for (let y = offY; y < H; y += spacing) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke() }
  ctx.setLineDash([])
  const ox = S.panX, oy = S.panY
  if (ox>0&&ox<W&&oy>0&&oy<H) { ctx.fillStyle='rgba(30,111,255,0.4)'; ctx.beginPath(); ctx.arc(ox,oy,3,0,Math.PI*2); ctx.fill() }
  drawMinimap()
}

// ── Edge SVG ──────────────────────────────────────────
function initEdgeSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg')
  svg.id = 'edge-svg'
  // width/height 0 + overflow visible = SVG takes no layout space
  // but paths render freely in board coordinate space
  svg.setAttribute('width','0')
  svg.setAttribute('height','0')
  svg.setAttribute('overflow','visible')
  svg.style.position = 'absolute'
  svg.style.top = '0'
  svg.style.left = '0'
  svg.style.pointerEvents = 'none'
  svg.style.overflow = 'visible'
  const defs = document.createElementNS('http://www.w3.org/2000/svg','defs')
  defs.innerHTML = `
    <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0,8 3,0 6" fill="#2a3f5a"/></marker>
    <marker id="arr-sel" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
      <polygon points="0 0,8 3,0 6" fill="#00c8e0"/></marker>`
  svg.appendChild(defs)
  const dp = document.createElementNS('http://www.w3.org/2000/svg','path')
  dp.id='drag-edge'; dp.style.display='none'
  dp.setAttribute('fill','none'); dp.setAttribute('stroke','#f59e0b')
  dp.setAttribute('stroke-width','1.5'); dp.setAttribute('stroke-dasharray','5 4')
  svg.appendChild(dp)
  document.getElementById('board').appendChild(svg)
}

// ── Marquee select element ────────────────────────────
function initMarqueeEl() {
  const el = document.createElement('div')
  el.id = 'marquee'
  el.style.cssText = `
    position:absolute;pointer-events:none;display:none;
    border:1.5px solid rgba(0,200,224,0.6);
    background:rgba(0,150,200,0.06);border-radius:2px;
  `
  document.getElementById('board').appendChild(el)
}

// ── Render ────────────────────────────────────────────
function renderAll() { applyViewport(); renderNodes(); renderEdges(); updateProjectsPanel() }

function applyViewport() {
  document.getElementById('board').style.transform = `translate(${S.panX}px,${S.panY}px) scale(${S.zoom})`
  document.getElementById('zoom-badge').textContent = Math.round(S.zoom*100) + '%'
  drawGrid()
}

function renderNodes() {
  const board = document.getElementById('board')
  board.querySelectorAll('.node').forEach(el => el.remove())
  S.nodes.forEach(node => board.appendChild(createNodeEl(node)))
}

function createNodeEl(node) {
  const proj  = S.projects.find(p => p.id === node.projectId)
  const color = node.color || (proj ? proj.color : '#1e6fff')
  const el    = document.createElement('div')
  el.className = 'node' + (S.selectedNodes.has(node.id) ? ' selected' : '')
  el.id = 'node-' + node.id
  el.style.left = node.x + 'px'; el.style.top = node.y + 'px'
  if (node.w) el.style.width = node.w + 'px'
  const tasks   = node.tasks || []
  const dateStr = (node.startDate||node.endDate)
    ? [node.startDate,node.endDate].filter(Boolean).map(fmtDate).join(' → ') : ''

  el.innerHTML = `
    <div class="node-port port-in"  data-port="in"  data-id="${node.id}"></div>
    <div class="node-port port-out" data-port="out" data-id="${node.id}"></div>
    <div class="node-header">
      <div class="node-color-bar" style="background:${color}"></div>
      <span class="node-type-icon">${TYPE_ICONS[node.type]||'◈'}</span>
      <span class="node-title" title="${esc(node.title)}">${esc(node.title)}</span>
      ${node.status?`<span class="node-status st-${node.status}">${node.status}</span>`:''}
    </div>
    <div class="node-body">
      ${dateStr?`<div class="node-dates">${dateStr}</div>`:''}
      ${node.milestone?`<div class="node-milestone">★ ${esc(node.milestone)}</div>`:''}
      ${node.notes?`<div style="color:var(--text2);margin-top:3px">${esc(trunc(node.notes,80))}</div>`:''}
      ${tasks.length?`<div class="node-tasks-count">${tasks.length} task${tasks.length>1?'s':''}</div>`:''}
    </div>`

  el.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    e.stopPropagation()
    // Port click → start connection
    if (e.target.classList.contains('node-port')) { startConnection(node.id); return }
    // Connect tool click
    if (S.tool === 'connect') { handleConnectClick(node.id); return }
    // Select + begin drag
    if (!e.shiftKey) { S.selectedNodes.clear() }
    S.selectedNodes.add(node.id); S.selectedEdge = null; updateSelectionVisuals()
    S.draggingNode = { id:node.id, startX:node.x, startY:node.y, mouseX:e.clientX, mouseY:e.clientY }
    closeCtxMenu()
  })
  el.addEventListener('dblclick', e => { e.stopPropagation(); openDetailPanel(node.id) })
  el.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation()
    S.ctxTargetId = node.id; showCtxMenu(e.clientX, e.clientY)
  })
  return el
}

function renderEdges() {
  const svg = document.getElementById('edge-svg')
  svg.querySelectorAll('.edge-group').forEach(el => el.remove())
  S.edges.forEach(edge => {
    const fn = S.nodes.find(n=>n.id===edge.fromId), tn = S.nodes.find(n=>n.id===edge.toId)
    if (!fn||!tn) return
    const fe = document.getElementById('node-'+edge.fromId), te = document.getElementById('node-'+edge.toId)
    if (!fe||!te) return
    const {x1,y1,x2,y2} = getEdgePoints(fn,tn,fe,te)
    const d = bezierPath(x1,y1,x2,y2), isSel = S.selectedEdge === edge.id
    const g = document.createElementNS('http://www.w3.org/2000/svg','g')
    g.className = 'edge-group'; g.dataset.id = edge.id
    // Wide transparent hit area
    const hit = document.createElementNS('http://www.w3.org/2000/svg','path')
    hit.setAttribute('d',d); hit.setAttribute('fill','none')
    hit.setAttribute('stroke','transparent'); hit.setAttribute('stroke-width','12'); hit.style.cursor='pointer'
    hit.style.pointerEvents='all'  // override parent SVG's pointer-events:none
    hit.addEventListener('click', ev => { ev.stopPropagation(); S.selectedEdge=edge.id; S.selectedNodes.clear(); updateSelectionVisuals() })
    hit.addEventListener('contextmenu', ev => { ev.preventDefault(); if(confirm('Delete connection?')){ S.edges=S.edges.filter(e=>e.id!==edge.id); renderEdges(); scheduleSave() } })
    g.appendChild(hit)
    const path = document.createElementNS('http://www.w3.org/2000/svg','path')
    path.className = 'edge-path'+(isSel?' selected':'')
    path.setAttribute('d',d); path.setAttribute('marker-end', isSel?'url(#arr-sel)':'url(#arr)')
    g.appendChild(path)
    if (edge.label) {
      const txt = document.createElementNS('http://www.w3.org/2000/svg','text')
      txt.className='edge-label'; txt.setAttribute('x',(x1+x2)/2); txt.setAttribute('y',(y1+y2)/2-5)
      txt.setAttribute('text-anchor','middle'); txt.textContent=edge.label
      g.appendChild(txt)
    }
    svg.appendChild(g)
  })
}

function getEdgePoints(fn,tn,fe,te) {
  return { x1:fn.x+(fe.offsetWidth||220), y1:fn.y+(fe.offsetHeight||80)/2, x2:tn.x, y2:tn.y+(te.offsetHeight||80)/2 }
}
function bezierPath(x1,y1,x2,y2) {
  // Cap control point offset at 300px so long-distance edges
  // don't produce gigantic curves that look like spiral fans
  const dx = Math.min(Math.abs(x2-x1)*0.5, 300)
  return `M ${x1} ${y1} C ${x1+dx} ${y1}, ${x2-dx} ${y2}, ${x2} ${y2}`
}

// ── Connection ────────────────────────────────────────
function startConnection(nodeId) {
  S.connectingFrom = nodeId
  document.getElementById('node-'+nodeId)?.classList.add('connecting-source')
}

function handleConnectClick(nodeId) {
  if (!S.connectingFrom) { startConnection(nodeId); return }
  if (S.connectingFrom === nodeId) { cancelConnection(); return }
  const exists = S.edges.some(e=>(e.fromId===S.connectingFrom&&e.toId===nodeId)||(e.fromId===nodeId&&e.toId===S.connectingFrom))
  if (!exists) { S.edges.push({ id:uid(), fromId:S.connectingFrom, toId:nodeId, label:'' }); scheduleSave() }
  document.getElementById('node-'+S.connectingFrom)?.classList.remove('connecting-source')
  S.connectingFrom = null; renderEdges()
}

function cancelConnection() {
  if (S.connectingFrom) {
    document.getElementById('node-'+S.connectingFrom)?.classList.remove('connecting-source')
    S.connectingFrom = null
  }
  const d = document.getElementById('drag-edge'); if (d) d.style.display='none'
}

// ── Event listeners (Figma-style) ─────────────────────
function initEventListeners() {
  const wrap = document.getElementById('canvas-wrap')

  // ── MOUSEDOWN ──────────────────────────────────────
  wrap.addEventListener('mousedown', e => {

    // Middle mouse button → start pan
    if (e.button === 1) {
      e.preventDefault()
      startPan(e)
      return
    }

    if (e.button !== 0) return

    // Space held → pan with left button (fallback)
    if (S.spaceDown) { startPan(e); return }

    const onCanvas = (
      e.target === wrap ||
      e.target.id === 'grid-canvas' ||
      e.target.id === 'board' ||
      e.target.id === 'edge-svg'
    )

    if (onCanvas) {
      // Pending node placement
      if (S.pendingNodeData) { placeNodeAtCursor(e); return }
      // Cancel active connection
      if (S.connectingFrom) { cancelConnection(); return }
      // Clear selection + start marquee
      S.selectedNodes.clear(); S.selectedEdge = null
      updateSelectionVisuals(); closeCtxMenu()
      startMarquee(e)
    }
  })

  // ── MOUSEMOVE ──────────────────────────────────────
  wrap.addEventListener('mousemove', e => {
    if (S.draggingNode) { dragNode(e); return }
    if (S.isPanning)    { doPan(e); return }
    if (S.marquee)      { updateMarquee(e); return }
    if (S.connectingFrom) { updateDragEdge(e) }
    // cursor hint for pending placement
    if (S.pendingNodeData) wrap.style.cursor = 'crosshair'
  })

  // ── MOUSEUP ────────────────────────────────────────
  wrap.addEventListener('mouseup', e => {
    if (S.draggingNode) { S.draggingNode = null; scheduleSave() }
    if (S.isPanning)    { endPan() }
    if (S.marquee)      { finishMarquee() }

    // Releasing on a port while connecting
    if (S.connectingFrom && e.target.classList.contains('node-port')) {
      const tid = e.target.dataset.id
      if (tid && tid !== S.connectingFrom) handleConnectClick(tid)
      else cancelConnection()
    }
  })

  // Prevent middle mouse scroll-autoscroll icon
  wrap.addEventListener('auxclick', e => { if (e.button===1) e.preventDefault() })

  // ── WHEEL → zoom toward cursor ─────────────────────
  wrap.addEventListener('wheel', e => {
    e.preventDefault()
    const delta   = e.deltaY > 0 ? 0.9 : 1.1
    const newZoom = Math.max(0.15, Math.min(2.5, S.zoom * delta))
    const rect    = wrap.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    S.panX = mx - (mx - S.panX) * (newZoom / S.zoom)
    S.panY = my - (my - S.panY) * (newZoom / S.zoom)
    S.zoom = newZoom
    applyViewport(); renderEdges()
  }, { passive: false })

  wrap.addEventListener('contextmenu', e => e.preventDefault())

  // ── KEYBOARD ───────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return
    if (e.code === 'Space') {
      e.preventDefault()
      S.spaceDown = true
      document.getElementById('canvas-wrap').style.cursor = 'grab'
    }
    if (e.key==='c'||e.key==='C') setTool('connect')
    if (e.key==='f'||e.key==='F') fitView()
    if (e.key==='n'||e.key==='N') openNodeModal()
    if ((e.key==='Delete'||e.key==='Backspace') && !e.target.closest('.modal')) deleteSelected()
    if (e.key==='Escape') {
      cancelConnection(); cancelPendingNode()
      closeCtxMenu(); closeDetailPanel(); closeProjectsPanel()
      setTool('select')
    }
  })
  document.addEventListener('keyup', e => {
    if (e.code === 'Space') {
      S.spaceDown = false
      if (!S.isPanning && !S.pendingNodeData)
        document.getElementById('canvas-wrap').style.cursor = S.tool==='connect' ? 'crosshair' : 'default'
    }
  })
  document.addEventListener('click', () => closeCtxMenu())
}

// ── Pan ────────────────────────────────────────────────
function startPan(e) {
  S.isPanning = true
  S.panStart  = { x: e.clientX - S.panX, y: e.clientY - S.panY }
  document.getElementById('canvas-wrap').style.cursor = 'grabbing'
}
function doPan(e) {
  S.panX = e.clientX - S.panStart.x
  S.panY = e.clientY - S.panStart.y
  applyViewport(); renderEdges()
}
function endPan() {
  S.isPanning = false
  const cur = S.spaceDown ? 'grab' : S.tool==='connect' ? 'crosshair' : 'default'
  document.getElementById('canvas-wrap').style.cursor = cur
}

// ── Node drag ─────────────────────────────────────────
function dragNode(e) {
  const node = S.nodes.find(n => n.id === S.draggingNode.id); if (!node) return
  const dx = (e.clientX - S.draggingNode.mouseX) / S.zoom
  const dy = (e.clientY - S.draggingNode.mouseY) / S.zoom
  node.x = S.draggingNode.startX + dx; node.y = S.draggingNode.startY + dy
  const el = document.getElementById('node-'+node.id)
  if (el) { el.style.left = node.x+'px'; el.style.top = node.y+'px' }
  renderEdges()
}

// ── Marquee select ────────────────────────────────────
function startMarquee(e) {
  const wrap = document.getElementById('canvas-wrap')
  const rect = wrap.getBoundingClientRect()
  const bx = (e.clientX - rect.left - S.panX) / S.zoom
  const by = (e.clientY - rect.top  - S.panY) / S.zoom
  S.marquee = { startBX: bx, startBY: by, bx, by, bw: 0, bh: 0 }
  const el = document.getElementById('marquee')
  el.style.display = 'block'; el.style.left='0px'; el.style.top='0px'
  el.style.width='0px'; el.style.height='0px'
}

function updateMarquee(e) {
  const wrap = document.getElementById('canvas-wrap')
  const rect = wrap.getBoundingClientRect()
  const cx = (e.clientX - rect.left - S.panX) / S.zoom
  const cy = (e.clientY - rect.top  - S.panY) / S.zoom
  const m  = S.marquee
  m.bx = Math.min(cx, m.startBX); m.by = Math.min(cy, m.startBY)
  m.bw = Math.abs(cx - m.startBX); m.bh = Math.abs(cy - m.startBY)
  const el = document.getElementById('marquee')
  el.style.left   = m.bx + 'px'; el.style.top    = m.by + 'px'
  el.style.width  = m.bw + 'px'; el.style.height = m.bh + 'px'
}

function finishMarquee() {
  const m = S.marquee; S.marquee = null
  document.getElementById('marquee').style.display = 'none'
  if (!m || (m.bw < 4 && m.bh < 4)) return   // tiny click — don't select

  // Hit test all nodes
  S.nodes.forEach(node => {
    const nw = 220, nh = 80  // approximate node size
    const overlaps = !(node.x + nw < m.bx || node.x > m.bx + m.bw ||
                       node.y + nh < m.by || node.y > m.by + m.bh)
    if (overlaps) S.selectedNodes.add(node.id)
  })
  updateSelectionVisuals()
}

// ── Connection drag preview ───────────────────────────
function updateDragEdge(e) {
  const wrap = document.getElementById('canvas-wrap'), rect = wrap.getBoundingClientRect()
  const fn = S.nodes.find(n => n.id === S.connectingFrom); if (!fn) return
  const fe = document.getElementById('node-'+S.connectingFrom); if (!fe) return
  const x1 = fn.x + fe.offsetWidth, y1 = fn.y + fe.offsetHeight / 2
  const x2 = (e.clientX-rect.left-S.panX)/S.zoom, y2 = (e.clientY-rect.top-S.panY)/S.zoom
  const drag = document.getElementById('drag-edge')
  drag.setAttribute('d', bezierPath(x1,y1,x2,y2)); drag.style.display='block'
}

// ── Fit view ──────────────────────────────────────────
function fitView() {
  if (S.nodes.length === 0) return
  const wrap = document.getElementById('canvas-wrap'), W = wrap.clientWidth, H = wrap.clientHeight, pad = 60
  const xs = S.nodes.map(n=>n.x), ys = S.nodes.map(n=>n.y)
  const x2s = S.nodes.map(n=>n.x+(n.w||220)), y2s = S.nodes.map(n=>n.y+100)
  const minX=Math.min(...xs),maxX=Math.max(...x2s),minY=Math.min(...ys),maxY=Math.max(...y2s)
  const bW=maxX-minX||1, bH=maxY-minY||1
  S.zoom=Math.min(2,Math.max(0.15,Math.min((W-pad*2)/bW,(H-pad*2)/bH)))
  S.panX=(W-bW*S.zoom)/2-minX*S.zoom; S.panY=(H-bH*S.zoom)/2-minY*S.zoom
  applyViewport(); renderEdges()
}

// ── Tool management ───────────────────────────────────
function setTool(tool) {
  if (tool === 'node') { openNodeModal(); return }
  activateTool(tool)
}

function activateTool(tool) {
  S.tool = tool
  const wrap = document.getElementById('canvas-wrap')
  ;['select','connect'].forEach(t => {
    document.getElementById('tool-'+t)?.classList.toggle('active', t === tool)
  })
  wrap.style.cursor = tool === 'connect' ? 'crosshair' : 'default'
  if (tool !== 'connect') cancelConnection()
}

// ── Node placement ────────────────────────────────────
function cancelPendingNode() {
  S.pendingNodeData = null
  document.getElementById('canvas-wrap').style.cursor = 'default'
  document.getElementById('zoom-badge').textContent = Math.round(S.zoom*100)+'%'
  document.getElementById('zoom-badge').style.background = ''
  document.getElementById('zoom-badge').style.color = ''
  document.getElementById('zoom-badge').style.borderColor = ''
}

function placeNodeAtCursor(e) {
  if (!S.pendingNodeData) return
  const wrap = document.getElementById('canvas-wrap'), rect = wrap.getBoundingClientRect()
  S.pendingNodeData.x = (e.clientX-rect.left-S.panX)/S.zoom - 110
  S.pendingNodeData.y = (e.clientY-rect.top-S.panY)/S.zoom  - 40
  S.nodes.push(S.pendingNodeData)
  S.pendingNodeData = null
  activateTool('select')
  document.getElementById('zoom-badge').textContent = Math.round(S.zoom*100)+'%'
  document.getElementById('zoom-badge').style.background = ''
  document.getElementById('zoom-badge').style.color = ''
  document.getElementById('zoom-badge').style.borderColor = ''
  renderAll(); scheduleSave()
}

// ── Node modal ────────────────────────────────────────
function openNodeModal(editId = null) {
  S.editingNodeId = editId
  const node = editId ? S.nodes.find(n=>n.id===editId) : null
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
  const sel = document.getElementById('nm-project')
  sel.innerHTML = '<option value="">— No project —</option>'
  S.projects.forEach(p => {
    const opt = document.createElement('option'); opt.value=p.id; opt.textContent=p.name
    if (node && node.projectId===p.id) opt.selected=true
    sel.appendChild(opt)
  })
  S.modalColor = node ? (node.color||'#1e6fff') : '#1e6fff'
  updateSwatchSelection('nm-color-swatches', S.modalColor)
  onNodeTypeChange()
  document.getElementById('node-modal').style.display = 'flex'
  setTimeout(() => document.getElementById('nm-title').focus(), 50)
}

function onNodeTypeChange() {
  const t  = document.getElementById('nm-type').value
  const pf = document.getElementById('nm-phase-fields'), df = document.getElementById('nm-doc-fields')
  pf.style.cssText = (t==='phase'||t==='task'||t==='project') ? 'display:flex;flex-direction:column;gap:10px' : 'display:none'
  df.style.cssText = t==='doc' ? 'display:flex;flex-direction:column;gap:10px' : 'display:none'
}

function saveNodeModal() {
  const title = document.getElementById('nm-title').value.trim()
  if (!title) { alert('Title is required'); return }
  const tasks = document.getElementById('nm-tasks').value.split('\n').map(t=>t.trim()).filter(Boolean)
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
    Object.assign(S.nodes.find(n=>n.id===S.editingNodeId), data)
    closeModal('node-modal'); renderAll(); scheduleSave()
  } else {
    S.pendingNodeData = { id:uid(), w:220, x:0, y:0, ...data }
    closeModal('node-modal')
    document.getElementById('canvas-wrap').style.cursor = 'crosshair'
    const badge = document.getElementById('zoom-badge')
    badge.textContent = 'Click canvas to place — Esc cancels'
    badge.style.background = 'rgba(245,158,11,0.12)'
    badge.style.color = '#f5a623'; badge.style.borderColor = 'rgba(245,158,11,0.3)'
  }
}

// ── Projects ──────────────────────────────────────────
function openProjectsPanel() { document.getElementById('projects-panel').classList.toggle('open'); updateProjectsPanel() }
function closeProjectsPanel() { document.getElementById('projects-panel').classList.remove('open') }

function updateProjectsPanel() {
  const list = document.getElementById('projects-list'); list.innerHTML = ''
  S.projects.forEach(p => {
    const el = document.createElement('div'); el.className = 'proj-item'
    el.innerHTML = `
      <div class="proj-dot" style="background:${p.color}"></div>
      <span class="proj-name">${esc(p.name)}</span>
      <div class="proj-actions">
        <button class="proj-btn" onclick="event.stopPropagation();editProject('${p.id}')">Edit</button>
        <button class="proj-btn danger" onclick="event.stopPropagation();deleteProject('${p.id}')">Del</button>
      </div>`
    el.onclick = () => highlightProject(p.id)
    list.appendChild(el)
  })
}

function addProject() {
  S.editingProjectId = null
  document.getElementById('project-modal-title').textContent = 'New Project'
  document.getElementById('pm-name').value = ''; document.getElementById('pm-desc').value = ''
  S.projectModalColor = '#1e6fff'; updateSwatchSelection('pm-color-swatches', S.projectModalColor)
  document.getElementById('project-modal').style.display = 'flex'
  setTimeout(() => document.getElementById('pm-name').focus(), 50)
}

function editProject(id) {
  S.editingProjectId = id
  const p = S.projects.find(p=>p.id===id)
  document.getElementById('project-modal-title').textContent = 'Edit Project'
  document.getElementById('pm-name').value = p.name; document.getElementById('pm-desc').value = p.desc||''
  S.projectModalColor = p.color||'#1e6fff'; updateSwatchSelection('pm-color-swatches', S.projectModalColor)
  document.getElementById('project-modal').style.display = 'flex'
}

function saveProjectModal() {
  const name = document.getElementById('pm-name').value.trim(); if (!name) { alert('Name required'); return }
  const data = { name, desc:document.getElementById('pm-desc').value.trim(), color:S.projectModalColor }
  if (S.editingProjectId) Object.assign(S.projects.find(p=>p.id===S.editingProjectId), data)
  else S.projects.push({ id:uid(), ...data })
  closeModal('project-modal'); updateProjectsPanel(); renderNodes(); scheduleSave()
}

function deleteProject(id) {
  const p = S.projects.find(p=>p.id===id)
  if (!confirm(`Delete project "${p.name}"?`)) return
  S.projects = S.projects.filter(p=>p.id!==id)
  S.nodes.forEach(n => { if (n.projectId===id) n.projectId=null })
  updateProjectsPanel(); renderNodes(); scheduleSave()
}

function highlightProject(id) {
  S.selectedNodes.clear()
  S.nodes.filter(n=>n.projectId===id).forEach(n=>S.selectedNodes.add(n.id))
  updateSelectionVisuals()
}

// ── Detail panel ──────────────────────────────────────
function openDetailPanel(nodeId) {
  const node = S.nodes.find(n=>n.id===nodeId); if (!node) return
  const proj  = S.projects.find(p=>p.id===node.projectId)
  const color = node.color||(proj?proj.color:'#1e6fff')
  const tasks = node.tasks||[]
  const hasLink = node.url||node.path
  const href    = node.url||(node.path?'file://'+node.path:null)
  document.getElementById('detail-title').textContent = node.title
  document.getElementById('detail-body').innerHTML = `
    ${proj?`<div class="dp-section"><div class="dp-label">Project</div><div class="dp-value" style="color:${proj.color}">⬡ ${esc(proj.name)}</div></div>`:''}
    <div class="dp-section" style="display:flex;gap:8px;align-items:center">
      <div style="background:${color};width:10px;height:10px;border-radius:50%"></div>
      <span style="font-size:11px;color:var(--text3)">${node.type}</span>
      ${node.status?`<span class="node-status st-${node.status}" style="margin-left:auto">${node.status}</span>`:''}
    </div>
    ${(node.startDate||node.endDate)?`<div class="dp-section"><div class="dp-label">Dates</div><div class="dp-value">${[node.startDate,node.endDate].filter(Boolean).map(fmtDate).join(' → ')}</div></div>`:''}
    ${node.milestone?`<div class="dp-section"><div class="dp-label">Milestone</div><div class="dp-milestone">★ ${esc(node.milestone)}</div></div>`:''}
    ${tasks.length?`<div class="dp-section"><div class="dp-label">Tasks (${tasks.length})</div><ul class="dp-task-list">${tasks.map(t=>`<li>${esc(t)}</li>`).join('')}</ul></div>`:''}
    ${node.notes?`<div class="dp-section"><div class="dp-label">Notes</div><div class="dp-value" style="white-space:pre-wrap">${esc(node.notes)}</div></div>`:''}
    ${hasLink?`<div class="dp-section"><div class="dp-label">Document</div><a href="${esc(href)}" target="_blank" style="color:var(--accent-light);font-size:12px;word-break:break-all">${esc(node.url||node.path)} ↗</a></div>`:''}
    <div class="dp-btn-row">
      <button class="full-btn" onclick="openNodeModal('${node.id}')">Edit node</button>
      <button class="full-btn" style="color:var(--s-blocked)" onclick="deleteNode('${node.id}');closeDetailPanel()">Delete</button>
    </div>`
  document.getElementById('detail-panel').classList.add('open')
}
function closeDetailPanel() { document.getElementById('detail-panel').classList.remove('open') }

// ── Selection ─────────────────────────────────────────
function updateSelectionVisuals() {
  document.querySelectorAll('.node').forEach(el => {
    el.classList.toggle('selected', S.selectedNodes.has(el.id.replace('node-','')))
  })
  document.querySelectorAll('.edge-path').forEach(el => {
    el.classList.toggle('selected', el.closest('.edge-group')?.dataset.id === S.selectedEdge)
  })
}

function deleteSelected() {
  if (S.selectedNodes.size > 0) {
    if (!confirm(`Delete ${S.selectedNodes.size} node(s)?`)) return
    S.selectedNodes.forEach(id => { S.nodes=S.nodes.filter(n=>n.id!==id); S.edges=S.edges.filter(e=>e.fromId!==id&&e.toId!==id) })
    S.selectedNodes.clear()
  }
  if (S.selectedEdge) { S.edges=S.edges.filter(e=>e.id!==S.selectedEdge); S.selectedEdge=null }
  renderAll(); scheduleSave()
}

function deleteNode(id) {
  S.nodes=S.nodes.filter(n=>n.id!==id); S.edges=S.edges.filter(e=>e.fromId!==id&&e.toId!==id)
  S.selectedNodes.delete(id); renderAll(); scheduleSave()
}

// ── Context menu ──────────────────────────────────────
function showCtxMenu(x,y) {
  const m=document.getElementById('ctx-menu'); m.style.left=x+'px'; m.style.top=y+'px'; m.style.display='block'
  if (!S.selectedNodes.has(S.ctxTargetId)) { S.selectedNodes.clear(); S.selectedNodes.add(S.ctxTargetId); updateSelectionVisuals() }
}
function closeCtxMenu() { document.getElementById('ctx-menu').style.display='none' }
function ctxEdit()      { openNodeModal(S.ctxTargetId); closeCtxMenu() }
function ctxConnect()   { setTool('connect'); startConnection(S.ctxTargetId); closeCtxMenu() }
function ctxDelete()    { S.selectedNodes.add(S.ctxTargetId); deleteSelected(); closeCtxMenu() }
function ctxDuplicate() {
  const src=S.nodes.find(n=>n.id===S.ctxTargetId); if(!src) return
  S.nodes.push({...JSON.parse(JSON.stringify(src)),id:uid(),x:src.x+30,y:src.y+30})
  renderAll(); scheduleSave(); closeCtxMenu()
}

// ── Minimap ───────────────────────────────────────────
function drawMinimap() {
  const canvas=document.getElementById('minimap'), ctx=canvas.getContext('2d')
  const W=canvas.width=160, H=canvas.height=100
  ctx.clearRect(0,0,W,H); ctx.fillStyle='#07080F'; ctx.fillRect(0,0,W,H)
  if (S.nodes.length===0) return
  const xs=S.nodes.map(n=>n.x),ys=S.nodes.map(n=>n.y),x2s=S.nodes.map(n=>n.x+220),y2s=S.nodes.map(n=>n.y+80)
  const minX=Math.min(...xs)-40,minY=Math.min(...ys)-40,maxX=Math.max(...x2s)+40,maxY=Math.max(...y2s)+40
  const bW=maxX-minX||1,bH=maxY-minY||1,scale=Math.min(W/bW,H/bH)*0.9
  const offX=(W-bW*scale)/2-minX*scale,offY=(H-bH*scale)/2-minY*scale
  S.nodes.forEach(n=>{ const c=n.color||(S.projects.find(p=>p.id===n.projectId)?.color||'#1e6fff'); ctx.fillStyle=c+'88'; ctx.fillRect(n.x*scale+offX,n.y*scale+offY,220*scale,40*scale) })
  const wrap=document.getElementById('canvas-wrap')
  ctx.strokeStyle='rgba(0,200,224,0.5)'; ctx.lineWidth=1
  ctx.strokeRect((-S.panX/S.zoom)*scale+offX,(-S.panY/S.zoom)*scale+offY,(wrap.clientWidth/S.zoom)*scale,(wrap.clientHeight/S.zoom)*scale)
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('minimap')?.addEventListener('click', e => {
    const canvas=document.getElementById('minimap'),rect=canvas.getBoundingClientRect()
    if(S.nodes.length===0) return
    const xs=S.nodes.map(n=>n.x),ys=S.nodes.map(n=>n.y),x2s=S.nodes.map(n=>n.x+220),y2s=S.nodes.map(n=>n.y+80)
    const minX=Math.min(...xs)-40,minY=Math.min(...ys)-40,bW=Math.max(...x2s)+40-minX,bH=Math.max(...y2s)+40-minY
    const wrap=document.getElementById('canvas-wrap')
    const wx=minX+(e.clientX-rect.left)/canvas.width*bW, wy=minY+(e.clientY-rect.top)/canvas.height*bH
    S.panX=wrap.clientWidth/2-wx*S.zoom; S.panY=wrap.clientHeight/2-wy*S.zoom
    applyViewport(); renderEdges()
  })
  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('mousedown', e => { if(e.target===o) o.style.display='none' })
  })
})

// ── Color swatches ────────────────────────────────────
function buildColorSwatches(containerId, stateKey) {
  const container = document.getElementById(containerId)
  COLORS.forEach(c => {
    const sw = document.createElement('div'); sw.className='swatch'+(S[stateKey]===c?' selected':'')
    sw.style.background=c; sw.dataset.color=c
    sw.onclick = () => { S[stateKey]=c; updateSwatchSelection(containerId,c) }
    container.appendChild(sw)
  })
}
function updateSwatchSelection(containerId, color) {
  document.querySelectorAll(`#${containerId} .swatch`).forEach(sw => sw.classList.toggle('selected', sw.dataset.color===color))
}
function closeModal(id) { document.getElementById(id).style.display='none' }

// ── Utils ─────────────────────────────────────────────
function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,6) }
function esc(s) { if(!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function trunc(s,n) { return s&&s.length>n?s.slice(0,n)+'…':(s||'') }
function fmtDate(d) {
  if(!d) return ''; const p=d.split('-'); if(p.length<2) return d
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(p[1])-1]+' '+p[0].slice(2)
}
