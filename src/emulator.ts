import ini from 'ini'
import { kebabCase } from 'lodash-es'
import { coreFullNameMap } from './constants'
import { createEmscriptenFS, getEmscriptenModuleOverrides } from './emscripten'
import { blobToBuffer } from './utils'

const encoder = new TextEncoder()

function delay(time: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, time)
  })
}

// Commands reference https://docs.libretro.com/development/retroarch/network-control-interface/
type RetroArchCommand =
  | 'FAST_FORWARD'
  | 'FAST_FORWARD_HOLD'
  | 'LOAD_STATE'
  | 'SAVE_STATE'
  | 'FULLSCREEN_TOGGLE'
  | 'QUIT'
  | 'STATE_SLOT_PLUS'
  | 'STATE_SLOT_MINUS'
  | 'REWIND'
  | 'MOVIE_RECORD_TOGGLE'
  | 'PAUSE_TOGGLE'
  | 'FRAMEADVANCE'
  | 'RESET'
  | 'SHADER_NEXT'
  | 'SHADER_PREV'
  | 'CHEAT_INDEX_PLUS'
  | 'CHEAT_INDEX_MINUS'
  | 'CHEAT_TOGGLE'
  | 'SCREENSHOT'
  | 'MUTE'
  | 'NETPLAY_FLIP'
  | 'SLOWMOTION'
  | 'VOLUME_UP'
  | 'VOLUME_DOWN'
  | 'OVERLAY_NEXT'
  | 'DISK_EJECT_TOGGLE'
  | 'DISK_NEXT'
  | 'DISK_PREV'
  | 'GRAB_MOUSE_TOGGLE'
  | 'MENU_TOGGLE'

const raUserdataDir = '/home/web_user/retroarch/userdata/'
const raCoreConfigDir = `${raUserdataDir}config/`
const raConfigPath = `${raUserdataDir}retroarch.cfg`

function updateStyle(element: HTMLElement, style: Partial<CSSStyleDeclaration>) {
  if (!element) {
    return
  }
  for (const rule in style) {
    if (style[rule]) {
      element.style.setProperty(kebabCase(rule), style[rule] as string)
    } else {
      element.style.removeProperty(rule)
    }
  }
}

type GameStatus = 'initial' | 'paused' | 'running'

export class Emulator {
  private options: options
  private emscripten
  private messageQueue: [Uint8Array, number][] = []
  private gameStatus: GameStatus = 'initial'

  constructor(options) {
    this.options = options
  }

  private get stateFileName() {
    const [{ fileName }] = this.options.rom
    const baseName = fileName.slice(0, fileName.lastIndexOf('.'))
    const coreFullName = coreFullNameMap[this.options.core.name]
    return `${raUserdataDir}states/${coreFullName}/${baseName}.state`
  }

  private get stateThumbnailFileName() {
    return `${this.stateFileName}.png`
  }

  getOptions() {
    return this.options
  }

  async launch() {
    await this.setupEmscripten()
    this.setupRaConfigFile()
    this.setupRaCoreConfigFile()

    if (this.options.waitForInteraction) {
      this.options.waitForInteraction({
        done() {
          this.runMain()
        },
      })
    } else {
      this.runMain()
    }
  }

  resume() {
    if (this.gameStatus === 'paused') {
      this.sendCommand('PAUSE_TOGGLE')
    }
    this.gameStatus = 'running'
  }

  restart() {
    this.sendCommand('RESET')
    this.resume()
  }

  pause() {
    if (this.gameStatus === 'running') {
      this.sendCommand('PAUSE_TOGGLE')
    }
    this.gameStatus = 'paused'
  }

  async saveState() {
    this.clearStateFile()
    if (!this.emscripten) {
      return
    }
    this.sendCommand('SAVE_STATE')
    const savestateThumbnailEnable = this.options.retroarch.savestate_thumbnail_enable
    let stateBuffer: Buffer
    let stateThumbnailBuffer: Buffer | undefined
    if (savestateThumbnailEnable) {
      ;[stateBuffer, stateThumbnailBuffer] = await Promise.all([
        this.waitForEmscriptenFile(this.stateFileName),
        this.waitForEmscriptenFile(this.stateThumbnailFileName),
      ])
    } else {
      stateBuffer = await this.waitForEmscriptenFile(this.stateFileName)
    }
    this.clearStateFile()

    const state = new Blob([stateBuffer], { type: 'application/octet-stream' })
    const thumbnail = stateThumbnailBuffer
      ? new Blob([stateThumbnailBuffer], { type: 'application/octet-stream' })
      : undefined
    return { state, thumbnail }
  }

  async loadState(blob: Blob) {
    this.clearStateFile()
    if (this.emscripten) {
      const { FS } = this.emscripten
      const buffer = await blobToBuffer(blob)
      FS.writeFile(this.stateFileName, buffer)
      await this.waitForEmscriptenFile(this.stateFileName)
      this.sendCommand('LOAD_STATE')
    }
  }

  exit(statusCode = 0) {
    this.processStatus = 'terminated'
    if (this.emscripten) {
      const { FS, exit, JSEvents } = this.emscripten
      exit(statusCode)
      FS.unmount('/home')
      JSEvents.removeAllEventListeners()
    }
    this.cleanupDOM()
    // @ts-expect-error try to focus on previous active element
    this.previousActiveElement?.focus?.()
  }

  resize(width: number, height: number) {
    const { Module } = this.emscripten
    Module.setCanvasSize(width, height)
  }

  private async setupFileSystem() {
    const { Module, FS, PATH, ERRNO_CODES } = this.emscripten

    Module.canvas = this.options.element
    Module.preRun = [
      () =>
        FS.init(() => {
          return this.stdin()
        }),
    ]

    const emscriptenFS = await createEmscriptenFS({ FS, PATH, ERRNO_CODES })
    FS.mount(emscriptenFS, { root: '/home' }, '/home')

    if (this.options.rom.length > 0) {
      FS.mkdirTree(`${raUserdataDir}content/`)
    }

    // a hack used for waiting for wasm's instantiation.
    // it's dirty but it works
    const maxWaitTime = 100
    let waitTime = 0
    while (!Module.asm && waitTime < maxWaitTime) {
      await delay(10)
      waitTime += 5
    }

    await Promise.all(
      this.options.rom.map(async ({ fileName, fileContent }) => {
        const buffer = await blobToBuffer(fileContent)
        FS.createDataFile('/', fileName, buffer, true, false)
        const data = FS.readFile(fileName, { encoding: 'binary' })
        FS.writeFile(`${raUserdataDir}content/${fileName}`, data, { encoding: 'binary' })
        FS.unlink(fileName)
      }),
    )

    await Promise.all(
      this.options.bios.map(async ({ fileName, fileContent }) => {
        const buffer = await blobToBuffer(fileContent)
        FS.createDataFile('/', fileName, buffer, true, false)
        const data = FS.readFile(fileName, { encoding: 'binary' })
        FS.writeFile(`${raUserdataDir}system/${fileName}`, data, { encoding: 'binary' })
        FS.unlink(fileName)
      }),
    )
  }

  private async setupEmscripten() {
    // @ts-expect-error for retroarch fast forward
    if (typeof window === 'object') {
      // @ts-expect-error for retroarch fast forward
      window.setImmediate ??= window.setTimeout
    }

    const jsContent = `
    export function getEmscripten({ Module }) {
      ${this.options.core.js}
      return { PATH, FS, ERRNO_CODES, JSEvents, ENV, Module, exit: _emscripten_force_exit }
    }
    `
    const jsBlob = new Blob([jsContent], { type: 'application/javascript' })
    const jsBlobUrl = URL.createObjectURL(jsBlob)
    if (!jsBlobUrl) {
      return
    }
    const { getEmscripten } = await import(jsBlobUrl)
    URL.revokeObjectURL(jsBlobUrl)

    const initialModule = getEmscriptenModuleOverrides({ wasmBinary: this.options.core.wasm })
    this.emscripten = getEmscripten({ Module: initialModule })

    const { Module } = this.emscripten
    await Promise.all([await this.setupFileSystem(), await Module.monitorRunDependencies()])
  }
  private sendCommand(msg: RetroArchCommand) {
    const bytes = encoder.encode(`${msg}\n`)
    this.messageQueue.push([bytes, 0])
  }

  // copied from https://github.com/libretro/RetroArch/pull/15017
  private stdin() {
    const { messageQueue } = this
    // Return ASCII code of character, or null if no input
    while (messageQueue.length > 0) {
      const msg = messageQueue[0][0]
      const index = messageQueue[0][1]
      if (index >= msg.length) {
        messageQueue.shift()
      } else {
        messageQueue[0][1] = index + 1
        // assumption: msg is a uint8array
        return msg[index]
      }
    }
    return null
  }

  private writeConfigFile({ path, config }) {
    const { FS } = this.emscripten
    const dir = path.slice(0, path.lastIndexOf('/'))
    FS.mkdirTree(dir)
    for (const key in config) {
      config[key] = `__${config[key]}__`
    }
    // @ts-expect-error `platform` option is not listed in @types/ini for now
    let configContent = ini.stringify(config, { whitespace: true, platform: 'linux' })
    configContent = configContent.replaceAll('__', '"')
    FS.writeFile(path, configContent)
  }

  private async setupRaConfigFile() {
    this.writeConfigFile({ path: raConfigPath, config: this.options.retroarch })
  }

  private setupRaCoreConfigFile() {
    const raCoreConfig = {
      // ...defaultRetroarchCoresConfig[this.core],
      // ...this.coreConfig?.[this.core],
    }
    // if (Object.keys(raCoreConfig)) {
    //   const coreFullName = coreFullNameMap[this.core]
    //   const raCoreConfigPath = join(raCoreConfigDir, coreFullName, `${coreFullName}.opt`)
    //   this.writeConfigFile({ path: raCoreConfigPath, config: raCoreConfig })
    // }
  }

  private runMain() {
    const { Module, JSEvents } = this.emscripten
    const raArgs: string[] = []
    if (this.options.rom.length > 0) {
      const [{ fileName }] = this.options.rom
      raArgs.push(`/home/web_user/retroarch/userdata/content/${fileName}`)
    }
    Module.callMain(raArgs)

    this.gameStatus = 'running'

    // tell retroarch that controllers are connected
    for (const gamepad of navigator.getGamepads?.() ?? []) {
      if (gamepad) {
        window.dispatchEvent(new GamepadEvent('gamepadconnected', { gamepad }))
      }
    }

    if (this.options) {
      return
    }

    // Emscripten module register keyboard events to document, which make custome interactions unavilable.
    // Let's modify the default event liseners
    const keyboardEvents = new Set(['keyup', 'keydown', 'keypress'])
    const globalKeyboardEventHandlers = JSEvents.eventHandlers.filter(
      ({ eventTypeString, target }) => keyboardEvents.has(eventTypeString) && target === document,
    )
    for (const globalKeyboardEventHandler of globalKeyboardEventHandlers) {
      const { eventTypeString, target, handlerFunc } = globalKeyboardEventHandler
      JSEvents.registerOrRemoveHandler({ eventTypeString, target })
      JSEvents.registerOrRemoveHandler({
        ...globalKeyboardEventHandler,
        handlerFunc: (...args) => {
          const [event] = args
          if (event?.target === this.options.element) {
            handlerFunc(...args)
          }
        },
      })
    }
  }

  private async waitForEmscriptenFile(fileName) {
    const { FS } = this.emscripten
    const maxRetries = 30
    let buffer
    let isFinished = false
    let retryTimes = 0
    while (retryTimes <= maxRetries && !isFinished) {
      const delayTime = Math.min(100 * 2 ** retryTimes, 1000)
      await delay(delayTime)
      try {
        const newBuffer = FS.readFile(fileName).buffer
        isFinished = buffer?.byteLength > 0 && buffer?.byteLength === newBuffer.byteLength
        buffer = newBuffer
      } catch (error) {
        console.warn(error)
      }
      retryTimes += 1
    }
    if (!isFinished) {
      throw new Error('fs timeout')
    }
    return buffer
  }

  private clearStateFile() {
    const { FS } = this.emscripten
    try {
      FS.unlink(this.stateFileName)
      FS.unlink(this.stateThumbnailFileName)
    } catch {}
  }

  private cleanupDOM() {
    this.options.element.remove()
  }
}
