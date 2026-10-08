// Content Script: Dual-Engine Picture-in-Picture
// 1. Frameless Video PiP (YouTube style, no title bar, clean text canvas)
// 2. Interactive Document PiP (HTML elements, with domain title bar)

(function() {
  if (window.__webSnipPipInitialized) return;
  window.__webSnipPipInitialized = true;

  let isPickerActive = false;
  let hoveredElement = null;
  let currentOverlay = null;
  let pipWindow = null;
  let refreshTimerId = null;
  let renderAnimationId = null;
  let lastSelectedSelector = null;
  let chosenRefreshIntervalMinutes = 10;
  let chosenPipMode = 'video'; // 'video' (frameless) or 'document' (html)

  // Video PiP variables
  let pipVideo = null;
  let pipCanvas = null;
  let pipCtx = null;
  let selectedTargetElement = null;

  // Listen for messages from popup or background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'START_ELEMENT_PICKER') {
      chosenRefreshIntervalMinutes = request.refreshIntervalMinutes || 10;
      chosenPipMode = request.pipMode || 'video';
      startElementPicker();
      sendResponse({ status: 'ok' });
    } else if (request.action === 'CLOSE_PIP') {
      closePip();
      sendResponse({ status: 'ok' });
    } else if (request.action === 'TRIGGER_PIP_FROM_POPUP') {
      if (lastSelectedSelector) {
        const el = document.querySelector(lastSelectedSelector);
        if (el) openSelectedPiP(el, lastSelectedSelector);
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
      chosenPipMode = parsed.pipMode || 'video';
      sessionStorage.removeItem('__webSnipPip_active');

      // Wait for DOM ready, then reopen PiP window
      window.addEventListener('load', () => {
        setTimeout(() => {
          const el = document.querySelector(lastSelectedSelector);
          if (el) openSelectedPiP(el, lastSelectedSelector);
        }, 700);
      });
    } catch (e) {
      console.error(e);
    }
  }

  function createHoverOverlay() {
    if (currentOverlay) return;
    currentOverlay = document.createElement('div');
    currentOverlay.id = '__web_snip_pip_hover_box';
    const modeBadge = chosenPipMode === 'video' ? 'YouTube Frameless PiP' : 'Interactive Window';
    currentOverlay.innerHTML = `
      <div id="__web_snip_pip_tooltip">
        <span>Click to open in <strong>${modeBadge}</strong></span>
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

      // Open in chosen mode
      openSelectedPiP(selected, selector);
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

  function openSelectedPiP(element, selector) {
    if (chosenPipMode === 'document') {
      openDocumentPip(element, selector);
    } else {
      openVideoPip(element, selector);
    }
  }

  // ==========================================
  // Option 1: YouTube-Style Video PiP (No Bar)
  // ==========================================
  async function openVideoPip(element, selector) {
    selectedTargetElement = element;

    try {
      if (pipWindow) {
        try { pipWindow.close(); } catch (e) {}
        pipWindow = null;
      }

      setupCanvasAndVideo(element);
      renderElementToCanvas();

      await pipVideo.play();
      await pipVideo.requestPictureInPicture();

      startRefreshTimer(selector);
    } catch (err) {
      console.warn('Video PiP failed, falling back to Document PiP:', err);
      openDocumentPip(element, selector);
    }
  }

  function setupCanvasAndVideo(element) {
    const rect = element.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(340, Math.round(rect.width));
    const height = Math.max(180, Math.round(rect.height));

    if (!pipCanvas) {
      pipCanvas = document.createElement('canvas');
      pipCanvas.style.display = 'none';
      document.body.appendChild(pipCanvas);
    }
    pipCanvas.width = width * dpr;
    pipCanvas.height = height * dpr;
    pipCtx = pipCanvas.getContext('2d');
    pipCtx.scale(dpr, dpr);

    if (!pipVideo) {
      pipVideo = document.createElement('video');
      pipVideo.muted = true;
      pipVideo.playsInline = true;
      pipVideo.style.display = 'none';
      document.body.appendChild(pipVideo);

      pipVideo.addEventListener('leavepictureinpicture', () => {
        closePip();
      });
    }

    const stream = pipCanvas.captureStream(25);
    pipVideo.srcObject = stream;
  }

  function renderElementToCanvas() {
    if (!selectedTargetElement || !pipCanvas || !pipCtx) return;

    const width = pipCanvas.width / (window.devicePixelRatio || 1);
    const height = pipCanvas.height / (window.devicePixelRatio || 1);

    const computedStyle = window.getComputedStyle(selectedTargetElement);
    const bgColor = computedStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && computedStyle.backgroundColor !== 'transparent'
      ? computedStyle.backgroundColor 
      : '#090d16';

    // Clear background
    pipCtx.fillStyle = bgColor;
    pipCtx.fillRect(0, 0, width, height);

    // Draw card border
    pipCtx.strokeStyle = '#1e293b';
    pipCtx.lineWidth = 2;
    pipCtx.strokeRect(1, 1, width - 2, height - 2);

    // Render formatted text
    const textContent = (selectedTargetElement.innerText || selectedTargetElement.textContent || '').trim();
    drawContentOnCanvas(pipCtx, textContent, width, height, computedStyle);

    if (document.pictureInPictureElement === pipVideo) {
      renderAnimationId = requestAnimationFrame(renderElementToCanvas);
    }
  }

  function drawContentOnCanvas(ctx, text, width, height, computedStyle) {
    const textColor = computedStyle.color && computedStyle.color !== 'rgba(0, 0, 0, 0)' ? computedStyle.color : '#f1f5f9';
    ctx.fillStyle = textColor;
    ctx.textBaseline = 'top';

    const fontSize = Math.max(15, Math.min(24, Math.round(width / 22)));
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

    const padding = 16;
    const maxWidth = width - (padding * 2);
    const lineHeight = fontSize * 1.45;

    const lines = text.split('\n').filter(l => l.trim().length > 0);
    let currentY = padding;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      currentY = wrapAndDrawText(ctx, line, padding, currentY, maxWidth, lineHeight, height - padding);
      currentY += 4;
      if (currentY > height - padding) break;
    }
  }

  function wrapAndDrawText(ctx, text, x, y, maxWidth, lineHeight, maxY) {
    const words = text.split(' ');
    let line = '';

    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + ' ';
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && n > 0) {
        if (y < maxY) ctx.fillText(line, x, y);
        line = words[n] + ' ';
        y += lineHeight;
      } else {
        line = testLine;
      }
    }
    if (y < maxY) ctx.fillText(line, x, y);
    return y + lineHeight;
  }

  // ==========================================
  // Option 2: Interactive Document HTML PiP
  // ==========================================
  async function openDocumentPip(element, selector) {
    if (!('documentPictureInPicture' in window)) {
      // Fallback to video PiP if document PiP is not supported
      openVideoPip(element, selector);
      return;
    }

    try {
      const rect = element.getBoundingClientRect();
      const initialWidth = Math.max(340, Math.min(window.screen.availWidth * 0.7, Math.round(rect.width) + 40));
      const initialHeight = Math.max(220, Math.min(window.screen.availHeight * 0.7, Math.round(rect.height) + 70));

      if (pipWindow) {
        try { pipWindow.close(); } catch (e) {}
      }

      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: initialWidth,
        height: initialHeight
      });

      setupPipWindowContent(pipWindow, element, selector);

    } catch (err) {
      console.warn('Document PiP failed, trying Video PiP:', err);
      openVideoPip(element, selector);
    }
  }

  function setupPipWindowContent(pipWin, sourceElement, selector) {
    const pipDoc = pipWin.document;

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
        if (sheet.href) {
          const link = pipDoc.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          pipDoc.head.appendChild(link);
        }
      }
    });

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

    const container = pipDoc.createElement('div');
    container.id = '__pip_container';

    const clonedNode = sourceElement.cloneNode(true);
    container.appendChild(clonedNode);
    pipDoc.body.appendChild(container);

    startRefreshTimer(selector);

    pipWin.addEventListener('pagehide', () => {
      clearInterval(refreshTimerId);
      sessionStorage.removeItem('__webSnipPip_active');
      pipWindow = null;
    });

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
      } catch (e) {}
    });

    observer.observe(sourceElement, {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // ==========================================
  // Timer & Refresh Handling
  // ==========================================
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
    sessionStorage.setItem('__webSnipPip_active', JSON.stringify({
      selector: selector,
      intervalMinutes: chosenRefreshIntervalMinutes,
      pipMode: chosenPipMode
    }));

    window.location.reload();
  }

  function closePip() {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    }
    if (renderAnimationId) {
      cancelAnimationFrame(renderAnimationId);
      renderAnimationId = null;
    }
    if (pipWindow) {
      try { pipWindow.close(); } catch (e) {}
      pipWindow = null;
    }
    clearInterval(refreshTimerId);
    sessionStorage.removeItem('__webSnipPip_active');
  }

})();
