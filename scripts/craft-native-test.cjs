const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

if (process.platform !== 'win32') {
  console.log('Native Craft containment test requires Windows.')
  process.exit(0)
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const option = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)
const handle = (window) => Number(window.getNativeWindowHandle().readBigUInt64LE())

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trenddeck-native-test-'))
  try {
    const bundle = path.join(directory, 'dock.cjs')
    require('esbuild').buildSync({ entryPoints: [path.resolve('src/main/craft/dock.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'koffi'], banner: { js: `module.paths.push(${JSON.stringify(path.resolve('node_modules'))});` } })
    const env = { ...process.env, NODE_PATH: path.resolve('node_modules') }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(require('electron'), [__filename, '--native-host', `--directory=${directory}`, `--bundle=${bundle}`], { env, stdio: 'inherit', windowsHide: true, timeout: 45_000 })
    if (result.error) throw result.error
    process.exitCode = result.status === 0 ? 0 : 1
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
} else {
  const { app, BrowserWindow } = require('electron')
  app.commandLine.appendSwitch('disable-gpu')
  const directory = option('--directory')
  const childMode = process.argv.includes('--native-child')
  let child
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1000, height: 720, x: -16000, y: -16000, show: false, skipTaskbar: true, title: 'TrendDeck native containment fixture', webPreferences: { sandbox: true } })
    await window.loadURL('data:text/html,<title>Native fixture</title><p>Containment test</p>')
    const library = require('koffi').load('user32.dll')
    const getParent = library.func('intptr_t __stdcall GetParent(intptr_t hwnd)')
    const getStyle = library.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)')
    const setStyle = library.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)')
    window.showInactive()
    if (childMode) {
      setStyle(handle(window), -20, Number(getStyle(handle(window), -20)) & ~(0x80 | 0x08000000))
      fs.writeFileSync(path.join(directory, 'child.json'), JSON.stringify({ pid: process.pid, hwnd: handle(window), style: Number(getStyle(handle(window), -16)) }))
      const timer = setInterval(() => { if (fs.existsSync(path.join(directory, 'stop'))) { clearInterval(timer); app.quit() } }, 50)
      return
    }
    const dock = require(option('--bundle'))
    child = spawn(process.execPath, [__filename, '--native-child', `--directory=${directory}`], { env: process.env, stdio: 'ignore', windowsHide: true })
    let fixture
    for (let attempt = 0; attempt < 100; attempt++) {
      if (fs.existsSync(path.join(directory, 'child.json'))) { fixture = JSON.parse(fs.readFileSync(path.join(directory, 'child.json'), 'utf8')); break }
      await pause(100)
    }
    assert.ok(fixture, 'The independent native fixture started')
    dock.setHost(window)
    dock.attach('fixture', fixture.pid)
    dock.setDock({ appId: 'fixture', bounds: { x: 40, y: 60, width: 640, height: 400 }, visible: true })
    await pause(500)
    assert.equal(Number(getParent(fixture.hwnd)), handle(window), 'Editor is a child, not an owned top-level overlay')
    assert.ok(Number(getStyle(fixture.hwnd, -16)) & 0x40000000, 'Native child style is applied')
    const koffi = require('koffi')
    koffi.struct('TEST_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    const getRect = library.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ TEST_RECT *rect)')
    const rect = { left: 0, top: 0, right: 0, bottom: 0 }
    getRect(fixture.hwnd, rect)
    const { screen } = require('electron')
    const content = window.getContentBounds()
    const expected = screen.dipToScreenRect(window, { x: content.x + 40, y: content.y + 60, width: 640, height: 400 })
    assert.deepEqual(rect, { left: expected.x, top: expected.y, right: expected.x + expected.width, bottom: expected.y + expected.height }, 'The child matches the chat viewport without stretching')
    dock.setDock({ appId: 'fixture', bounds: { x: 40, y: 60, width: 640, height: 400 }, visible: true, clip: { x: 40, y: 100, width: 640, height: 320 } })
    await pause(100)
    const gdi = koffi.load('gdi32.dll')
    const createRegion = gdi.func('intptr_t __stdcall CreateRectRgn(int left, int top, int right, int bottom)')
    const deleteObject = gdi.func('bool __stdcall DeleteObject(intptr_t object)')
    const getRegionBox = gdi.func('int __stdcall GetRgnBox(intptr_t region, _Out_ TEST_RECT *rect)')
    const getWindowRegion = library.func('int __stdcall GetWindowRgn(intptr_t hwnd, intptr_t region)')
    const region = createRegion(0, 0, 0, 0)
    assert.notEqual(Number(getWindowRegion(fixture.hwnd, region)), 0, 'A real native clipping region is installed')
    getRegionBox(region, rect)
    const clipped = screen.dipToScreenRect(window, { x: content.x + 40, y: content.y + 100, width: 640, height: 320 })
    assert.deepEqual(rect, { left: clipped.x - expected.x, top: clipped.y - expected.y, right: clipped.x + clipped.width - expected.x, bottom: clipped.y + clipped.height - expected.y })
    deleteObject(region)
    for (const zoom of [0.8, 1.25, 1.5]) {
      window.webContents.setZoomFactor(zoom)
      dock.setDock({ appId: 'fixture', bounds: { x: 40, y: 60, width: 640, height: 400 }, visible: true })
      await pause(150)
      getRect(fixture.hwnd, rect)
      const scaled = screen.dipToScreenRect(window, { x: content.x + Math.round(40 * zoom), y: content.y + Math.round(60 * zoom), width: Math.round(640 * zoom), height: Math.round(400 * zoom) })
      assert.deepEqual(rect, { left: scaled.x, top: scaled.y, right: scaled.x + scaled.width, bottom: scaled.y + scaled.height }, `Viewport geometry at ${zoom * 100}% zoom`)
    }
    dock.release('fixture')
    await pause(200)
    assert.equal(Number(getParent(fixture.hwnd)), 0, 'Undocking restores the original native parent')
    assert.equal(Number(getStyle(fixture.hwnd, -16)), fixture.style, 'Undocking restores the editor window style')
    console.log('Native Craft test passed: cross-process child hosting, viewport geometry, clipping and safe release.')
    fs.writeFileSync(path.join(directory, 'stop'), '')
    await pause(300)
    app.quit()
  }).catch((error) => {
    console.error(error)
    if (directory) fs.writeFileSync(path.join(directory, 'stop'), '')
    process.exitCode = 1
    setTimeout(() => app.exit(1), 300)
  })
}
