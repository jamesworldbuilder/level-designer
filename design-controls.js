// Cache UI elements
const sizeSlider = document.getElementById('tile-size')
const pitchSlider = document.getElementById('camera-pitch')
const wallSlider = document.getElementById('wall-height')
const obsSlider = document.getElementById('obs-height')
const zoomSlider = document.getElementById('zoom')
const rotSlider = document.getElementById('rotation')
const sizeVal = document.getElementById('size-val')
const pitchVal = document.getElementById('pitch-val')
const wallVal = document.getElementById('wall-val')
const obsVal = document.getElementById('obs-val')
const zoomVal = document.getElementById('zoom-val')
const rotVal = document.getElementById('rot-val')
const exportOut = document.getElementById('export-out')

// Store history for undo functionality
const historyStack = []

// Push current state and deep copy of map array to history stack
function saveState() {
    const mapCopy = levelMap.map(row => [...row])
    historyStack.push({ s: TILE_SIZE, p: CAMERA_PITCH, wh: WALL_HEIGHT, oh: OBS_HEIGHT, z: ZOOM, r: ROTATION, m: mapCopy })
    if (historyStack.length > 100) historyStack.shift()
}

// Bind save state events to slider interactions
function attachSave(element) {
    element.addEventListener('mousedown', saveState)
    element.addEventListener('touchstart', saveState)
}
attachSave(sizeSlider)
attachSave(pitchSlider)
attachSave(wallSlider)
attachSave(obsSlider)
attachSave(zoomSlider)
attachSave(rotSlider)

// Helper logic to step sliders programmatically with UI buttons
function attachStepper(inputId, btnDownId, btnUpId, stepValue) {
    const input = document.getElementById(inputId)
    document.getElementById(btnDownId).addEventListener('click', () => {
        saveState()
        let nextVal = parseFloat(input.value) - stepValue
        if (nextVal < parseFloat(input.min)) nextVal = parseFloat(input.max)
        input.value = nextVal
        input.dispatchEvent(new Event('input'))
    })
    document.getElementById(btnUpId).addEventListener('click', () => {
        saveState()
        let nextVal = parseFloat(input.value) + stepValue
        if (nextVal > parseFloat(input.max)) nextVal = parseFloat(input.min)
        input.value = nextVal
        input.dispatchEvent(new Event('input'))
    })
}

// Bind custom step increments to interface arrows (5 units for size, dynamic for rest)
attachStepper('tile-size', 'btn-ts-down', 'btn-ts-up', 5)
attachStepper('camera-pitch', 'btn-p-down', 'btn-p-up', 10)
attachStepper('wall-height', 'btn-wh-down', 'btn-wh-up', 0.1)
attachStepper('obs-height', 'btn-oh-down', 'btn-oh-up', 0.1)
attachStepper('zoom', 'btn-z-down', 'btn-z-up', 0.1)
attachStepper('rotation', 'btn-r-down', 'btn-r-up', 90)

// Update values visually during drag and button steps
sizeSlider.addEventListener('input', (e) => {
    TILE_SIZE = parseInt(e.target.value)
    sizeVal.innerText = TILE_SIZE
})
pitchSlider.addEventListener('input', (e) => {
    let val = parseInt(e.target.value)
    
    // Snap to top-down view for any angle over 40
    if (val > 40 && val < 90) {
        val = CAMERA_PITCH === 90 ? 40 : 90
        pitchSlider.value = val
    } 
    // Snap to direct side-view for any angle under 10
    else if (val > 0 && val < 10) {
        val = CAMERA_PITCH === 0 ? 10 : 0
        pitchSlider.value = val
    }
    
    CAMERA_PITCH = val
    pitchVal.innerText = CAMERA_PITCH
    
    // Trigger auto-fit when snapping perfectly to top-down 90 degrees
    if (CAMERA_PITCH === 90) {
        if (typeof autoFitLevel === 'function') {
            autoFitLevel()
        }
    }
})
wallSlider.addEventListener('input', (e) => {
    WALL_HEIGHT = parseFloat(e.target.value)
    wallVal.innerText = WALL_HEIGHT.toFixed(1)
    tileHeights[1] = WALL_HEIGHT
    tileHeights[5] = WALL_HEIGHT
    for (let i = 1; i <= 15; i++) {
        tileHeights[100 + i] = WALL_HEIGHT
        tileHeights[500 + i] = WALL_HEIGHT
    }
    
    if (OBS_HEIGHT > WALL_HEIGHT) {
        OBS_HEIGHT = WALL_HEIGHT
        obsSlider.value = OBS_HEIGHT
        obsVal.innerText = OBS_HEIGHT.toFixed(1)
        tileHeights[4] = OBS_HEIGHT
    }
})
obsSlider.addEventListener('input', (e) => {
    let val = parseFloat(e.target.value)
    if (val > WALL_HEIGHT) {
        val = WALL_HEIGHT
        obsSlider.value = val
    }
    OBS_HEIGHT = val
    obsVal.innerText = OBS_HEIGHT.toFixed(1)
    tileHeights[4] = OBS_HEIGHT
})
zoomSlider.addEventListener('input', (e) => {
    ZOOM = parseFloat(e.target.value)
    zoomVal.innerText = ZOOM.toFixed(1)
})
rotSlider.addEventListener('input', (e) => {
    ROTATION = parseInt(e.target.value)
    rotVal.innerText = ROTATION
    if (typeof updateAlignLabel === 'function') updateAlignLabel()
})

// Cache object placement buttons
const btnAddWall = document.getElementById('btn-add-wall')
const btnAddObs = document.getElementById('btn-add-obs')

// Handle wall alignment options
const alignRow = document.getElementById('wall-align-row')
const alignInput = document.getElementById('wall-align')
const alignLabel = document.getElementById('wall-align-label')

function updateAlignLabel() {
    if (!alignLabel || !alignInput) return
    const val = parseInt(alignInput.value)
    if (isNaN(val) || val === 0) {
        alignLabel.innerText = 'Center'
    } else {
        const names = ['Top', 'Right', 'Bottom', 'Left']
        const shift = (typeof ROTATION !== 'undefined' ? ROTATION : 0) / 90
        const index = (val - 1 + shift) % 4
        alignLabel.innerText = names[index]
    }
}

if (alignInput) {
    alignInput.addEventListener('input', () => {
        let val = parseInt(alignInput.value)
        if (isNaN(val) || val < 0) { val = 0; alignInput.value = 0 }
        if (val > 4) { val = 4; alignInput.value = 4 }
        
        updateAlignLabel()
        
        // Update the active paint brush using bitmask logic (1:Top, 2:Right, 4:Bottom, 8:Left)
        if (placeMode !== null && (placeMode === 1 || placeMode >= 100)) {
            placeMode = val === 0 ? 1 : 100 + (1 << (val - 1))
        }
        
        // Dynamically snap currently selected walls to the new edge alignment
        if (typeof selectedGroups !== 'undefined' && selectedGroups.length > 0) {
            if (typeof saveState === 'function') saveState()
            selectedGroups.forEach(group => {
                group.forEach(t => {
                    const id = levelMap[t.row][t.col]
                    if (id === 1 || (id >= 101 && id <= 115)) {
                        levelMap[t.row][t.col] = val === 0 ? 1 : 100 + (1 << (val - 1))
                    } 
                    else if (id === 5 || (id >= 501 && id <= 515)) {
                        levelMap[t.row][t.col] = val === 0 ? 5 : 500 + (1 << (val - 1))
                    }
                })
            })
        }
    })
}

// Toggle wall placement mode
btnAddWall.addEventListener('click', () => {
    const isActive = placeMode !== null && (placeMode === 1 || placeMode >= 100)
    if (isActive) {
        placeMode = null
        alignRow.style.display = 'none'
    } else {
        const val = alignInput ? (parseInt(alignInput.value) || 0) : 0
        placeMode = val === 0 ? 1 : 100 + (1 << (val - 1))
        alignRow.style.display = 'flex'
    }
    btnAddWall.classList.toggle('active-tool', !isActive)
    btnAddObs.classList.remove('active-tool')
    selectedGroups = []
    document.getElementById('btn-combine').style.display = 'none'
})

// Toggle obstacle placement mode
btnAddObs.addEventListener('click', () => {
    placeMode = placeMode === 4 ? null : 4
    btnAddObs.classList.toggle('active-tool', placeMode === 4)
    btnAddWall.classList.remove('active-tool')
    alignRow.style.display = 'none'
    selectedGroups = []
    document.getElementById('btn-combine').style.display = 'none'
})

// Handle dynamic grid resizing
const inputCols = document.getElementById('grid-cols')
const inputRows = document.getElementById('grid-rows')

function handleGridResize() {
    const c = parseInt(inputCols.value)
    const r = parseInt(inputRows.value)
    if (!isNaN(c) && c > 0 && !isNaN(r) && r > 0 && typeof resizeGrid === 'function') {
        resizeGrid(c, r)
    }
}

if (inputCols) {
    inputCols.addEventListener('input', handleGridResize)
}
if (inputRows) {
    inputRows.addEventListener('input', handleGridResize)
}

// Revert to last saved state including map layout changes
document.getElementById('btn-undo').addEventListener('click', () => {
    if (historyStack.length > 0) {
        const lastState = historyStack.pop()
        TILE_SIZE = lastState.s
        CAMERA_PITCH = lastState.p
        WALL_HEIGHT = lastState.wh
        OBS_HEIGHT = lastState.oh
        ZOOM = lastState.z
        ROTATION = lastState.r
        
        if (lastState.m) {
            // Restore actual array dimensions in case an undo reverts a resize event
            MAP_ROWS = lastState.m.length
            MAP_COLS = lastState.m[0].length
            levelMap = Array.from({ length: MAP_ROWS }, () => Array(MAP_COLS).fill(0))
            colWidths = Array(MAP_COLS).fill(1.0)
            rowDepths = Array(MAP_ROWS).fill(1.0)

            for (let r = 0; r < MAP_ROWS; r++) {
                for (let c = 0; c < MAP_COLS; c++) {
                    levelMap[r][c] = lastState.m[r][c]
                }
            }
            
            // Sync UI text fields back to restored dimensions
            if (inputCols) inputCols.value = MAP_COLS
            if (inputRows) inputRows.value = MAP_ROWS
            if (typeof autoFitLevel === 'function') autoFitLevel()
        }
        
        sizeSlider.value = TILE_SIZE
        pitchSlider.value = CAMERA_PITCH
        wallSlider.value = WALL_HEIGHT
        obsSlider.value = OBS_HEIGHT
        zoomSlider.value = ZOOM
        rotSlider.value = ROTATION
        
        sizeVal.innerText = TILE_SIZE
        pitchVal.innerText = CAMERA_PITCH
        wallVal.innerText = WALL_HEIGHT.toFixed(1)
        obsVal.innerText = OBS_HEIGHT.toFixed(1)
        zoomVal.innerText = ZOOM.toFixed(1)
        rotVal.innerText = ROTATION
        
        if (typeof updateAlignLabel === 'function') updateAlignLabel()
        
        tileHeights[1] = WALL_HEIGHT
        tileHeights[5] = WALL_HEIGHT
        for (let i = 1; i <= 15; i++) {
            tileHeights[100 + i] = WALL_HEIGHT
            tileHeights[500 + i] = WALL_HEIGHT
        }
        tileHeights[4] = OBS_HEIGHT
    }
})

// Export updated script variables
document.getElementById('btn-export').addEventListener('click', () => {
    exportOut.style.display = 'block'
    exportOut.value = `let TILE_SIZE = ${TILE_SIZE}\nlet CAMERA_PITCH = ${CAMERA_PITCH}\nlet WALL_HEIGHT = ${WALL_HEIGHT}\nlet OBS_HEIGHT = ${OBS_HEIGHT}\nlet ZOOM = ${ZOOM}\nlet ROTATION = ${ROTATION}\nlet cameraX = ${cameraX}\nlet cameraY = ${cameraY}`
})