// Establish canvas and rendering context
const canvas = document.getElementById('game-canvas')
const ctx = canvas.getContext('2d')

// Define mutable tile size mapping and zoom
let TILE_SIZE = 82
let CAMERA_PITCH = 20
let WALL_HEIGHT = 2.0
let OBS_HEIGHT = 1.5
let ZOOM = 1.4
let ROTATION = 0

// Define camera offset and drag state
let cameraX = 0
let cameraY = 0
let isDragging = false
let dragStartX = 0
let dragStartY = 0

// Define map dimensions and initialize a blank floor plane
let MAP_ROWS = 12
let MAP_COLS = 12
let levelMap = Array.from({ length: MAP_ROWS }, () => Array(MAP_COLS).fill(0))

// Define grid scaling arrays representing physical tile dimensions
let colWidths = Array(MAP_COLS).fill(1.0)
let rowDepths = Array(MAP_ROWS).fill(1.0)

// Resize the grid dynamically while preserving existing tile data
function resizeGrid(newCols, newRows) {
    if (typeof saveState === 'function') saveState()
    
    const newMap = Array.from({ length: newRows }, () => Array(newCols).fill(0))
    for (let r = 0; r < Math.min(MAP_ROWS, newRows); r++) {
        for (let c = 0; c < Math.min(MAP_COLS, newCols); c++) {
            newMap[r][c] = levelMap[r][c]
        }
    }
    
    MAP_COLS = newCols
    MAP_ROWS = newRows
    levelMap = newMap
    colWidths = Array(MAP_COLS).fill(1.0)
    rowDepths = Array(MAP_ROWS).fill(1.0)
    
    // Nudge the player bounds so they don't get trapped off-screen if the level shrinks
    if (player.x >= MAP_COLS) player.x = MAP_COLS - 0.5
    if (player.y >= MAP_ROWS) player.y = MAP_ROWS - 0.5
    
    selectedGroups = []
    const btnCombine = document.getElementById('btn-combine')
    if (btnCombine) btnCombine.style.display = 'none'
    
    if (typeof autoFitLevel === 'function') autoFitLevel()
}

// Helper to calculate accumulated physical positions along the grid
function getAccumulated(coord, sizes) {
    let acc = 0
    const intCoord = Math.floor(coord)
    for (let i = 0; i < intCoord; i++) {
        acc += sizes[i] || 1.0
    }
    acc += (coord - intCoord) * (sizes[intCoord] || 1.0)
    return acc
}

// Base map tile integer IDs
const tileColors = { 0: '#666677', 1: '#444455', 2: '#554444', 3: '#666677', 4: '#885544', 5: '#444455' }
const tileHeights = { 0: 0, 1: WALL_HEIGHT, 2: 0, 3: 0, 4: OBS_HEIGHT, 5: WALL_HEIGHT }
const tileCollisions = { 0: false, 1: true, 2: true, 3: false, 4: true, 5: true }

// Generate dynamic properties for the 15 bitmask composite wall states (101-115) and combined states (501-515)
for (let i = 1; i <= 15; i++) {
    tileColors[100 + i] = '#444455'; tileHeights[100 + i] = WALL_HEIGHT; tileCollisions[100 + i] = true
    tileColors[500 + i] = '#444455'; tileHeights[500 + i] = WALL_HEIGHT; tileCollisions[500 + i] = true
}

// Define character starting position, speed, and facing direction
const player = {
    x: MAP_COLS / 2,
    y: MAP_ROWS / 2,
    color: '#ff0044',
    speed: 0.08,
    facing: 'down' // Tracks 'up', 'down', 'left', 'right'
}

// Track active key states for movement
const keys = {
    w: false, a: false, s: false, d: false,
    ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false
}

// Update key state on keydown
window.addEventListener('keydown', (e) => {
    if (keys.hasOwnProperty(e.key)) {
        keys[e.key] = true
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault()
        }
    }
})

// State variables for interactive tile editing and object placement
let selectedGroups = []
let hoveredGroup = null
let isHoverError = false
let isDraggingTile = false
let dragAnchorCol = 0
let dragAnchorRow = 0
let placeMode = null
let isPainting = false
const obstacleMemory = {} // Remembers the original floor tile ID underneath moved obstacles

// Helper to group contiguous obstacle tiles (ID 4) logically together
function getObstacleGroup(col, row) {
    const group = []
    const visited = new Set()
    const queue = [{c: col, r: row}]
    
    while (queue.length > 0) {
        const curr = queue.shift()
        const key = `${curr.c},${curr.r}`
        if (visited.has(key)) continue
        visited.add(key)
        
        if (curr.r >= 0 && curr.r < MAP_ROWS && curr.c >= 0 && curr.c < MAP_COLS && levelMap[curr.r][curr.c] === 4) {
            group.push({col: curr.c, row: curr.r, face: 'top'})
            queue.push({c: curr.c - 1, r: curr.r})
            queue.push({c: curr.c + 1, r: curr.r})
            queue.push({c: curr.c, r: curr.r - 1})
            queue.push({c: curr.c, r: curr.r + 1})
        }
    }
    return group
}

// Helper to group adjacent combined wall tiles into a single selectable unit
function getCombinedGroup(col, row, face) {
    const group = []
    const id = levelMap[row][col]
    
    group.push({ col, row, face })
    if (id !== 5 && !(id >= 501 && id <= 515)) return group
    
    const baseFace = Math.floor(face)
    
    // Scan outward aggressively in both directions to capture the entire combined wall group of the same ID
    if (baseFace === 0 || baseFace === 2) {
        let c = col + 1; while (c < MAP_COLS && levelMap[row][c] === id) { group.push({ col: c, row, face: baseFace }); c++ }
        c = col - 1; while (c >= 0 && levelMap[row][c] === id) { group.push({ col: c, row, face: baseFace }); c-- }
    } else if (baseFace === 1 || baseFace === 3) {
        let r = row + 1; while (r < MAP_ROWS && levelMap[r][col] === id) { group.push({ col, row: r, face: baseFace }); r++ }
        r = row - 1; while (r >= 0 && levelMap[r][col] === id) { group.push({ col, row: r, face: baseFace }); r-- }
    }
    return group
}

// Evaluate if two individual tile faces are geometrically valid to combine
function isValidCombine(t1, t2) {
    if (!t1 || !t2) return false
    const base1 = Math.floor(t1.face)
    const base2 = Math.floor(t2.face)
    if (base1 !== base2) return false // Blocks perpendicular seams

    // Enforce strict physical adjacency, but freely allow main faces to connect with corner sub-faces
    if (base1 === 0 || base1 === 2) { 
        return t1.row === t2.row && Math.abs(t1.col - t2.col) === 1
    } else if (base1 === 1 || base1 === 3) { 
        return t1.col === t2.col && Math.abs(t1.row - t2.row) === 1
    }
    return false
}

// Helper to evaluate if a tile face matches a target face, allowing base integers to act as wildcards
function matchFace(f1, f2) {
    if (f1 === f2) return true
    if (typeof f1 !== 'number' || typeof f2 !== 'number') return false
    if (Math.floor(f1) !== Math.floor(f2)) return false
    return f1 === Math.floor(f1) || Math.abs(f1 - f2) < 0.01
}

// Check if any tiles within two groups can validly connect
function canCombineGroups(g1, g2) {
    for (let t1 of g1) {
        for (let t2 of g2) {
            if (isValidCombine(t1, t2)) return true
        }
    }
    return false
}

// Helper to check if a point is inside a polygon array of {x, y} vertices
function isPointInPoly(pt, poly) {
    let inside = false
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        let xi = poly[i].x, yi = poly[i].y
        let xj = poly[j].x, yj = poly[j].y
        let intersect = ((yi > pt.y) !== (yj > pt.y)) && (pt.x < (xj - xi) * (pt.y - yi) / (yj - yi) + xi)
        if (intersect) inside = !inside
    }
    return inside
}

// Transform raw mouse coordinates to isometric screen space
function getMousePos(e) {
    const rect = canvas.getBoundingClientRect()
    const rawX = e.clientX - rect.left
    const rawY = e.clientY - rect.top
    return {
        x: (rawX - (canvas.width / 2 + cameraX)) / ZOOM,
        y: (rawY - (canvas.height / 2 + cameraY)) / ZOOM
    }
}

// Helper to generate an array of dynamic footprint polygons based on bitmask combinations
function getTileFootprint(col, row) {
    const id = levelMap[row][col]
    
    let mask = 0
    if (id >= 11 && id <= 14) mask = 1 << (id - 11) // Safely port legacy maps
    if (id >= 51 && id <= 54) mask = 1 << (id - 51)
    if (id >= 101 && id <= 115) mask = id - 100
    if (id >= 501 && id <= 515) mask = id - 500

    if (mask > 0) {
        const t1 = 0.3, t2 = 0.7
        if (mask === 1) return [[{x:0,y:0}, {x:1,y:0}, {x:1,y:t1}, {x:0,y:t1}]]
        if (mask === 2) return [[{x:t2,y:0}, {x:1,y:0}, {x:1,y:1}, {x:t2,y:1}]]
        if (mask === 4) return [[{x:0,y:t2}, {x:1,y:t2}, {x:1,y:1}, {x:0,y:1}]]
        if (mask === 8) return [[{x:0,y:0}, {x:t1,y:0}, {x:t1,y:1}, {x:0,y:1}]]
        if (mask === 3) return [[{x:0,y:0}, {x:1,y:0}, {x:1,y:1}, {x:t2,y:1}, {x:t2,y:t1}, {x:0,y:t1}]]
        if (mask === 6) return [[{x:t2,y:0}, {x:1,y:0}, {x:1,y:1}, {x:0,y:1}, {x:0,y:t2}, {x:t2,y:t2}]]
        if (mask === 12) return [[{x:0,y:0}, {x:t1,y:0}, {x:t1,y:t2}, {x:1,y:t2}, {x:1,y:1}, {x:0,y:1}]]
        if (mask === 9) return [[{x:0,y:0}, {x:1,y:0}, {x:1,y:t1}, {x:t1,y:t1}, {x:t1,y:1}, {x:0,y:1}]]
        if (mask === 5) return [[{x:0,y:0}, {x:1,y:0}, {x:1,y:t1}, {x:0,y:t1}], [{x:0,y:t2}, {x:1,y:t2}, {x:1,y:1}, {x:0,y:1}]]
        if (mask === 10) return [[{x:t2,y:0}, {x:1,y:0}, {x:1,y:1}, {x:t2,y:1}], [{x:0,y:0}, {x:t1,y:0}, {x:t1,y:1}, {x:0,y:1}]]
        if (mask === 7) return [[{x:0,y:0}, {x:1,y:0}, {x:1,y:1}, {x:0,y:1}, {x:0,y:t2}, {x:t2,y:t2}, {x:t2,y:t1}, {x:0,y:t1}]]
        if (mask === 14) return [[{x:t2,y:0}, {x:1,y:0}, {x:1,y:1}, {x:0,y:1}, {x:0,y:0}, {x:t1,y:0}, {x:t1,y:t2}, {x:t2,y:t2}]]
        if (mask === 13) return [[{x:0,y:0}, {x:1,y:0}, {x:1,y:t1}, {x:t1,y:t1}, {x:t1,y:t2}, {x:1,y:t2}, {x:1,y:1}, {x:0,y:1}]]
        if (mask === 11) return [[{x:0,y:0}, {x:1,y:0}, {x:1,y:1}, {x:t2,y:1}, {x:t2,y:t1}, {x:t1,y:t1}, {x:t1,y:1}, {x:0,y:1}]]
        if (mask === 15) return [
            [{x:0,y:0}, {x:1,y:0}, {x:1,y:t1}, {x:0,y:t1}], [{x:t2,y:0}, {x:1,y:0}, {x:1,y:1}, {x:t2,y:1}],
            [{x:0,y:t2}, {x:1,y:t2}, {x:1,y:1}, {x:0,y:1}], [{x:0,y:0}, {x:t1,y:0}, {x:t1,y:1}, {x:0,y:1}]
        ]
    } else if (id === 1 || id === 5) {
        const inset = 0.35, i0 = inset, i1 = 1.0 - inset
        const cT = getTileElevation(col, row - 1) > 0, cR = getTileElevation(col + 1, row) > 0
        const cB = getTileElevation(col, row + 1) > 0, cL = getTileElevation(col - 1, row) > 0
        let rawPts = []
        if (cT) rawPts.push({x: i0, y: i0}, {x: i0, y: 0}, {x: i1, y: 0}, {x: i1, y: i0})
        else rawPts.push({x: i0, y: i0}, {x: i1, y: i0})
        if (cR) rawPts.push({x: i1, y: i0}, {x: 1, y: i0}, {x: 1, y: i1}, {x: i1, y: i1})
        else rawPts.push({x: i1, y: i0}, {x: i1, y: i1})
        if (cB) rawPts.push({x: i1, y: i1}, {x: i1, y: 1}, {x: i0, y: 1}, {x: i0, y: i1})
        else rawPts.push({x: i1, y: i1}, {x: i0, y: i1})
        if (cL) rawPts.push({x: i0, y: i1}, {x: 0, y: i1}, {x: 0, y: i0}, {x: i0, y: i0})
        else rawPts.push({x: i0, y: i1}, {x: i0, y: i0})
        let unique = []
        for (let i = 0; i < rawPts.length; i++) {
            let curr = rawPts[i]
            let prev = unique.length > 0 ? unique[unique.length - 1] : rawPts[rawPts.length - 1]
            if (Math.abs(curr.x - prev.x) > 0.001 || Math.abs(curr.y - prev.y) > 0.001) unique.push(curr)
        }
        if (unique.length > 1) {
            let first = unique[0], last = unique[unique.length - 1]
            if (Math.abs(first.x - last.x) < 0.001 && Math.abs(first.y - last.y) < 0.001) unique.pop()
        }
        let pts = []
        for (let i = 0; i < unique.length; i++) {
            let prev = unique[(i - 1 + unique.length) % unique.length]
            let curr = unique[i]
            let next = unique[(i + 1) % unique.length]
            let cross = (curr.x - prev.x) * (next.y - curr.y) - (curr.y - prev.y) * (next.x - curr.x)
            if (Math.abs(cross) > 0.001) pts.push(curr)
        }
        return [pts]
    }
    return [[{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}]]
}

// Extract bitmask value from tile ID
function getWallMask(id) {
    if (id >= 11 && id <= 14) return 1 << (id - 11)
    if (id >= 51 && id <= 54) return 1 << (id - 51)
    if (id >= 101 && id <= 115) return id - 100
    if (id >= 501 && id <= 515) return id - 500
    return 0
}

// Check if an adjacent tile physically shares and occludes a specific boundary edge
function hasFlushNeighbor(col, row, baseFace, px1, py1, px2, py2) {
    let nCol = col, nRow = row
    if (baseFace === 0) nRow -= 1
    else if (baseFace === 1) nCol += 1
    else if (baseFace === 2) nRow += 1
    else if (baseFace === 3) nCol -= 1

    if (nRow < 0 || nRow >= MAP_ROWS || nCol < 0 || nCol >= MAP_COLS) return false

    const id = levelMap[row][col]
    const nId = levelMap[nRow][nCol]
    const elev = tileHeights[id]
    const nElev = tileHeights[nId]

    if (nElev < elev) return false

    const mask = getWallMask(id)
    const nMask = getWallMask(nId)

    // Center walls only connect at the middle 0.35 to 0.65 span
    if (nMask === 0) {
        return mask === 0
    }

    const len = Math.hypot(px2 - px1, py2 - py1)
    if (len > 0.5) {
        // Full 1.0 edge requires the neighbor to have the opposite full edge bit
        if (baseFace === 0) return (nMask & 4) !== 0
        if (baseFace === 1) return (nMask & 8) !== 0
        if (baseFace === 2) return (nMask & 1) !== 0
        if (baseFace === 3) return (nMask & 2) !== 0
    } else {
        // Short 0.3 end-cap requires the neighbor to continue the same aligned strip
        if (baseFace === 0 || baseFace === 2) {
            if (px1 < 0.5 && px2 < 0.5) return (nMask & 8) !== 0
            if (px1 > 0.5 && px2 > 0.5) return (nMask & 2) !== 0
        } else {
            if (py1 < 0.5 && py2 < 0.5) return (nMask & 1) !== 0
            if (py1 > 0.5 && py2 > 0.5) return (nMask & 4) !== 0
        }
    }
    return false
}

// Evaluate if isometric mouse position intersects a specific tile's 3D geometry
function checkTileHit(col, row, mx, my) {
    const elevation = tileHeights[levelMap[row][col]]
    const accX0 = getAccumulated(col, colWidths)
    const accY0 = getAccumulated(row, rowDepths)
    const w = colWidths[col] || 1.0
    const h = rowDepths[row] || 1.0
    const pt = { x: mx, y: my }

    const polys = getTileFootprint(col, row)

    for (let pts of polys) {
        const tops = pts.map(p => project(accX0 + p.x * w, accY0 + p.y * h, elevation))
        const bots = pts.map(p => project(accX0 + p.x * w, accY0 + p.y * h, 0))
        
        if (isPointInPoly(pt, tops)) return 'top'

        for (let i = 0; i < tops.length; i++) {
            const next = (i + 1) % tops.length
            const dx = tops[next].x - tops[i].x
            
            const px1 = pts[i].x, py1 = pts[i].y
            const px2 = pts[next].x, py2 = pts[next].y
            
            const baseFace = (Math.abs(px1 - px2) < 0.001) ? (py1 > py2 ? 3 : 1) : (px1 < px2 ? 0 : 2)
            
            let isBoundary = false
            if (py1 === 0 && py2 === 0) isBoundary = true
            else if (px1 === 1 && px2 === 1) isBoundary = true
            else if (py1 === 1 && py2 === 1) isBoundary = true
            else if (px1 === 0 && px2 === 0) isBoundary = true

            let subFace = 0
            if (!isBoundary) {
                if (baseFace === 1 || baseFace === 3) subFace = (py1 < 0.5 && py2 < 0.5) ? 1 : 2
                else subFace = (px1 < 0.5 && px2 < 0.5) ? 1 : 2
            }
            const faceDir = baseFace + (subFace * 0.1)

            const isOccluded = isBoundary && hasFlushNeighbor(col, row, baseFace, px1, py1, px2, py2)

            if (elevation > 0 && dx < 0 && !isOccluded) {
                const sidePoly = [tops[i], tops[next], bots[next], bots[i]]
                if (isPointInPoly(pt, sidePoly)) return faceDir
            }
        }
    }
    return null
}

// Scan map to find the topmost tile under the mouse cursor
function getTileAtMouse(mx, my) {
    let foundTile = null

    // Pass 1: Ground level
    for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
            if (tileHeights[levelMap[row][col]] <= 0) {
                const hit = checkTileHit(col, row, mx, my)
                if (hit !== null) foundTile = { col, row, face: hit }
            }
        }
    }

    // Pass 2: Elevated elements (following topological order to respect depth)
    const safeRot = typeof ROTATION !== 'undefined' ? ROTATION : 0
    let cStart = 0, cEnd = MAP_COLS, cStep = 1
    let rStart = 0, rEnd = MAP_ROWS, rStep = 1

    if (safeRot === 90) {
        rStart = MAP_ROWS - 1; rEnd = -1; rStep = -1
    } else if (safeRot === 180) {
        cStart = MAP_COLS - 1; cEnd = -1; cStep = -1
        rStart = MAP_ROWS - 1; rEnd = -1; rStep = -1
    } else if (safeRot === 270) {
        cStart = MAP_COLS - 1; cEnd = -1; cStep = -1
    }

    for (let row = rStart; row !== rEnd; row += rStep) {
        for (let col = cStart; col !== cEnd; col += cStep) {
            if (tileHeights[levelMap[row][col]] > 0) {
                const hit = checkTileHit(col, row, mx, my)
                if (hit !== null) foundTile = { col, row, face: hit }
            }
        }
    }
    return foundTile
}

// Update key state on keyup
window.addEventListener('keyup', (e) => {
    if (keys.hasOwnProperty(e.key)) {
        keys[e.key] = false
    }
})

canvas.addEventListener('dblclick', (e) => {
    const pos = getMousePos(e)
    const clicked = getTileAtMouse(pos.x, pos.y)
    
    if (clicked) {
        const id = levelMap[clicked.row][clicked.col]
        const selIndex = selectedGroups.findIndex(g => g.some(t => t.col === clicked.col && t.row === clicked.row && (id === 4 || matchFace(t.face, clicked.face))))

        if (id === 4) {
            const group = getObstacleGroup(clicked.col, clicked.row)
            if (selIndex > -1) {
                selectedGroups.splice(selIndex, 1)
            } else {
                selectedGroups = [group]
            }
        } else if ((id === 1 || id === 5 || (id >= 11 && id <= 14) || (id >= 51 && id <= 54)) && clicked.face !== 'top') {
            const group = getCombinedGroup(clicked.col, clicked.row, clicked.face)
            
            if (selIndex > -1) {
                selectedGroups.splice(selIndex, 1)
            } else {
                if (selectedGroups.length > 0 && levelMap[selectedGroups[0][0].row][selectedGroups[0][0].col] === 4) {
                    selectedGroups = []
                }
                
                // Start fresh if two are already selected, or if the new click is geometrically invalid
                if (selectedGroups.length >= 2) {
                    selectedGroups = [group]
                } else if (selectedGroups.length === 1 && !canCombineGroups(selectedGroups[0], group)) {
                    selectedGroups = [group]
                } else {
                    selectedGroups.push(group)
                }
            }
        } else {
            selectedGroups = []
        }
    } else {
        selectedGroups = []
    }
    
    const btnCombine = document.getElementById('btn-combine')
    if (selectedGroups.length === 2) {
        btnCombine.style.display = 'block'
    } else {
        btnCombine.style.display = 'none'
    }

    // Manually trigger a mousemove event to immediately update cursor and hover states
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: e.clientY }))
})

// Process multi-group wall combining interaction
document.getElementById('btn-combine').addEventListener('click', () => {
    if (selectedGroups.length === 2) {
        const combineTiles = (group) => {
            group.forEach(t => {
                const oldId = levelMap[t.row][t.col]
                if (oldId === 1) levelMap[t.row][t.col] = 5
                else if (oldId >= 101 && oldId <= 115) levelMap[t.row][t.col] = oldId + 400
            })
        }
        combineTiles(selectedGroups[0])
        combineTiles(selectedGroups[1])
        selectedGroups = []
        document.getElementById('btn-combine').style.display = 'none'
    }
})

// Handle canvas mouse events for object placement, tile dragging, and camera panning
canvas.addEventListener('mousedown', (e) => {
    const pos = getMousePos(e)
    const clicked = getTileAtMouse(pos.x, pos.y)

    if (placeMode !== null) {
        if (clicked && (clicked.col !== Math.floor(player.x) || clicked.row !== Math.floor(player.y))) {
            if (typeof saveState === 'function') saveState()
            isPainting = true
            const currentId = levelMap[clicked.row][clicked.col]
            if (placeMode >= 101 && placeMode <= 115 && currentId >= 101 && currentId <= 115) {
                levelMap[clicked.row][clicked.col] = 100 + ((currentId - 100) | (placeMode - 100))
            } else if (placeMode >= 101 && placeMode <= 115 && currentId >= 501 && currentId <= 515) {
                levelMap[clicked.row][clicked.col] = 500 + ((currentId - 500) | (placeMode - 100))
            } else {
                levelMap[clicked.row][clicked.col] = placeMode
            }
        }
        return
    }

    // Check if the user is clicking anywhere on a currently selected shelf tile footprint
    if (clicked && selectedGroups.length === 1 && levelMap[clicked.row][clicked.col] === 4 && selectedGroups[0].some(t => t.col === clicked.col && t.row === clicked.row)) {
        if (typeof saveState === 'function') saveState()
        isDraggingTile = true
        dragAnchorCol = clicked.col
        dragAnchorRow = clicked.row
        canvas.style.cursor = 'move'
    } else {
        isDragging = true
        dragStartX = e.clientX - cameraX
        dragStartY = e.clientY - cameraY
        canvas.style.cursor = 'grabbing'
    }
})

window.addEventListener('mousemove', (e) => {
    const pos = getMousePos(e)
    const hovered = getTileAtMouse(pos.x, pos.y)
    
    let currentCursor = 'default'

    if (placeMode !== null) {
        if (hovered) {
            const isPlayerTile = hovered.col === Math.floor(player.x) && hovered.row === Math.floor(player.y)
            hoveredGroup = [{ col: hovered.col, row: hovered.row, face: 'top' }]
            isHoverError = isPlayerTile
            currentCursor = isPlayerTile ? 'not-allowed' : 'crosshair'
            if (isPainting && !isPlayerTile) {
                const currentId = levelMap[hovered.row][hovered.col]
                if (placeMode >= 101 && placeMode <= 115 && currentId >= 101 && currentId <= 115) {
                    levelMap[hovered.row][hovered.col] = 100 + ((currentId - 100) | (placeMode - 100))
                } else if (placeMode >= 101 && placeMode <= 115 && currentId >= 501 && currentId <= 515) {
                    levelMap[hovered.row][hovered.col] = 500 + ((currentId - 500) | (placeMode - 100))
                } else if (currentId !== placeMode) {
                    levelMap[hovered.row][hovered.col] = placeMode
                }
            }
        } else {
            hoveredGroup = null
            isHoverError = false
        }
        canvas.style.cursor = currentCursor
        return
    }

    if (isDraggingTile && selectedGroups.length === 1) {
        currentCursor = 'move'
        const selTiles = selectedGroups[0]
        
        // Validate if hovered is a valid target and calculate coordinate delta from drag anchor
        if (hovered && (hovered.col !== dragAnchorCol || hovered.row !== dragAnchorRow)) {
            const dCol = hovered.col - dragAnchorCol
            const dRow = hovered.row - dragAnchorRow

            // Translate entire obstacle group by offset to preserve multi-tile shape
            const newFootprint = selTiles.map(st => ({
                col: st.col + dCol,
                row: st.row + dRow,
                face: 'top'
            }))

            // Validate the translated footprint safely avoiding player and solid walls
            let isValid = true
            for (let pt of newFootprint) {
                if (pt.col < 0 || pt.col >= MAP_COLS || pt.row < 0 || pt.row >= MAP_ROWS) { isValid = false; break; }
                const tid = levelMap[pt.row][pt.col]
                const isSelf = selTiles.some(st => st.col === pt.col && st.row === pt.row)
                if (tid !== 0 && tid !== 2 && !isSelf) { isValid = false; break; }
                if (pt.col === Math.floor(player.x) && pt.row === Math.floor(player.y)) { isValid = false; break; }
            }

            if (isValid) {
                const newMemory = {}
                // Cache the floor tiles being overwritten
                for (let pt of newFootprint) {
                    const key = `${pt.col},${pt.row}`
                    if (selTiles.some(st => st.col === pt.col && st.row === pt.row)) {
                        newMemory[key] = obstacleMemory[key] !== undefined ? obstacleMemory[key] : (colWidths[pt.col] < 1 || rowDepths[pt.row] < 1 ? 2 : 0)
                    } else {
                        newMemory[key] = levelMap[pt.row][pt.col]
                    }
                }

                // Restore the old floor tiles not contained in the new footprint
                for (let st of selTiles) {
                    if (!newFootprint.some(nt => nt.col === st.col && nt.row === st.row)) {
                        const key = `${st.col},${st.row}`
                        const defaultFloorId = (colWidths[st.col] < 1 || rowDepths[st.row] < 1) ? 2 : 0
                        levelMap[st.row][st.col] = obstacleMemory[key] !== undefined ? obstacleMemory[key] : defaultFloorId
                        delete obstacleMemory[key]
                    }
                }

                // Commit the new obstacle footprint
                for (let pt of newFootprint) {
                    levelMap[pt.row][pt.col] = 4
                }

                for (let key in newMemory) {
                    obstacleMemory[key] = newMemory[key]
                }

                selectedGroups[0] = newFootprint
                dragAnchorCol = hovered.col
                dragAnchorRow = hovered.row
            }
        }
    } else if (isDragging) {
        currentCursor = 'grabbing'
        cameraX = e.clientX - dragStartX
        cameraY = e.clientY - dragStartY
    } else {
        // Track hovered groups and evaluate validation rules dynamically
        if (hovered) {
            const id = levelMap[hovered.row][hovered.col]
            if (id === 4) {
                hoveredGroup = getObstacleGroup(hovered.col, hovered.row)
                
                // Flag error if hovering an obstacle while any number of walls are selected
                if (selectedGroups.length > 0) {
                    const selId = levelMap[selectedGroups[0][0].row][selectedGroups[0][0].col]
                    if (selId === 1 || selId === 5 || (selId >= 11 && selId <= 14) || (selId >= 51 && selId <= 54)) {
                        isHoverError = true
                    } else {
                        isHoverError = false
                        if (selId === 4 && selectedGroups[0].some(t => t.col === hovered.col && t.row === hovered.row)) {
                            currentCursor = 'move'
                        } else {
                            currentCursor = 'pointer'
                        }
                    }
                } else {
                    isHoverError = false
                    currentCursor = 'pointer'
                }
            } else if ((id === 1 || id === 5 || (id >= 11 && id <= 14) || (id >= 51 && id <= 54)) && hovered.face !== 'top') {
                hoveredGroup = getCombinedGroup(hovered.col, hovered.row, hovered.face)
                
                // Cross-check valid connections if an item is already selected
                if (selectedGroups.length === 1) {
                    const selId = levelMap[selectedGroups[0][0].row][selectedGroups[0][0].col]
                    if (selId === 1 || selId === 5 || (selId >= 11 && selId <= 14) || (selId >= 51 && selId <= 54)) {
                        const isAlreadySelected = selectedGroups[0].some(t => t.col === hovered.col && t.row === hovered.row && matchFace(t.face, hovered.face))
                        if (!isAlreadySelected && !canCombineGroups(selectedGroups[0], hoveredGroup)) {
                            isHoverError = true
                        } else {
                            isHoverError = false
                            currentCursor = 'pointer'
                        }
                    } else if (selId === 4) {
                        // Flag error if hovering a wall while a shelf is selected
                        isHoverError = true
                    } else {
                        isHoverError = false
                        currentCursor = 'pointer'
                    }
                } else if (selectedGroups.length === 2) {
                    // Flag error if hovering a third wall when two are already selected
                    const isAlreadySelected = selectedGroups.some(g => g.some(t => t.col === hovered.col && t.row === hovered.row && matchFace(t.face, hovered.face)))
                    if (!isAlreadySelected) {
                        isHoverError = true
                    } else {
                        isHoverError = false
                        currentCursor = 'pointer'
                    }
                } else {
                    isHoverError = false
                    currentCursor = 'pointer'
                }
            } else {
                hoveredGroup = null
                isHoverError = false
            }
        } else {
            hoveredGroup = null
            isHoverError = false
        }
    }
    
    canvas.style.cursor = currentCursor
})

window.addEventListener('mouseup', () => {
    isDragging = false
    isDraggingTile = false
    isPainting = false
    canvas.style.cursor = placeMode !== null ? 'crosshair' : 'default'
})

// Map physical coordinates through cardinal rotation matrix to Isometric screen space
function project(accX, accY, elevation) {
    const centerW = colWidths.reduce((a, b) => a + b, 0) / 2
    const centerH = rowDepths.reduce((a, b) => a + b, 0) / 2
    
    const cx = accX - centerW
    const cy = accY - centerH
    
    // Failsafe safely defaults to 0 if the ROTATION variable declaration was missed
    const safeRot = typeof ROTATION !== 'undefined' ? ROTATION : 0
    const rad = safeRot * Math.PI / 180
    const cos = Math.round(Math.cos(rad))
    const sin = Math.round(Math.sin(rad))
    
    const rotX = cx * cos - cy * sin
    const rotY = cx * sin + cy * cos
    
    const safePitch = typeof CAMERA_PITCH !== 'undefined' ? CAMERA_PITCH : 20
    const pitchRad = safePitch * Math.PI / 180
    const tileWidth = TILE_SIZE
    const tileHeight = TILE_SIZE * Math.sin(pitchRad)
    
    // Disconnect elevation height multiplier from camera pitch projection
    const zHeight = TILE_SIZE
    
    let isoX, isoY
    
    if (safePitch > 40) {
        // Render directly top-down 2D map view without isometric diamond distortion
        isoX = rotX * TILE_SIZE
        isoY = rotY * TILE_SIZE
    } else if (safePitch === 0) {
        // Render 2D side-scroller view flattening depth purely to the Z-buffer
        isoX = rotX * TILE_SIZE
        isoY = -(elevation * zHeight)
    } else {
        // By omitting the center offset here, we perfectly anchor the level center to 0,0
        isoX = (rotX - rotY) * (tileWidth / 2)
        isoY = (rotX + rotY) * (tileHeight / 2) - (elevation * (zHeight / 2))
    }
    
    // Remove artificial elevation bias from topological depth sorting
    return { 
        x: isoX, 
        y: isoY, 
        depth: rotX + rotY 
    }
}

// Helper to fetch logical tile elevation safely
function getTileElevation(col, row) {
    if (row < 0 || row >= MAP_ROWS || col < 0 || col >= MAP_COLS) return -1
    const tileId = levelMap[row][col]
    return tileHeights[tileId]
}

// Draw individual isometric polygon block dynamically culling hidden 3D faces
function drawTile(col, row, color, elevation, isBaseOverride = false) {
    const id = levelMap[row][col]

    const accX0 = getAccumulated(col, colWidths)
    const accY0 = getAccumulated(row, rowDepths)
    const w = colWidths[col] || 1.0
    const h = rowDepths[row] || 1.0

    const polys = isBaseOverride ? [[{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}]] : getTileFootprint(col, row)

    let facesToDraw = []
    let allTops = []
    let allBots = []

    // Pass 1: Pool all faces across all polygon arrays within this grid coordinate
    for (let pIdx = 0; pIdx < polys.length; pIdx++) {
        const pts = polys[pIdx]
        const tops = pts.map(p => project(accX0 + p.x * w, accY0 + p.y * h, elevation))
        const bots = pts.map(p => project(accX0 + p.x * w, accY0 + p.y * h, 0))
        allTops.push(tops)
        allBots.push(bots)

        if (elevation > 0) {
            const pAccX = getAccumulated(player.x, colWidths)
            const pAccY = getAccumulated(player.y, rowDepths)
            const pProj = project(pAccX, pAccY, 0)
            
            const tAccX = getAccumulated(col + 0.5, colWidths)
            const tAccY = getAccumulated(row + 0.5, rowDepths)
            const tProj = project(tAccX, tAccY, 0)
            
            if (tProj.depth > pProj.depth) {
                const minX = Math.min(...tops.map(t=>t.x), ...bots.map(b=>b.x))
                const maxX = Math.max(...tops.map(t=>t.x), ...bots.map(b=>b.x))
                const minY = Math.min(...tops.map(t=>t.y), ...bots.map(b=>b.y))
                const maxY = Math.max(...tops.map(t=>t.y), ...bots.map(b=>b.y))
                
                if (pProj.x + 6 > minX && pProj.x - 6 < maxX && pProj.y > minY && pProj.y - 34 < maxY) {
                    ctx.globalAlpha = 0.4
                }
            }
        }

        for (let i = 0; i < tops.length; i++) {
            const next = (i + 1) % tops.length
            const dx = tops[next].x - tops[i].x
            
            const px1 = pts[i].x, py1 = pts[i].y
            const px2 = pts[next].x, py2 = pts[next].y
            
            const baseFace = (Math.abs(px1 - px2) < 0.001) ? (py1 > py2 ? 3 : 1) : (px1 < px2 ? 0 : 2)
            
            let isBoundary = false
            if (py1 === 0 && py2 === 0) isBoundary = true
            else if (px1 === 1 && px2 === 1) isBoundary = true
            else if (py1 === 1 && py2 === 1) isBoundary = true
            else if (px1 === 0 && px2 === 0) isBoundary = true

            let subFace = 0
            if (!isBoundary) {
                if (baseFace === 1 || baseFace === 3) subFace = (py1 < 0.5 && py2 < 0.5) ? 1 : 2
                else subFace = (px1 < 0.5 && px2 < 0.5) ? 1 : 2
            }
            const faceDir = baseFace + (subFace * 0.1)
            
            const isOccluded = isBoundary && hasFlushNeighbor(col, row, baseFace, px1, py1, px2, py2)
            
            if ((elevation > 0 && dx < 0 && !isOccluded) || isBaseOverride) {
                const faceDepth = tops[i].depth + tops[next].depth + bots[next].depth + bots[i].depth
                facesToDraw.push({ pIdx, i, next, px1, py1, px2, py2, faceDir, faceDepth })
            }
        }
    }

    // Pass 2: Sort pooled faces back-to-front dynamically for painter's occlusion
    facesToDraw.sort((a, b) => a.faceDepth - b.faceDepth)

    // Pass 3: Draw vertical faces
    for (let f of facesToDraw) {
        const tops = allTops[f.pIdx]
        const bots = allBots[f.pIdx]
        
        const isFaceSelected = selectedGroups.some(g => g.some(t => t.col === col && t.row === row && (matchFace(t.face, f.faceDir) || id === 4)))
        const isFaceHovered = (hoveredGroup && hoveredGroup.some(t => t.col === col && t.row === row && (matchFace(t.face, f.faceDir) || id === 4)))

        let strokeColor = '#222'
        let strokeWidth = 1
        if (isFaceSelected && !isBaseOverride) { strokeColor = '#ffcc00'; strokeWidth = 2 } 
        else if (isFaceHovered && !isBaseOverride) { strokeColor = isHoverError ? '#ff0000' : '#ffffff'; strokeWidth = 2 }

        ctx.beginPath()
        ctx.moveTo(tops[f.i].x, tops[f.i].y)
        ctx.lineTo(tops[f.next].x, tops[f.next].y)
        ctx.lineTo(bots[f.next].x, bots[f.next].y)
        ctx.lineTo(bots[f.i].x, bots[f.i].y)
        ctx.closePath()
        
        ctx.fillStyle = color
        ctx.fill()
        
        const dy = tops[f.next].y - tops[f.i].y
        ctx.fillStyle = dy < 0 ? 'rgba(0,0,0,0.4)' : 'rgba(0,0,0,0.2)'
        ctx.fill()
        
        if (isFaceSelected && !isBaseOverride) {
            ctx.fillStyle = 'rgba(255, 255, 0, 0.3)'
            ctx.fill()
        }
        
        if (!isBaseOverride) {
            ctx.beginPath()
            ctx.moveTo(tops[f.i].x, tops[f.i].y)
            ctx.lineTo(tops[f.next].x, tops[f.next].y)
            
            const isCombined = (id === 5 || (id >= 501 && id <= 515))
            
            let drawEndVert = true
            if (isCombined) {
                if (f.px2 === 1 && hasFlushNeighbor(col, row, 1, f.px1, f.py1, f.px2, f.py2) && (levelMap[row][col + 1] === 5 || levelMap[row][col + 1] >= 501)) drawEndVert = false
                if (f.px2 === 0 && hasFlushNeighbor(col, row, 3, f.px1, f.py1, f.px2, f.py2) && (levelMap[row][col - 1] === 5 || levelMap[row][col - 1] >= 501)) drawEndVert = false
                if (f.py2 === 1 && hasFlushNeighbor(col, row, 2, f.px1, f.py1, f.px2, f.py2) && (levelMap[row + 1][col] === 5 || levelMap[row + 1][col] >= 501)) drawEndVert = false
                if (f.py2 === 0 && hasFlushNeighbor(col, row, 0, f.px1, f.py1, f.px2, f.py2) && (levelMap[row - 1][col] === 5 || levelMap[row - 1][col] >= 501)) drawEndVert = false
            }
            
            if (drawEndVert) {
                ctx.lineTo(bots[f.next].x, bots[f.next].y)
            } else {
                ctx.moveTo(bots[f.next].x, bots[f.next].y)
            }
            
            ctx.lineTo(bots[f.i].x, bots[f.i].y)
            
            let drawStartVert = true
            if (isCombined) {
                if (f.px1 === 1 && hasFlushNeighbor(col, row, 1, f.px1, f.py1, f.px2, f.py2) && (levelMap[row][col + 1] === 5 || levelMap[row][col + 1] >= 501)) drawStartVert = false
                if (f.px1 === 0 && hasFlushNeighbor(col, row, 3, f.px1, f.py1, f.px2, f.py2) && (levelMap[row][col - 1] === 5 || levelMap[row][col - 1] >= 501)) drawStartVert = false
                if (f.py1 === 1 && hasFlushNeighbor(col, row, 2, f.px1, f.py1, f.px2, f.py2) && (levelMap[row + 1][col] === 5 || levelMap[row + 1][col] >= 501)) drawStartVert = false
                if (f.py1 === 0 && hasFlushNeighbor(col, row, 0, f.px1, f.py1, f.px2, f.py2) && (levelMap[row - 1][col] === 5 || levelMap[row - 1][col] >= 501)) drawStartVert = false
            }
            
            if (drawStartVert) {
                ctx.lineTo(tops[f.i].x, tops[f.i].y)
            }
            
            ctx.strokeStyle = strokeColor
            ctx.lineWidth = strokeWidth
            ctx.lineJoin = 'round'
            ctx.lineCap = 'round'
            ctx.stroke()
        }
        ctx.lineWidth = 1 
    }

    // Pass 4: Sort and draw top roofs AFTER all vertical faces are layered
    let roofsToDraw = []
    for (let pIdx = 0; pIdx < polys.length; pIdx++) {
        let depthSum = 0
        for (let t of allTops[pIdx]) depthSum += t.depth
        roofsToDraw.push({ pIdx, pts: polys[pIdx], tops: allTops[pIdx], depth: depthSum })
    }
    roofsToDraw.sort((a, b) => a.depth - b.depth)

    for (let roof of roofsToDraw) {
        const tops = roof.tops
        const pts = roof.pts
        
        const isTopSelected = selectedGroups.some(g => g.some(t => t.col === col && t.row === row && (t.face === 'top' || id === 4)))
        const isTopHovered = (hoveredGroup && hoveredGroup.some(t => t.col === col && t.row === row && (t.face === 'top' || id === 4)))

        let topStrokeColor = '#222'
        let topStrokeWidth = 1
        if (isTopSelected && !isBaseOverride) { topStrokeColor = '#ffcc00'; topStrokeWidth = 2 } 
        else if (isTopHovered && !isBaseOverride) { topStrokeColor = isHoverError ? '#ff0000' : '#ffffff'; topStrokeWidth = 2 }

        ctx.beginPath()
        ctx.moveTo(tops[0].x, tops[0].y)
        for (let i = 1; i < tops.length; i++) {
            ctx.lineTo(tops[i].x, tops[i].y)
        }
        ctx.closePath()
        ctx.fillStyle = color
        ctx.fill()
        
        if (isTopSelected && !isBaseOverride) {
            ctx.fillStyle = 'rgba(255, 255, 0, 0.4)'
            ctx.fill()
        }
        
        ctx.beginPath()
        for (let i = 0; i < tops.length; i++) {
            const next = (i + 1) % tops.length
            const px1 = pts[i].x, py1 = pts[i].y
            const px2 = pts[next].x, py2 = pts[next].y
            const faceDir = (Math.abs(px1 - px2) < 0.001) ? (py1 > py2 ? 3 : 1) : (px1 < px2 ? 0 : 2)

            let isBoundary = false
            if (py1 === 0 && py2 === 0) isBoundary = true
            else if (px1 === 1 && px2 === 1) isBoundary = true
            else if (py1 === 1 && py2 === 1) isBoundary = true
            else if (px1 === 0 && px2 === 0) isBoundary = true

            const isOccluded = isBoundary && hasFlushNeighbor(col, row, faceDir, px1, py1, px2, py2)

            if (!isOccluded || isBaseOverride || elevation <= 0) {
                ctx.moveTo(tops[i].x, tops[i].y)
                ctx.lineTo(tops[next].x, tops[next].y)
            }
        }
        
        if ((elevation <= 0 || isBaseOverride) && !isTopSelected && !isTopHovered) {
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)' 
            ctx.lineWidth = 1 / ZOOM 
        } else {
            ctx.strokeStyle = topStrokeColor
            ctx.lineWidth = topStrokeWidth / ZOOM 
        }
        
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.stroke()
        ctx.lineWidth = 1 
        ctx.globalAlpha = 1.0 
    }
}

// Render line of sight cone on the floor plane
function drawCone() {
    const pAccX = getAccumulated(player.x, colWidths)
    const pAccY = getAccumulated(player.y, rowDepths)
    const groundPos = project(pAccX, pAccY, 0)

    // Calculate logical grid facing direction
    let sx = 0
    let sy = 0
    if (player.facing === 'up') sy = -1
    if (player.facing === 'down') sy = 1
    if (player.facing === 'left') sx = -1
    if (player.facing === 'right') sx = 1

    const safeRot = typeof ROTATION !== 'undefined' ? ROTATION : 0
    const rad = -safeRot * Math.PI / 180
    const cos = Math.round(Math.cos(rad))
    const sin = Math.round(Math.sin(rad))

    const gx = sx * cos - sy * sin
    const gy = sx * sin + sy * cos

    // Calculate cone projection points directly in physical accumulated space for perfect symmetry
    const coneDist = 3.0
    const coneSpread = 2.5

    const endAccX = pAccX + gx * coneDist
    const endAccY = pAccY + gy * coneDist
    const perpAccX = -gy * coneSpread
    const perpAccY = gx * coneSpread

    const accLeftX = endAccX + perpAccX
    const accLeftY = endAccY + perpAccY
    const accRightX = endAccX - perpAccX
    const accRightY = endAccY - perpAccY

    const pLeft = project(accLeftX, accLeftY, 0)
    const pRight = project(accRightX, accRightY, 0)

    // Render semi transparent line of sight cone onto floor plane
    ctx.fillStyle = 'rgba(255, 255, 0, 0.25)'
    ctx.beginPath()
    ctx.moveTo(groundPos.x, groundPos.y)
    ctx.lineTo(pLeft.x, pLeft.y)
    ctx.lineTo(pRight.x, pRight.y)
    ctx.closePath()
    ctx.fill()
}

// Draw player character mapped to isometric grid
function drawPlayer() {
    const tileX = Math.floor(player.x)
    const tileY = Math.floor(player.y)
    const tileId = levelMap[tileY][tileX]
    const elevation = tileHeights[tileId]

    const pAccX = getAccumulated(player.x, colWidths)
    const pAccY = getAccumulated(player.y, rowDepths)
    const pos = project(pAccX, pAccY, elevation)

    if (typeof CAMERA_PITCH !== 'undefined' && CAMERA_PITCH > 40) {
        // Draw top-down square representation proportional to tile width
        ctx.fillStyle = player.color
        ctx.fillRect(pos.x - 8, pos.y - 8, 16, 16)
        ctx.strokeStyle = '#222'
        ctx.strokeRect(pos.x - 8, pos.y - 8, 16, 16)
        
        // Draw directional visor for top-down view
        ctx.fillStyle = '#111'
        if (player.facing === 'down') {
            ctx.fillRect(pos.x - 6, pos.y + 4, 12, 4)
        } else if (player.facing === 'up') {
            ctx.fillRect(pos.x - 6, pos.y - 8, 12, 4)
        } else if (player.facing === 'left') {
            ctx.fillRect(pos.x - 8, pos.y - 6, 4, 12)
        } else if (player.facing === 'right') {
            ctx.fillRect(pos.x + 4, pos.y - 6, 4, 12)
        }
    } else {
        // Draw character body proportional to human height relative to tile size
        ctx.fillStyle = player.color
        ctx.fillRect(pos.x - 8, pos.y - 46, 16, 46)
        ctx.strokeStyle = '#222'
        ctx.strokeRect(pos.x - 8, pos.y - 46, 16, 46)

        // Draw directional visor to indicate logical facing direction
        ctx.fillStyle = '#111'
        if (player.facing === 'down') {
            ctx.fillRect(pos.x - 6, pos.y - 42, 12, 6)
        } else if (player.facing === 'left') {
            ctx.fillRect(pos.x - 8, pos.y - 42, 6, 6)
        } else if (player.facing === 'right') {
            ctx.fillRect(pos.x + 2, pos.y - 42, 6, 6)
        }
    }
}

// Determine if a specific logical grid coordinate is walkable
function isWalkable(x, y) {
    const col = Math.floor(x)
    const row = Math.floor(y)
    if (row < 0 || row >= MAP_ROWS || col < 0 || col >= MAP_COLS) return false
    const tileId = levelMap[row][col]
    return !tileCollisions[tileId]
}

// Evaluate dynamic collision bounding box to allow close proximity to obstacles while preserving corner anti-clipping
function checkCollision(x, y) {
    const wallR = 0.2  // Padded boundary to prevent z fighting at tall structural wall corners
    const obsR = 0.05  // Tight boundary to allow getting physically closer to obstacles and doorways

    const points = [
        {dx: -1, dy: -1}, {dx: 1, dy: -1},
        {dx: -1, dy: 1}, {dx: 1, dy: 1}
    ]

    for (let p of points) {
        // Evaluate padded boundary against structural walls excluding doorway sides
        let col = Math.floor(x + p.dx * wallR)
        let row = Math.floor(y + p.dy * wallR)
        if (row < 0 || row >= MAP_ROWS || col < 0 || col >= MAP_COLS) return false
        let id = levelMap[row][col]
        
        if (tileCollisions[id] && id !== 4 && id !== 2) {
            let isDoorwayWall = false
            if (id === 1 || id === 5 || (id >= 101 && id <= 115) || (id >= 501 && id <= 515)) {
                if ((row > 0 && levelMap[row - 1][col] === 3) ||
                    (row < MAP_ROWS - 1 && levelMap[row + 1][col] === 3) ||
                    (col > 0 && levelMap[row][col - 1] === 3) ||
                    (col < MAP_COLS - 1 && levelMap[row][col + 1] === 3)) {
                    isDoorwayWall = true
                }
            }
            if (!isDoorwayWall) return false
        }

        // Evaluate tight boundary against obstacles and doorway sides
        col = Math.floor(x + p.dx * obsR)
        row = Math.floor(y + p.dy * obsR)
        if (row < 0 || row >= MAP_ROWS || col < 0 || col >= MAP_COLS) return false
        id = levelMap[row][col]
        
        if (tileCollisions[id]) {
            let isDoorwayFloor = false
            if (id === 2) {
                if ((row > 0 && levelMap[row - 1][col] === 3) ||
                    (row < MAP_ROWS - 1 && levelMap[row + 1][col] === 3) ||
                    (col > 0 && levelMap[row][col - 1] === 3) ||
                    (col < MAP_COLS - 1 && levelMap[row][col + 1] === 3)) {
                    isDoorwayFloor = true
                }
            }
            if (!isDoorwayFloor) return false
        }
    }
    
    return true
}

// Modify player coordinates based on active keys and padded collision boundaries
function update() {
    let inputX = 0
    let inputY = 0

    // Capture logical screen-relative input direction
    if (keys.w || keys.ArrowUp) { inputY -= 1; player.facing = 'up' }
    if (keys.s || keys.ArrowDown) { inputY += 1; player.facing = 'down' }
    if (keys.a || keys.ArrowLeft) { inputX -= 1; player.facing = 'left' }
    if (keys.d || keys.ArrowRight) { inputX += 1; player.facing = 'right' }

    if (inputX !== 0 || inputY !== 0) {
        // Normalize input vector to maintain constant diagonal speed
        const length = Math.sqrt(inputX * inputX + inputY * inputY)
        const normX = inputX / length
        const normY = inputY / length

        // Inverse rotate the input vector to map visual screen direction to the rotated grid
        const safeRot = typeof ROTATION !== 'undefined' ? ROTATION : 0
        const rad = -safeRot * Math.PI / 180
        const cos = Math.round(Math.cos(rad))
        const sin = Math.round(Math.sin(rad))

        const gridDirX = normX * cos - normY * sin
        const gridDirY = normX * sin + normY * cos

        // Scale logical movement speed to match physical tile dimensions
        const scaleX = colWidths[Math.floor(player.x)] || 1.0
        const scaleY = rowDepths[Math.floor(player.y)] || 1.0

        let nextX = player.x + (player.speed / scaleX) * gridDirX
        let nextY = player.y + (player.speed / scaleY) * gridDirY

        // Apply independent axis collision evaluating padded bounding box
        if (checkCollision(nextX, player.y)) {
            player.x = nextX
        }
        if (checkCollision(player.x, nextY)) {
            player.y = nextY
        }

        player.x = Math.max(0, Math.min(MAP_COLS - 0.01, player.x))
        player.y = Math.max(0, Math.min(MAP_ROWS - 0.01, player.y))
    }
}

// Clear canvas and render frame using rigorous topological grid sorting
function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    update()

    ctx.save()
    ctx.translate(canvas.width / 2 + cameraX, canvas.height / 2 + cameraY)
    ctx.scale(ZOOM, ZOOM)

    // Pass 1: Render all ground/floor tiles first
    // Force a flat 1x1 base floor tile to draw beneath ANY elevated wall or obstacle
    for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
            const tileId = levelMap[row][col]
            const elevation = tileHeights[tileId]
            if (elevation <= 0) {
                drawTile(col, row, tileColors[tileId], elevation)
            } else {
                drawTile(col, row, tileColors[0], 0, true)
            }
        }
    }

    // Determine topological drawing direction based on camera rotation
    const safeRot = typeof ROTATION !== 'undefined' ? ROTATION : 0
    let cStart = 0, cEnd = MAP_COLS, cStep = 1
    let rStart = 0, rEnd = MAP_ROWS, rStep = 1

    if (safeRot === 90) {
        rStart = MAP_ROWS - 1; rEnd = -1; rStep = -1
    } else if (safeRot === 180) {
        cStart = MAP_COLS - 1; cEnd = -1; cStep = -1
        rStart = MAP_ROWS - 1; rEnd = -1; rStep = -1
    } else if (safeRot === 270) {
        cStart = MAP_COLS - 1; cEnd = -1; cStep = -1
    }

    // Pass 2: Render elevated blocks and player topologically back-to-front
    for (let row = rStart; row !== rEnd; row += rStep) {
        for (let col = cStart; col !== cEnd; col += cStep) {
            const tileId = levelMap[row][col]
            const elevation = tileHeights[tileId]
            
            if (elevation > 0) {
                drawTile(col, row, tileColors[tileId], elevation)
            }
            
            // Render player exactly when the loop processes the cell the player stands in
            if (Math.floor(player.x) === col && Math.floor(player.y) === row) {
                drawPlayer()
            }
        }
    }

    // Pass 3: Render line of sight cone last so it visibly overlays both floor and elevated structures
    drawCone()

    ctx.restore()
    updateStats()
    requestAnimationFrame(loop)
}

// Update dynamic tile and selection statistics in the UI panel
function updateStats() {
    const floorEl = document.getElementById('stat-floor-tiles')
    const selRow = document.getElementById('stat-sel-row')
    const selEl = document.getElementById('stat-sel-segments')
    
    if (floorEl) {
        floorEl.innerText = `${MAP_ROWS * MAP_COLS} (${MAP_COLS}x${MAP_ROWS})`
    }
    
    if (selRow && selEl) {
        if (selectedGroups.length > 0) {
            const totalSegments = selectedGroups.reduce((acc, group) => acc + group.length, 0)
            selEl.innerText = totalSegments
            selRow.style.display = 'block'
        } else {
            selRow.style.display = 'none'
        }
    }
}

// Automatically calculate the perfect zoom and center offsets to fit the entire level on screen
function autoFitLevel() {
    const totalW = colWidths.reduce((a, b) => a + b, 0)
    const totalH = rowDepths.reduce((a, b) => a + b, 0)
    
    // Check the outermost corners of the base floor
    const corners = [
        project(0, 0, 0),
        project(totalW, 0, 0),
        project(totalW, totalH, 0),
        project(0, totalH, 0)
    ]
    
    // Check the outermost corners at maximum elevation so tall walls aren't cut off at the top
    const maxElev = Math.max(WALL_HEIGHT, OBS_HEIGHT)
    const topCorners = [
        project(0, 0, maxElev),
        project(totalW, 0, maxElev),
        project(totalW, totalH, maxElev),
        project(0, totalH, maxElev)
    ]
    
    const allPts = [...corners, ...topCorners]
    
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    allPts.forEach(pt => {
        if (pt.x < minX) minX = pt.x
        if (pt.x > maxX) maxX = pt.x
        if (pt.y < minY) minY = pt.y
        if (pt.y > maxY) maxY = pt.y
    })
    
    const boundW = maxX - minX
    const boundH = maxY - minY
    
    // Set ZOOM to fit the bounds into the canvas with a 10% padding margin
    ZOOM = Math.min(canvas.width / boundW, canvas.height / boundH) * 0.9
    
    // The project() function already centers X at 0, but we need to offset Y to account for wall height
    cameraX = 0
    const centerY = (minY + maxY) / 2
    cameraY = -centerY * ZOOM
    
    // Update the UI slider to match the new dynamic zoom
    const zoomSlider = document.getElementById('zoom')
    const zoomVal = document.getElementById('zoom-val')
    if (zoomSlider && zoomVal) {
        zoomSlider.value = ZOOM
        zoomVal.innerText = ZOOM.toFixed(1)
    }
}

// Execute auto-fit before starting the loop
autoFitLevel()

// Execute game loop
loop()