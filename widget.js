document.addEventListener('DOMContentLoaded', () => {
  const widgetDomain = document.getElementById('widgetDomain');
  const widgetContent = document.getElementById('widgetContent');
  const widgetUpdatedTime = document.getElementById('widgetUpdatedTime');
  const countdownTag = document.getElementById('countdownTag');
  const widgetRefreshBtn = document.getElementById('widgetRefreshBtn');

  let remainingSeconds = 600;
  let timerInterval = null;

  function loadState() {
    chrome.storage.local.get(['snipTarget', 'snipData', 'refreshMinutesVal'], (res) => {
      if (res.snipTarget) {
        try {
          const u = new URL(res.snipTarget.url);
          widgetDomain.textContent = u.hostname;
        } catch (e) {
          widgetDomain.textContent = 'Live Snip';
        }
      }

      if (res.snipData && res.snipData.text) {
        widgetContent.textContent = res.snipData.text;
        widgetUpdatedTime.textContent = `Updated: ${res.snipData.lastUpdated || 'Just now'}`;
      }

      const mins = res.refreshMinutesVal !== undefined ? parseFloat(res.refreshMinutesVal) : 10;
      if (mins > 0) {
        resetTimer(mins);
      } else {
        countdownTag.textContent = 'Off';
      }
    });
  }

  function resetTimer(mins) {
    clearInterval(timerInterval);
    remainingSeconds = Math.round(mins * 60);
    updateCountdownDisplay();

    timerInterval = setInterval(() => {
      remainingSeconds--;
      updateCountdownDisplay();
      if (remainingSeconds <= 0) {
        clearInterval(timerInterval);
        performTabReloadAndScrape();
      }
    }, 1000);
  }

  function updateCountdownDisplay() {
    const m = Math.floor(remainingSeconds / 60);
    const s = remainingSeconds % 60;
    countdownTag.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Reloads the actual target tab in Chrome, waits for fresh SPA render, and grabs new data
  function performTabReloadAndScrape() {
    widgetContent.style.opacity = '0.5';
    countdownTag.textContent = 'Reloading...';

    chrome.runtime.sendMessage({ action: 'RELOAD_TARGET_TAB_AND_SCRAPE' }, (res) => {
      widgetContent.style.opacity = '1';
      loadState();
    });
  }

  // Live message update from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'SNIP_DATA_UPDATED') {
      if (msg.data && msg.data.text) {
        widgetContent.textContent = msg.data.text;
        widgetUpdatedTime.textContent = `Updated: ${msg.data.lastUpdated}`;
      }
    }
  });

  widgetRefreshBtn.addEventListener('click', () => {
    performTabReloadAndScrape();
  });

  loadState();
});
