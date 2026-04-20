// Swallow harmless "Could not establish connection" rejections from sendMessage
// when no content script is present in the active tab. These are benign in this
// extension's design and only clutter the error surface of chrome://extensions.
self.addEventListener('unhandledrejection', e => {
  const msg = e.reason && e.reason.message || ''
  if (msg.includes('Could not establish connection') ||
      msg.includes('Receiving end does not exist')) {
    e.preventDefault()
  }
})

import {gimmeToggle} from "./contextmenu/launcher.js"
import {getColorMode} from "./contextmenu/colormode.js"
import {getColorScheme} from "./contextmenu/colorscheme.js"

const state = {
  loaded:   {},
  injected: {},
}

var platform = typeof browser === 'undefined'
  ? chrome
  : browser

const toggleIn = ({id:tab_id}) => {
  const swallow = p => { if (p && typeof p.catch === 'function') p.catch(() => {}) }

  // toggle out: it's currently loaded and injected
  if (state.loaded[tab_id] && state.injected[tab_id]) {
    swallow(platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/eject.js'],
    }))
    state.injected[tab_id] = false
  }

  // toggle in: it's loaded and needs injected
  else if (state.loaded[tab_id] && !state.injected[tab_id]) {
    swallow(platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/restore.js'],
    }))
    state.injected[tab_id] = true
    getColorMode()
    getColorScheme()
  }

  // fresh start in tab
  else {
    swallow(platform.scripting.insertCSS({
      target: {tabId: tab_id},
      files: ['toolbar/bundle.css' ],
    }))
    swallow(platform.scripting.executeScript({
      target: {tabId: tab_id},
      files: ['toolbar/inject.js'],
    }))

    state.loaded[tab_id]    = true
    state.injected[tab_id]  = true
    getColorMode()
    getColorScheme()
  }

  platform.tabs.onUpdated.addListener(function(tabId) {
    if (tabId === tab_id)
      state.loaded[tabId] = false
  })
}

gimmeToggle(toggleIn)
