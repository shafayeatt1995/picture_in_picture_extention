// Content Script: Handles interactive element picking and Picture-in-Picture window management

(function() {
  if (window.__webSnipPipInitialized) return;
  window.__webSnipPipInitialized = true;

  let isPickerActive = false;
  let hoveredElement = null;
  let currentOverlay = null;
  let pipWindow = null;
  let refreshTimerId = null;
  let lastSelectedSelector = null;
  let chosenRefreshIntervalMinutes = 10;

  // Listen for messages from popup or background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'START_ELEMENT_PICKER') {
      chosenRefreshIntervalMinutes = request.refreshIntervalMinutes || 10;
      startElementPicker();
      sendResponse({ status: 'ok' });
    } else if (request.action === 'CLOSE_PIP') {
      closePip();
      sendResponse({ status: 'ok' });
    } else if (request.action === 'TRIGGER_PIP_FROM_POPUP') {
      if (lastSelectedSelector) {
        const el = document.querySelector(lastSelectedSelector);
        if (el) openDocumentPip(el, lastSelectedSelector);
      }
      sendResponse({ status: 'ok' });
    }
    return true;
  });

  // Check if saved PIP exists after reload
  const savedPipInfo = sessionStorage.getItem('__webSnipPip_active');
  if (savedPipInfo) {
    try {
      const parsed = JSON.parse(savedPipInfo);
      chosenRefreshIntervalMinutes = parsed.intervalMinutes;
      lastSelectedSelector = parsed.selector;
      sessionStorage.removeItem('__webSnipPip_active');

      // Wait for DOM ready, then reopen PiP window
      window.addEventListener('load', () => {
        setTimeout(() => {
          reopenPipAfterReload(lastSelectedSelector);
        }, 600);
      });
    } catch (e) {
      console.error(e);
    }
  }

  function createHoverOverlay() {
    if (currentOverlay) return;
    currentOverlay = document.createElement('div');
    currentOverlay.id = '__web_snip_pip_hover_box';
    currentOverlay.innerHTML = `
      <div id="__web_snip_pip_tooltip">
        <span>Click to open in Always-On-Top Floating Window</span>
        <kbd>Esc to cancel</kbd>
      </div>
    `;
    document.body.appendChild(currentOverlay);
  }

  function removeHoverOverlay() {
    if (currentOverlay) {
      currentOverlay.remove();
      currentOverlay = null;
    }
  }

  function startElementPicker() {
    if (isPickerActive) return;
    isPickerActive = true;
    createHoverOverlay();

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stopElementPicker() {
    isPickerActive = false;
    removeHoverOverlay();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function onMouseMove(e) {
    if (!isPickerActive) return;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === currentOverlay || currentOverlay.contains(target)) return;

    hoveredElement = target;
    const rect = target.getBoundingClientRect();
    currentOverlay.style.top = `${rect.top + window.scrollY}px`;
    currentOverlay.style.left = `${rect.left + window.scrollX}px`;
    currentOverlay.style.width = `${rect.width}px`;
    currentOverlay.style.height = `${rect.height}px`;
    currentOverlay.style.display = 'block';
  }

  function onClick(e) {
    if (!isPickerActive) return;
    e.preventDefault();
    e.stopPropagation();

    const selected = hoveredElement;
    stopElementPicker();

    if (selected) {
      const selector = generateUniqueSelector(selected);
      lastSelectedSelector = selector;

      // Extract text content cleanly
      const extractedText = selected.innerText || selected.textContent || '';
      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      // Save to chrome.storage.local so background worker can refresh even if this tab is closed!
      chrome.storage.local.set({
        snipTarget: {
          url: window.location.href,
          selector: selector,
          lastKnownText: extractedText.trim()
        },
        snipData: {
          text: extractedText.trim(),
          lastUpdated: timeStr,
          lastUpdatedTimestamp: Date.now()
        }
      });

      // Also open the Document PiP window
      openDocumentPip(selected, selector);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && isPickerActive) {
      stopElementPicker();
    }
  }

  // Generates a CSS selector path for the element
  function generateUniqueSelector(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    
    // Check for distinctive attribute
    const dataTestId = el.getAttribute('data-testid') || el.getAttribute('data-id');
    if (dataTestId) return `[data-testid="${CSS.escape(dataTestId)}"]`;

    const parts = [];
    while (el && el.nodeType === Node.ELEMENT_NODE && el !== document.body && el !== document.documentElement) {
      let selector = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).filter(c => !c.startsWith('__web_snip'));
        if (classes.length > 0) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }
      let sibling = el;
      let nth = 1;
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.tagName.toLowerCase() === el.tagName.toLowerCase()) nth++;
      }
      selector += `:nth-of-type(${nth})`;
      parts.unshift(selector);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }

  async function openDocumentPip(element, selector) {
    if (!('documentPictureInPicture' in window)) {
      alert('Document Picture-in-Picture is not supported in this Chrome version. Please update Chrome to version 116 or higher.');
      return;
    }

    try {
      const rect = element.getBoundingClientRect();
      const initialWidth = Math.max(340, Math.min(window.screen.availWidth * 0.7, Math.round(rect.width) + 40));
      const initialHeight = Math.max(220, Math.min(window.screen.availHeight * 0.7, Math.round(rect.height) + 70));

      if (pipWindow) {
        try { pipWindow.close(); } catch (e) {}
      }

      // Request always-on-top Document PiP window
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: initialWidth,
        height: initialHeight
      });

      setupPipWindowContent(pipWindow, element, selector);

    } catch (err) {
      console.error('Failed to open Document PiP window:', err);
      alert('Could not open Picture-in-Picture: ' + err.message);
    }
  }

  function reopenPipAfterReload(selector) {
    const el = document.querySelector(selector);
    if (el) {
      openDocumentPip(el, selector);
    }
  }

  function setupPipWindowContent(pipWin, sourceElement, selector) {
    const pipDoc = pipWin.document;

    // Copy all stylesheets from host document to PiP window
    Array.from(document.styleSheets).forEach(sheet => {
      try {
        if (sheet.href) {
          const link = pipDoc.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pipDoc.head.appendChild(link);
        } else if (sheet.cssRules) {
          const style = pipDoc.createElement('style');
          Array.from(sheet.cssRules).forEach(rule => {
            style.appendChild(pipDoc.createTextNode(rule.cssText));
          });
          pipDoc.head.appendChild(style);
        }
      } catch (err) {
        // Cross-origin stylesheet access fallback
        if (sheet.href) {
          const link = pipDoc.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pipDoc.head.appendChild(link);
        }
      }
    });

    // Add dedicated helper styling for the PiP window toolbar & container
    const extraStyle = pipDoc.createElement('style');
    extraStyle.textContent = `
      body {
        margin: 0;
        padding: 0;
        background: #0f172a;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
        color: #f8fafc;
      }
      #__pip_container {
        flex: 1;
        overflow: auto;
        padding: 8px;
        background: transparent;
      }
    `;
    pipDoc.head.appendChild(extraStyle);

    // Cloned section container
    const container = pipDoc.createElement('div');
    container.id = '__pip_container';

    // Clone the selected section DOM
    const clonedNode = sourceElement.cloneNode(true);
    container.appendChild(clonedNode);

    pipDoc.body.appendChild(container);

    // Handle auto refresh countdown and reload in background
    startRefreshTimer(selector);

    // Cleanup when PiP window is closed by user
    pipWin.addEventListener('pagehide', () => {
      clearInterval(refreshTimerId);
      sessionStorage.removeItem('__webSnipPip_active');
      pipWindow = null;
    });

    // Keep cloned node in sync with live element DOM mutations if on the same page
    setupLiveDomObserver(sourceElement, clonedNode);
  }

  function setupLiveDomObserver(sourceElement, clonedNode) {
    if (!sourceElement || !window.MutationObserver) return;
    const observer = new MutationObserver(() => {
      if (!pipWindow || pipWindow.closed) {
        observer.disconnect();
        return;
      }
      try {
        const container = pipWindow.document.getElementById('__pip_container');
        if (container) {
          container.innerHTML = '';
          container.appendChild(sourceElement.cloneNode(true));
        }
      } catch (e) {
        // Window might be navigating
      }
    });

    observer.observe(sourceElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function startRefreshTimer(selector) {
    clearInterval(refreshTimerId);
    if (!chosenRefreshIntervalMinutes || chosenRefreshIntervalMinutes <= 0) return;

    let remainingSeconds = Math.round(chosenRefreshIntervalMinutes * 60);

    refreshTimerId = setInterval(() => {
      remainingSeconds--;
      if (remainingSeconds <= 0) {
        clearInterval(refreshTimerId);
        triggerPageRefresh(selector);
      }
    }, 1000);
  }

  function triggerPageRefresh(selector) {
    // Store active PiP info in sessionStorage so it can be restored on reload
    sessionStorage.setItem('__webSnipPip_active', JSON.stringify({
      selector: selector,
      intervalMinutes: chosenRefreshIntervalMinutes
    }));

    // Reload the host webpage
    window.location.reload();
  }

  function closePip() {
    if (pipWindow) {
      try {
        pipWindow.close();
      } catch (e) {}
      pipWindow = null;
    }
    clearInterval(refreshTimerId);
    sessionStorage.removeItem('__webSnipPip_active');
  }

})();
