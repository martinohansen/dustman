'use strict'

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
