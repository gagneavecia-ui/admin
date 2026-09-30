// ================================================================
// MODALS — Drag-to-close pour la console admin ARVEXA
// S'applique automatiquement à toutes les modales détectées.
// ================================================================

(function () {
  'use strict';

  if (window.__arvexaAdminModalsInit) return;
  window.__arvexaAdminModalsInit = true;

  // ─────────────────────────────────────────────────────────────
  // CONFIG
  // ─────────────────────────────────────────────────────────────
  const DRAG_THRESHOLD = 100;      // px à dépasser pour fermer
  const VELOCITY_THRESHOLD = 0.5;  // px/ms pour fermer rapidement
  const ZONE_HEIGHT = 120;         // zone tactile depuis le haut (px)
  const HINT_TEXT = '↓ Glisser pour fermer';

  // ─────────────────────────────────────────────────────────────
  // DÉTECTION DES MODALES
  // ─────────────────────────────────────────────────────────────
  function findModals() {
    const candidates = [];

    // 1) Modales avec .modal-handle explicite
    document.querySelectorAll('.modal-handle').forEach((handle) => {
      const modal = handle.closest('.modal, .modal-sheet, .modal-card, [class*="modal"]');
      const overlay = modal?.closest('.modal-back, .modal-overlay, .modal-backdrop, .confirm-modal, .pwd-gate, .arv-modal-back');
      if (modal && overlay) {
        candidates.push({ overlay, modal, handle });
      }
    });

    // 2) Modales qui ont un ::before CSS (pseudo-handle)
    document.querySelectorAll('.modal-back, .modal-overlay, .modal-backdrop, .confirm-modal, .pwd-gate, .arv-modal-back')
      .forEach((overlay) => {
        const modal = overlay.querySelector('.modal, .modal-sheet, .modal-card, .arv-modal, .confirm-box, .pwd-gate-box');
        if (!modal) return;
        if (candidates.some((c) => c.overlay === overlay)) return;

        const hasPseudoHandle = getComputedStyle(modal, '::before').content !== 'none';
        const hasRealHandle = modal.querySelector('.modal-handle');

        if (hasPseudoHandle || hasRealHandle) {
          candidates.push({
            overlay,
            modal,
            handle: hasRealHandle || null,
            usePseudoHandle: hasPseudoHandle
          });
        }
      });

    return candidates;
  }

  // ─────────────────────────────────────────────────────────────
  // FERMETURE
  // ─────────────────────────────────────────────────────────────
  function closeModal(overlay) {
    // 1) Bouton de fermeture connu
    const closeBtn = overlay.querySelector(
      '.modal-close, .arv-modal-close, .pwd-gate-close, [data-close]'
    );
    if (closeBtn && typeof closeBtn.click === 'function') {
      closeBtn.click();
      return;
    }

    // 2) Fallback : retirer la classe d'ouverture
    overlay.classList.remove('show', 'open', 'active');

    if (getComputedStyle(overlay).display !== 'none' && !overlay.classList.contains('show')) {
      overlay.style.display = 'none';
    }

    document.body.style.overflow = '';
  }

  // ─────────────────────────────────────────────────────────────
  // SETUP
  // ─────────────────────────────────────────────────────────────
  function setupModal({ overlay, modal, handle }) {
    if (modal.__arvexaDragInit) return;
    modal.__arvexaDragInit = true;

    // Créer un pseudo-handle visuel si absent
    let visualHandle = handle;
    if (!visualHandle) {
      visualHandle = document.createElement('div');
      visualHandle.className = 'modal-handle auto-handle';
      visualHandle.setAttribute('aria-hidden', 'true');
      visualHandle.style.cssText = `
        position: absolute;
        top: 8px;
        left: 50%;
        transform: translateX(-50%);
        width: 40px;
        height: 4px;
        border-radius: 4px;
        background: rgba(255,255,255,0.15);
        cursor: grab;
        touch-action: none;
        z-index: 10;
        transition: background 0.2s ease, width 0.2s ease;
      `;
      if (!modal.style.position || modal.style.position === 'static') {
        modal.style.position = 'relative';
      }
      modal.appendChild(visualHandle);
    }

    // Ajouter le hint (texte d'aide)
    let hint = modal.querySelector('.modal-handle-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'modal-handle-hint';
      hint.textContent = HINT_TEXT;
      hint.style.cssText = `
        position: absolute;
        top: 22px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 9px;
        color: var(--text-muted, #8A8A7A);
        font-weight: 600;
        letter-spacing: 0.5px;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s ease;
        white-space: nowrap;
        z-index: 10;
      `;
      modal.appendChild(hint);
    }

    // État du drag
    let startY = 0;
    let currentY = 0;
    let isDragging = false;
    let startTime = 0;

    function onStart(clientY) {
      const rect = modal.getBoundingClientRect();
      if (clientY - rect.top > ZONE_HEIGHT) return;

      startY = clientY;
      currentY = clientY;
      startTime = Date.now();
      isDragging = true;

      modal.style.transition = 'none';
      modal.classList.add('dragging');
      visualHandle.style.background = 'var(--gold, #E0B84A)';
      visualHandle.style.width = '50px';

      if (navigator.vibrate) {
        try { navigator.vibrate(5); } catch (e) {}
      }
    }

    function onMove(clientY, event) {
      if (!isDragging) return;

      currentY = clientY;
      const diff = currentY - startY;
      if (diff < 0) {
        modal.style.transform = '';
        return;
      }

      // Courbe de résistance
      const damped = diff > 300 ? 300 + (diff - 300) * 0.4 : diff;
      modal.style.transform = `translateY(${damped}px)`;

      // Assombrir le fond
      const opacity = Math.max(0.3, 1 - diff / 400);
      overlay.style.background = `rgba(0, 0, 0, ${0.78 * opacity})`;

      if (event && event.cancelable) event.preventDefault();
    }

    function onEnd() {
      if (!isDragging) return;
      isDragging = false;
      modal.classList.remove('dragging');
      visualHandle.style.background = '';
      visualHandle.style.width = '';

      const diff = currentY - startY;
      const duration = Date.now() - startTime;
      const velocity = duration > 0 ? diff / duration : 0;

      overlay.style.background = '';

      if (diff > DRAG_THRESHOLD || (velocity > VELOCITY_THRESHOLD && diff > 40)) {
        // Fermer avec animation
        modal.style.transition = 'transform 0.28s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.28s ease';
        modal.style.transform = 'translateY(100%)';
        modal.style.opacity = '0.5';

        setTimeout(() => {
          modal.style.transform = '';
          modal.style.transition = '';
          modal.style.opacity = '';
          closeModal(overlay);
        }, 280);
      } else {
        // Rebond
        modal.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
        modal.style.transform = '';
        setTimeout(() => { modal.style.transition = ''; }, 300);
      }

      startY = 0;
      currentY = 0;
    }

    // ÉVÉNEMENTS TACTILES
    visualHandle.addEventListener('touchstart', (e) => {
      onStart(e.touches[0].clientY);
    }, { passive: true });

    modal.addEventListener('touchstart', (e) => {
      onStart(e.touches[0].clientY);
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      onMove(e.touches[0].clientY, e);
    }, { passive: false });

    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', onEnd, { passive: true });

    // ÉVÉNEMENTS SOURIS (desktop)
    visualHandle.addEventListener('mousedown', (e) => {
      onStart(e.clientY);
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      onMove(e.clientY, null);
    });

    document.addEventListener('mouseup', onEnd);
  }

  // ─────────────────────────────────────────────────────────────
  // OBSERVER — détecter les modales dynamiques
  // ─────────────────────────────────────────────────────────────
  function setupAll() {
    findModals().forEach(setupModal);
  }

  function setupObserver() {
    if (!('MutationObserver' in window)) return;

    let debounceTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(setupAll, 200);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────
  function init() {
    setupAll();
    setupObserver();
    console.log('🎭 ARVEXA Admin — Modals drag-to-close activé');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.arvexaModals = { refresh: setupAll };

})();
