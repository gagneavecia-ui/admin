// ================================================================
// MODALS — Drag-to-close pour la console admin ARVEXA
// Version 2.0 — Corrigée : c'est la MODALE entière qui bouge
// ================================================================

(function () {
  'use strict';

  if (window.__arvexaAdminModalsInit) return;
  window.__arvexaAdminModalsInit = true;

  // ─────────────────────────────────────────────────────────────
  // CONFIG
  // ─────────────────────────────────────────────────────────────
  const DRAG_THRESHOLD = 100;      // px à dépasser pour fermer
  const VELOCITY_THRESHOLD = 0.5;  // px/ms (drag rapide = ferme tout de suite)
  const ZONE_HEIGHT = 80;          // zone tactile en haut de la modale (px)
  const HINT_TEXT = '↓ Glisser pour fermer';

  // ─────────────────────────────────────────────────────────────
  // DÉTECTION DES MODALES
  // ─────────────────────────────────────────────────────────────
  function findModals() {
    const candidates = [];
    const seen = new Set();

    const overlaySelectors = [
      '.modal-back',
      '.modal-overlay',
      '.modal-backdrop',
      '.confirm-modal',
      '.pwd-gate',
      '.arv-modal-back'
    ];

    overlaySelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((overlay) => {
        if (seen.has(overlay)) return;
        seen.add(overlay);

        // ⚡ Cible : le vrai conteneur de la modale (celui qui contient le contenu)
        const modal = overlay.querySelector(
          '.modal, .modal-sheet, .modal-card, .confirm-box, .pwd-gate-box, .arv-modal'
        );
        if (!modal) return;

        // Le handle : cherché uniquement dans la modale
        const handle = modal.querySelector('.modal-handle');

        candidates.push({ overlay, modal, handle });
      });
    });

    return candidates;
  }

  // ─────────────────────────────────────────────────────────────
  // FERMETURE PROPRE
  // ─────────────────────────────────────────────────────────────
  function closeModal(overlay) {
    // 1) Bouton de fermeture connu → clic dessus
    const closeBtn = overlay.querySelector(
      '.modal-close, .arv-modal-close, .pwd-gate-close, [data-close]'
    );
    if (closeBtn && typeof closeBtn.click === 'function') {
      closeBtn.click();
      return;
    }

    // 2) Sinon, retirer les classes d'ouverture
    overlay.classList.remove('show', 'open', 'active');
    document.body.style.overflow = '';
  }

  // ─────────────────────────────────────────────────────────────
  // SETUP D'UNE MODALE
  // ─────────────────────────────────────────────────────────────
  function setupModal({ overlay, modal, handle }) {
    if (modal.__arvexaDragInit) return;
    modal.__arvexaDragInit = true;

    // ⚡ S'assurer que la modale peut recevoir un transform
    // (position relative + will-change pour de meilleures perfs)
    const computedPosition = getComputedStyle(modal).position;
    if (computedPosition === 'static') {
      modal.style.position = 'relative';
    }
    modal.style.willChange = 'transform';

    // Créer la barre visuelle si elle n'existe pas
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
        user-select: none;
        -webkit-user-select: none;
        z-index: 100;
        transition: background 0.2s ease, width 0.2s ease;
      `;
      modal.appendChild(visualHandle);
    }

    // Créer le hint (texte d'aide)
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
        z-index: 100;
      `;
      modal.appendChild(hint);
    }

    // ──────── ÉTAT DU DRAG ────────
    let startY = 0;
    let currentY = 0;
    let isDragging = false;
    let startTime = 0;
    let originalTransform = '';
    let originalTransition = '';
    let originalAnimation = '';

    // ──────── DÉMARRAGE ────────
    function onStart(clientY, event) {
      const rect = modal.getBoundingClientRect();
      const offsetFromTop = clientY - rect.top;

      // Doit toucher la zone du haut de la modale (ex : 80px en haut)
      if (offsetFromTop > ZONE_HEIGHT) return;
      if (offsetFromTop < 0) return;

      startY = clientY;
      currentY = clientY;
      startTime = Date.now();
      isDragging = true;

      // Sauvegarder les valeurs actuelles pour les restaurer après
      originalTransform = modal.style.transform || '';
      originalTransition = modal.style.transition || '';
      originalAnimation = modal.style.animation || '';

      // ⚡ DÉSACTIVER toute animation/transition pendant le drag
      modal.style.animation = 'none';
      modal.style.transition = 'none';

      // ⚡ Bloquer le scroll de la page
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';

      modal.classList.add('dragging');

      visualHandle.style.background = 'var(--gold, #E0B84A)';
      visualHandle.style.width = '50px';

      if (navigator.vibrate) {
        try { navigator.vibrate(5); } catch (e) {}
      }

      if (event && event.cancelable) event.preventDefault();
    }

    // ──────── MOUVEMENT ────────
    function onMove(clientY, event) {
      if (!isDragging) return;

      if (event && event.cancelable) {
        event.preventDefault();
      }

      currentY = clientY;
      const diff = currentY - startY;

      // Blocage : on ne tire que vers le bas
      if (diff < 0) {
        modal.style.transform = 'translateY(0px)';
        return;
      }

      // Courbe de résistance après 300px
      const damped = diff > 300 ? 300 + (diff - 300) * 0.35 : diff;

      // ⚡ On applique le transform sur la MODALE (pas le handle)
      modal.style.transform = `translateY(${damped}px)`;

      // Assombrir le fond progressivement
      const opacity = Math.max(0.3, 1 - diff / 400);
      overlay.style.background = `rgba(0, 0, 0, ${0.75 * opacity})`;
    }

    // ──────── FIN ────────
    function onEnd() {
      if (!isDragging) return;
      isDragging = false;
      modal.classList.remove('dragging');

      document.body.style.touchAction = '';

      visualHandle.style.background = '';
      visualHandle.style.width = '';

      const diff = currentY - startY;
      const duration = Date.now() - startTime;
      const velocity = duration > 0 ? diff / duration : 0;

      overlay.style.background = '';

      // Décision : fermer ou revenir en place
      const shouldClose = diff > DRAG_THRESHOLD ||
                          (velocity > VELOCITY_THRESHOLD && diff > 40);

      if (shouldClose) {
        // Fermeture animée
        modal.style.animation = 'none';
        modal.style.transition = 'transform 0.28s cubic-bezier(0.25, 1, 0.5, 1)';
        modal.style.transform = 'translateY(110%)';

        setTimeout(() => {
          modal.style.transform = originalTransform;
          modal.style.transition = originalTransition;
          modal.style.animation = originalAnimation;
          closeModal(overlay);
          document.body.style.overflow = '';
        }, 280);
      } else {
        // Rebond à la position initiale
        modal.style.transition = 'transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)';
        modal.style.transform = 'translateY(0px)';

        setTimeout(() => {
          modal.style.transform = originalTransform;
          modal.style.transition = originalTransition;
          modal.style.animation = originalAnimation;
          document.body.style.overflow = '';
        }, 350);
      }

      startY = 0;
      currentY = 0;
    }

    // ─────────────────────────────────────────────────────────
    // ÉVÉNEMENTS — SUR TOUTE LA MODALE (pas juste le handle)
    // ─────────────────────────────────────────────────────────
    // ⚡ On écoute sur la MODALE ENTIÈRE, mais on ne démarre le drag
    //    que si le toucher est dans la zone haute (voir onStart)

    modal.addEventListener('touchstart', (e) => {
      onStart(e.touches[0].clientY, e);
    }, { passive: false });

    // ⚡ Le touchmove est écouté sur DOCUMENT pour continuer le drag
    //    même si le doigt sort de la modale
    const touchMoveHandler = (e) => {
      if (!isDragging) return;
      onMove(e.touches[0].clientY, e);
    };
    document.addEventListener('touchmove', touchMoveHandler, { passive: false });

    const touchEndHandler = () => {
      if (!isDragging) return;
      onEnd();
    };
    document.addEventListener('touchend', touchEndHandler, { passive: true });
    document.addEventListener('touchcancel', touchEndHandler, { passive: true });

    // ─── SOURIS (desktop) ───
    modal.addEventListener('mousedown', (e) => {
      // Ignorer les clics sur les boutons / inputs
      if (e.target.closest('button, input, textarea, select, a, [role="button"]')) return;
      onStart(e.clientY, e);
    });

    const mouseMoveHandler = (e) => {
      if (!isDragging) return;
      onMove(e.clientY, e);
    };
    document.addEventListener('mousemove', mouseMoveHandler);

    const mouseUpHandler = () => {
      if (!isDragging) return;
      onEnd();
    };
    document.addEventListener('mouseup', mouseUpHandler);

    // Nettoyage (si la modale est retirée du DOM)
    modal.addEventListener('DOMNodeRemoved', () => {
      document.removeEventListener('touchmove', touchMoveHandler);
      document.removeEventListener('touchend', touchEndHandler);
      document.removeEventListener('touchcancel', touchEndHandler);
      document.removeEventListener('mousemove', mouseMoveHandler);
      document.removeEventListener('mouseup', mouseUpHandler);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // SCAN AUTOMATIQUE + MUTATION OBSERVER
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
      subtree: true
    });
  }

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────
  function init() {
    setupAll();
    setupObserver();
    console.log('🎭 ARVEXA Admin — Modals drag-to-close v2 prêt');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // API publique
  window.arvexaModals = { refresh: setupAll };

})();
