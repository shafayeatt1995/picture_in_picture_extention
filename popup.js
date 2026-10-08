document.addEventListener('DOMContentLoaded', async () => {
  const snipDisplay = document.getElementById('snipDisplay');
  const sourceDomain = document.getElementById('sourceDomain');
  const lastUpdatedTime = document.getElementById('lastUpdatedTime');
  const manualRefreshBtn = document.getElementById('manualRefreshBtn');
  const refreshMinutesInput = document.getElementById('refreshMinutes');
  const chips = document.querySelectorAll('.chip');
  const selectElementBtn = document.getElementById('selectElementBtn');
  const floatingPipBtn = document.getElementById('floatingPipBtn');
  const statusToast = document.getElementById('statusToast');

  const pipModeSelect = document.getElementById('pipModeSelect');
  const modeDescText = document.getElementById('modeDescText');

  // Load saved state (selected content, domain, timer, pipMode)
  chrome.storage.local.get(['snipTarget', 'snipData', 'refreshMinutesVal', 'pipModeVal'], (res) => {
    if (res.snipTarget) {
      try {
        const u = new URL(res.snipTarget.url);
        sourceDomain.textContent = u.hostname;
      } catch (e) {
        sourceDomain.textContent = 'Selected Content';
      }
    }

    if (res.snipData) {
      renderSnipText(res.snipData.text, res.snipData.lastUpdated);
    }

    if (res.refreshMinutesVal !== undefined) {
      refreshMinutesInput.value = res.refreshMinutesVal;
      updateActiveChip(res.refreshMinutesVal);
    }

    if (res.pipModeVal && pipModeSelect) {
      pipModeSelect.value = res.pipModeVal;
      updateModeDescription(res.pipModeVal);
    }
  });

  if (pipModeSelect) {
    pipModeSelect.addEventListener('change', () => {
      const mode = pipModeSelect.value;
      chrome.storage.local.set({ pipModeVal: mode });
      updateModeDescription(mode);
    });
  }

  function updateModeDescription(mode) {
    if (!modeDescText) return;
    if (mode === 'video') {
      modeDescText.textContent = 'Clean video stream without title bar. Hover shows ✕.';
    } else {
      modeDescText.textContent = 'Native interactive HTML window with domain title bar & scroll.';
    }
  }

  // Listen for background updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'SNIP_DATA_UPDATED' && msg.data) {
      renderSnipText(msg.data.text, msg.data.lastUpdated);
    }
  });

  function renderSnipText(text, time) {
    if (!text) return;
    snipDisplay.innerHTML = `<span style="font-weight: 500;">${escapeHtml(text)}</span>`;
    lastUpdatedTime.textContent = time ? `Updated: ${time}` : 'Updated: Just now';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function updateActiveChip(val) {
    chips.forEach(chip => {
      if (parseFloat(chip.dataset.min) === parseFloat(val)) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
  }

  function showToast(text, isError = false) {
    statusToast.textContent = text;
    statusToast.classList.remove('hidden');
    statusToast.style.borderColor = isError ? 'rgba(239, 68, 68, 0.4)' : 'rgba(59, 130, 246, 0.4)';
    statusToast.style.color = isError ? '#fca5a5' : '#93c5fd';
    setTimeout(() => {
      statusToast.classList.add('hidden');
    }, 2800);
  }

  // Timer input handler
  refreshMinutesInput.addEventListener('input', () => {
    const val = parseFloat(refreshMinutesInput.value);
    const sanitized = isNaN(val) ? 0 : val;
    chrome.storage.local.set({ refreshMinutesVal: sanitized });
    updateActiveChip(sanitized);

    // Update background alarm so it ticks even if tab/browser is closed
    chrome.runtime.sendMessage({
      action: 'SET_BACKGROUND_TIMER',
      intervalMinutes: sanitized
    });
  });

  // Chips click handler
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      const min = parseFloat(chip.dataset.min);
      refreshMinutesInput.value = min;
      chrome.storage.local.set({ refreshMinutesVal: min });
      updateActiveChip(min);

      chrome.runtime.sendMessage({
        action: 'SET_BACKGROUND_TIMER',
        intervalMinutes: min
      });
    });
  });

  // Manual refresh click handler with spinner animation
  if (manualRefreshBtn) {
    manualRefreshBtn.addEventListener('click', async () => {
      manualRefreshBtn.classList.add('spinning');
      
      chrome.runtime.sendMessage({ action: 'MANUAL_REFRESH' }, (res) => {
        if (chrome.runtime.lastError) {
          manualRefreshBtn.classList.remove('spinning');
          showToast('Could not reach background worker', true);
          return;
        }

        manualRefreshBtn.classList.remove('spinning');
        if (res && res.status === 'ok') {
          renderSnipText(res.data.text, res.data.lastUpdated);
          showToast('Updated successfully!');
        } else if (res && res.status === 'partial') {
          renderSnipText(res.data.text, res.data.lastUpdated);
          showToast('Cached text updated');
        } else {
          showToast(res && res.message ? res.message : 'No target selected yet', true);
        }
      });
    });
  }

  // Select Element on page button
  if (selectElementBtn) {
    selectElementBtn.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        showToast('No active tab found', true);
        return;
      }

      if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
        showToast('Cannot run on internal pages', true);
        return;
      }

      const min = refreshMinutesInput ? (parseFloat(refreshMinutesInput.value) || 10) : 10;
      const mode = pipModeSelect ? pipModeSelect.value : 'video';

      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'START_ELEMENT_PICKER',
          refreshIntervalMinutes: min,
          pipMode: mode
        });
        window.close();
      } catch (err) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
          await chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content.css']
          });
          setTimeout(async () => {
            await chrome.tabs.sendMessage(tab.id, {
              action: 'START_ELEMENT_PICKER',
              refreshIntervalMinutes: min,
              pipMode: mode
            });
            window.close();
          }, 120);
        } catch (e) {
          showToast('Please reload webpage first', true);
        }
      }
    });
  }

  // Floating PiP (Always on Top window) toggle button
  if (floatingPipBtn) {
    floatingPipBtn.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;

      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'TRIGGER_PIP_FROM_POPUP' });
        window.close();
      } catch (e) {
        showToast('Select a section on the page first', true);
      }
    });
  }

  // Open Standalone Floating Window (Can reload tab in background without closing this window!)
  const openWidgetWindowBtn = document.getElementById('openWidgetWindowBtn');
  if (openWidgetWindowBtn) {
    openWidgetWindowBtn.addEventListener('click', () => {
      chrome.windows.create({
        url: chrome.runtime.getURL('widget.html'),
        type: 'popup',
        width: 360,
        height: 240,
        focused: true
      });
      window.close();
    });
  }

  // Open persistent Side Panel (Never closes when active tab is closed)
  const openSidePanelBtn = document.getElementById('openSidePanelBtn');
  if (openSidePanelBtn) {
    openSidePanelBtn.addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (chrome.sidePanel && tab && tab.windowId) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        window.close();
      } else {
        showToast('Side panel not supported in this window', true);
      }
    });
  }
});
