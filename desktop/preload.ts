import { contextBridge, ipcRenderer } from 'electron'
import { createHiveWindow } from '../src/interfaces/desktop/preload-bridge.js'

/**
 * The preload: builds the typed bridge and freezes it onto the window.
 *
 * Nothing else lives here. The allowlist, the envelope handling, and the channel
 * naming all come from `preload-bridge.ts`, which is tested without Electron;
 * this file is only the Electron-specific glue of `contextBridge` + `ipcRenderer`.
 */
contextBridge.exposeInMainWorld('hive', createHiveWindow(ipcRenderer))
