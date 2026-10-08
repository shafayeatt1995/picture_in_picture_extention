document.addEventListener('DOMContentLoaded', () => {
  const sideDomain = document.getElementById('sideDomain');
  const sideContent = document.getElementById('sideContent');
  const sideUpdated = document.getElementById('sideUpdated');
  const sideRefreshBtn = document.getElementById('sideRefreshBtn');

  function updateDisplay() {
    chrome.storage.local.get(['snipTarget', 'snipData'], (res) => {
      if (res.snipTarget) {
        try {
          const u = new URL(res.snipTarget.url);
          sideDomain.textContent = u.hostname;
        } catch (e) {
          sideDomain.textContent = 'Live Snip';
        }
      }

      if (res.snipData && res.snipData.text) {
        sideContent.textContent = res.snipData.text;
        sideUpdated.textContent = `Updated: ${res.snipData.lastUpdated || 'Just now'}`;
      } else {
        sideContent.textContent = 'No section selected yet. Open any page and click Select Section.';
      }
    });
  }

  updateDisplay();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'SNIP_DATA_UPDATED') {
      updateDisplay();
    }
  });

  sideRefreshBtn.addEventListener('click', () => {
    sideContent.style.opacity = '0.5';
    chrome.runtime.sendMessage({ action: 'MANUAL_REFRESH' }, () => {
      sideContent.style.opacity = '1';
      updateDisplay();
    });
  });
});
