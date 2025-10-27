'use strict'

// ============================================================================
// lib/state.js
// ============================================================================

/**
 * @typedef Settings
 * @type {object}
 * @property {number} maxInactiveMilliseconds
 * @property {integer} minTabsCount
 * @property {integer} maxHistorySize
 * @property {boolean} clearHistoryOnExit
 * @property {boolean} excludeTabsInGroups
 */

const defaultSettings = {
  minInactiveMilliseconds: 20 * 60 * 1000,
  minTabsCount: 5,
  maxHistorySize: 1000,
  clearHistoryOnExit: true,
  excludeTabsInGroups: false
}

/**
 * @typedef ClosedPageInfo
 * @type {object}
 * @property {String} url
 * @property {String} title
 * @property {String} favIconUrl
 */

/**
 * @typedef State
 * @type {object}
 * @property {Settings} settings
 * @property {integer} autocloseTimeoutId
 * @property {boolean} paused
 * @property {Array.<ClosedPageInfo>} history
 */

/**
 * Load the persistent state from storage if possible, and otherwise set
 * everything to defaults
 * @return {Promise.<PersistentState>}
 */
function loadState () {
  return browser.storage.local.get().then(state => state, err => {
    console.log(err)
    return {settings: defaultSettings}
  }).then(state => {
    if (state.settings == null) {
      state.settings = defaultSettings
    }
    if (state.history == null) {
      state.history = []
    }
    state.autocloseTimeoutId = 0
    state.paused = false

    // handle settings from previous versions of dustman
    const settings = state.settings

    if (settings.saveClosedPages != null) {
      if (settings.saveClosedPages=== true) {
        settings.maxHistorySize = defaultSettings.maxHistorySize
      } else {
        settings.maxHistorySize = 0
      }
      delete settings.saveClosedPages
    }

    if (settings.clearHistoryOnExit == null) {
      settings.clearHistoryOnExit = defaultSettings.clearHistoryOnExit
    }

    if (settings.excludeTabsInGroups == null) {
      settings.excludeTabsInGroups = defaultSettings.excludeTabsInGroups
    }
    return state
  })
}

/**
 * Save settings to storage.
 * @param {Settings} settings
 * @return {Promise.<()>}
 */
function persistSettings (settings) {
  return browser.storage.local.set({settings: settings})
}

/**
 * Save history to disk, or delete history on disk (depending on settings).
 * @param {State} state
 * @return {Promise.<()>}
 */
function persistHistory (state) {
  if (state.settings.clearHistoryOnExit === false) {
    return browser.storage.local.set({history: state.history})
  } else {
    return browser.storage.local.remove('history')
  }
}

// ============================================================================
// lib/autoclose.js
// ============================================================================

/**
 * @typedef TabInfo
 * @type {object}
 * @property {integer} tabId
 * @property {integer} windowId
 * @property {number} inactiveMilliseconds - milliseconds since last activity in the tab
 * @property {boolean} pinned - whether the tab is pinned
 * @property {boolean} seen - whether the tab has been seen by the user at least once
 */

/**
 * @typedef CloseInfo
 * @type {object}
 * @property {Array.<integer>} tabIds
 * @property {number} millisecondsUntilNextCheck - potentially Infinity if no tab can be closed at some point in the future
 */

/**
 * Get a list of tabs that should be closed, as well as the time when another
 * tab can be closed (if any).
 * @param {number} now - milliseconds since the epoch
 * @param {Settings} settings
 * @param {Array.<browser.tabs.Tab>} tabs
 * @return {CloseInfo}
 */
function tabsToClose (now, settings, tabs) {
  const windowIds = Array.from(new Set(tabs.map(tab => tab.windowId)))
  const tabsByWindow = windowIds.map(windowId => tabs.filter(tab => tab.windowId === windowId))

  const perWindowResults = tabsByWindow.map(tabs => {
    const unpinnedTabs = tabs.filter(tab => !tab.pinned)
    const numTabsToClose = unpinnedTabs.length - settings.minTabsCount
    if (numTabsToClose <= 0) {
      return {tabsToClose: [], nextCheck: Infinity}
    }

    // closeable tabs (now or in the future), sorted from longest to shortest inactivity
    const closeableTabs =
      unpinnedTabs.filter(tab => {
        // Filter out audible tabs and tabs with no lastAccessed timestamp
        if (tab.audible === true || tab.lastAccessed >= Infinity) {
          return false
        }
        // Filter out grouped tabs if the setting is enabled
        if (settings.excludeTabsInGroups && tab.groupId != null && tab.groupId !== -1) {
          return false
        }
        return true
      })
      .sort((t1, t2) => t1.lastAccessed > t2.lastAccessed)

    const nowCloseableTabs =
      closeableTabs.filter(tab => tab.lastAccessed + settings.minInactiveMilliseconds < now)
    const onlyLaterCloseableTabs =
      closeableTabs.filter(tab => tab.lastAccessed + settings.minInactiveMilliseconds >= now)

    const tabsToClose = nowCloseableTabs.slice(0, numTabsToClose)
    var nextCheck
    if (tabsToClose.length === numTabsToClose || onlyLaterCloseableTabs.length === 0) {
      nextCheck = Infinity
    } else {
      nextCheck = onlyLaterCloseableTabs[0].lastAccessed + settings.minInactiveMilliseconds
    }

    return {tabsToClose, nextCheck}
  })

  const tabsToClose =
    Array.prototype.concat.apply([], perWindowResults.map(res => res.tabsToClose))

  const nextCheck =
    Math.min.apply(null, perWindowResults.map(res => res.nextCheck))

  return {tabsToClose, nextCheck}
}

/**
 * Whether a tab can be saved to the panel.
 * @param {browser.tabs.Tab} tab
 * @return {boolean}
 */
function saveableTab (tab) {
  if (tab.title == null || tab.url == null) {
    return false
  }

  const protocol = new URL(tab.url).protocol
  if (['chrome:', 'javascript:', 'data:', 'file:', 'about:'].indexOf(protocol) >= 0) {
    return false
  }

  if (tab.incognito === true) {
    return false
  }

  return true
}

/**
 * Auto-close old tabs. Also clears the alarm and sets a new one for the next
 * auto-close if appropriate.
 * @param {State} state
 * @return {Promise.<()>}
 */
function autoclose (state) {
  // Clear any existing alarm
  browser.alarms.clear('autoclose')

  if (state.paused) {
    return Promise.resolve()
  }

  return browser.tabs.query({windowType: 'normal'}).then(tabs => {
    const now = new Date().getTime()
    const {tabsToClose: tabsToClose_, nextCheck} = tabsToClose(now, state.settings, tabs)

    if (nextCheck < Infinity) {
      // check again at nextCheck + some tolerance
      const delayInMinutes = (nextCheck - now + 1000) / 1000 / 60
      browser.alarms.create('autoclose', {delayInMinutes})
    }

    return browser.tabs.remove(tabsToClose_.map(tab => tab.id)).then(() => {
      if (state.settings.maxHistorySize > 0) {
        const history =
          tabsToClose_
            .filter(saveableTab)
            .map(tab => ({title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl}))
        state.history =
          history.concat(state.history).slice(0, state.settings.maxHistorySize)
        if (state.settings.clearHistoryOnExit === false) {
          return persistHistory(state)
        }
      }
    })
  })
}

// ============================================================================
// lib/browseraction.js
// ============================================================================

function updateBrowserAction (state) {
  if (
    browser.action.setBadgeText == null ||
    browser.action.setBadgeBackgroundColor == null ||
    browser.action.setTitle == null ||
    browser.action.setPopup == null
  ) {
    return
  }

  if (state.paused === true) {
    browser.action.setBadgeText({text: browser.i18n.getMessage('buttonBadgePaused')}) //🚫'})
    browser.action.setBadgeBackgroundColor({color: [0, 0, 0, 0]})
    browser.action.setTitle({title: browser.i18n.getMessage('buttonTooltipPaused')})
  } else {
    browser.action.setBadgeText({text: ''})
    browser.action.setTitle({title: browser.i18n.getMessage('buttonTooltip')})
  }

  if (state.settings.maxHistorySize > 0) {
    browser.action.setPopup(
      {popup: browser.runtime.getURL(browser.runtime.getManifest().action.default_popup)}
    )
  } else {
    browser.action.setPopup({popup: ''})
  }
}

// ============================================================================
// Main background script logic
// ============================================================================

loadState().then(state => {
  // make the state available via the window of the background page
  window.state = state

  browser.action.onClicked.addListener(() => {
    state.paused = !state.paused
    updateBrowserAction(state)
    autoclose(state)
  })
  updateBrowserAction(state)

  browser.tabs.onCreated.addListener(() => {
    autoclose(state)
  })
  browser.tabs.onAttached.addListener(() => autoclose(state))
  browser.tabs.onUpdated.addListener(changeInfo => {
    if (changeInfo.pinned === false || changeInfo.audible === false) {
      autoclose(state)
    }
  })

  browser.storage.onChanged.addListener(changes => {
    if ('settings' in changes) {
      state.settings = changes.settings.newValue

      updateBrowserAction(state)

      state.history = state.history.slice(0, state.settings.maxHistorySize)
      persistHistory(state)

      autoclose(state)
    }
  })

  // Handle alarm for autoclose
  browser.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === 'autoclose') {
      autoclose(state)
    }
  })

  return autoclose(state)
})
