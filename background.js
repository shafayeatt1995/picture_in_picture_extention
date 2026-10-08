// Service Worker: Background scheduler and parser to fetch data even if tab is CLOSED
const ALARM_NAME = 'WEB_SNIP_REFRESH_ALARM';

chrome.runtime.onInstalled.addListener(() => {
  console.log('Web Snip PiP Extension Installed');
});

// Periodic background alarm listener: reloads target tab safely without any CORS error
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await reloadTargetTabAndScrape();
  }
});

// Message handler from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SET_BACKGROUND_TIMER') {
    const minutes = parseFloat(request.intervalMinutes);
    scheduleAlarm(minutes);
    sendResponse({ status: 'ok' });
  } else if (request.action === 'MANUAL_REFRESH' || request.action === 'RELOAD_TARGET_TAB_AND_SCRAPE') {
    reloadTargetTabAndScrape().then((result) => {
      sendResponse(result);
    });
    return true; // async sendResponse
  }
});

// Actually reloads the website tab in background, waits for client JS to render, and scrapes fresh data!
async function reloadTargetTabAndScrape() {
  const store = await chrome.storage.local.get(['snipTarget']);
  if (!store || !store.snipTarget || !store.snipTarget.url) {
    return { status: 'error', message: 'No target URL' };
  }

  const { url, selector } = store.snipTarget;

  // Find if tab is currently open
  const tabs = await chrome.tabs.query({ url: url.split('#')[0] + '*' });
  let targetTabId = null;

  if (tabs.length > 0) {
    targetTabId = tabs[0].id;
    // Reload open tab
    await chrome.tabs.reload(targetTabId);
  } else {
    // If user closed tab, create tab in background without focusing
    const newTab = await chrome.tabs.create({ url: url, active: false });
    targetTabId = newTab.id;
  }

  // Wait for page to load and SPA scripts (like RescueTime timer) to render
  return new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === targetTabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);

        // Give React/SPA 1.5s to calculate and display the live time
        setTimeout(async () => {
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: targetTabId },
              func: (sel) => {
                const el = document.querySelector(sel);
                return el ? (el.innerText || el.textContent || '').trim() : null;
              },
              args: [selector]
            });

            if (results && results[0] && results[0].result) {
              const freshText = results[0].result;
              const now = new Date();
              const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

              const updatedData = {
                text: freshText,
                lastUpdated: timeStr,
                lastUpdatedTimestamp: Date.now()
              };

              await chrome.storage.local.set({ snipData: updatedData });

              chrome.runtime.sendMessage({
                action: 'SNIP_DATA_UPDATED',
                data: updatedData
              }).catch(() => {});

              resolve({ status: 'ok', data: updatedData });
              return;
            }
          } catch (e) {
            console.error('Script injection scrape error:', e);
          }
          resolve({ status: 'ok' });
        }, 1500);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Timeout safety after 15s
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ status: 'timeout' });
    }, 15000);
  });
}

function scheduleAlarm(minutes) {
  chrome.alarms.clear(ALARM_NAME, () => {
    if (minutes > 0) {
      chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: Math.max(0.5, minutes)
      });
      console.log(`Alarm scheduled every ${minutes} minutes`);
    } else {
      console.log('Alarm cancelled (interval is 0)');
    }
  });
}


