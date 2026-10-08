// Service Worker: Background scheduler and parser to fetch data even if tab is CLOSED
const ALARM_NAME = 'WEB_SNIP_REFRESH_ALARM';

chrome.runtime.onInstalled.addListener(() => {
  console.log('Web Snip PiP Extension Installed');
});

// Periodic background alarm listener
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await performBackgroundFetch();
  }
});

// Message handler from popup or content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SET_BACKGROUND_TIMER') {
    const minutes = parseFloat(request.intervalMinutes);
    scheduleAlarm(minutes);
    sendResponse({ status: 'ok' });
  } else if (request.action === 'MANUAL_REFRESH') {
    performBackgroundFetch().then((result) => {
      sendResponse(result);
    });
    return true; // async sendResponse
  }
});

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

// Background fetcher: runs even when tab is completely closed
async function performBackgroundFetch() {
  const data = await chrome.storage.local.get(['snipTarget']);
  if (!data || !data.snipTarget || !data.snipTarget.url || !data.snipTarget.selector) {
    return { status: 'error', message: 'No section selected yet' };
  }

  const { url, selector } = data.snipTarget;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }

    const html = await response.text();
    const extractedText = extractTextFromHtml(html, selector);

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (extractedText && extractedText.trim().length > 0) {
      const updatedData = {
        text: extractedText,
        lastUpdated: timeStr,
        lastUpdatedTimestamp: Date.now()
      };

      await chrome.storage.local.set({ snipData: updatedData });

      chrome.runtime.sendMessage({
        action: 'SNIP_DATA_UPDATED',
        data: updatedData
      }).catch(() => {});

      return { status: 'ok', data: updatedData };
    } else {
      // If server-side HTML didn't return text (e.g. CSR SPA like RescueTime),
      // keep last known text and touch timestamp
      const cached = await chrome.storage.local.get(['snipData']);
      const textToKeep = (cached.snipData && cached.snipData.text) || data.snipTarget.lastKnownText || '';
      
      const updatedData = {
        text: textToKeep,
        lastUpdated: timeStr,
        lastUpdatedTimestamp: Date.now()
      };

      await chrome.storage.local.set({ snipData: updatedData });

      chrome.runtime.sendMessage({
        action: 'SNIP_DATA_UPDATED',
        data: updatedData
      }).catch(() => {});

      return { status: 'ok', data: updatedData };
    }
  } catch (err) {
    console.error('Background fetch failed:', err);
    return { status: 'error', message: err.message };
  }
}

// Robust HTML extractor for background service worker
function extractTextFromHtml(html, selector) {
  if (!selector) return null;

  // 1. If selector has an ID
  const idMatch = selector.match(/#([a-zA-Z0-9_\-]+)/);
  if (idMatch) {
    const id = idMatch[1];
    const regex = new RegExp(`<[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/`, 'i');
    const m = html.match(regex);
    if (m && m[1]) return cleanHtmlTags(m[1]);
  }

  // 2. If selector has data-testid
  const testIdMatch = selector.match(/\[data-testid=["']([^"']+)["']\]/);
  if (testIdMatch) {
    const val = testIdMatch[1];
    const regex = new RegExp(`<[^>]*data-testid=["']${val}["'][^>]*>([\\s\\S]*?)<\\/`, 'i');
    const m = html.match(regex);
    if (m && m[1]) return cleanHtmlTags(m[1]);
  }

  // 3. Class match
  const classMatches = selector.match(/\.([a-zA-Z0-9_\-]+)/g);
  if (classMatches && classMatches.length > 0) {
    const targetClass = classMatches[classMatches.length - 1].replace('.', '');
    const regex = new RegExp(`<[^>]*class=["'][^"']*\\b${targetClass}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/`, 'i');
    const m = html.match(regex);
    if (m && m[1]) return cleanHtmlTags(m[1]);
  }

  return null;
}

function cleanHtmlTags(str) {
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
