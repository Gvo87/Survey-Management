/*!
 * Survey embed loader (Phase 2B). Plain ES2017, no dependencies, no inline styles or eval, so it
 * works on pages with a strict Content-Security-Policy (allow this origin in script-src and frame-src).
 *
 * Inline:  <div data-survey="PUBLIC_ID" data-mode="inline"></div>
 * Popup:   <button data-survey="PUBLIC_ID" data-mode="popup">Give feedback</button>
 *          optional data-open-after="10" opens the popup by itself after 10 seconds (once per page view).
 * Then:    <script src="https://SURVEY_ORIGIN/embed.js" async></script>
 * Options: data-link="DISTRIBUTION_TOKEN" attributes responses to a named link; data-title labels the frame.
 *
 * The survey runs in an iframe on its own origin, so host-page CSS and scripts can't reach it.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var origin = script ? new URL(script.src).origin : '';
  if (!origin || window.__surveyEmbedLoaded) return;
  window.__surveyEmbedLoaded = true;

  var frames = [];

  function surveyUrl(el) {
    var id = el.getAttribute('data-survey') || '';
    if (!/^[A-Za-z0-9]{6,20}$/.test(id)) return null;
    var url = origin + '/s/' + id + '?embed=1';
    var link = el.getAttribute('data-link');
    if (link && /^[A-Za-z0-9_-]{1,64}$/.test(link)) url += '&d=' + encodeURIComponent(link);
    return url;
  }

  function makeFrame(el, height) {
    var frame = document.createElement('iframe');
    frame.src = surveyUrl(el);
    frame.title = el.getAttribute('data-title') || 'Survey';
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('allow', 'clipboard-write');
    // CSSOM assignments are allowed under a strict CSP (style attributes in markup are not).
    frame.style.width = '100%';
    frame.style.height = height;
    frame.style.border = '0';
    frame.style.display = 'block';
    frame.style.colorScheme = 'normal';
    frames.push(frame);
    return frame;
  }

  function setupInline(el) {
    el.appendChild(makeFrame(el, '480px'));
  }

  function setupPopup(trigger) {
    var overlay = null;
    var lastFocus = null;

    function close() {
      if (!overlay) return;
      document.removeEventListener('keydown', onKey, true);
      overlay.parentNode.removeChild(overlay);
      overlay = null;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    }

    function open() {
      if (overlay) return;
      lastFocus = document.activeElement;
      overlay = document.createElement('div');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', trigger.getAttribute('data-title') || 'Survey');
      var s = overlay.style;
      s.position = 'fixed';
      s.inset = '0';
      s.zIndex = '2147483646';
      s.background = 'rgba(0, 0, 0, 0.5)';
      s.display = 'flex';
      s.alignItems = 'center';
      s.justifyContent = 'center';
      s.padding = '16px';

      var panel = document.createElement('div');
      var p = panel.style;
      p.position = 'relative';
      p.width = '100%';
      p.maxWidth = '640px';
      p.height = 'min(90vh, 760px)';
      p.background = '#ffffff';
      p.borderRadius = '12px';
      p.overflow = 'hidden';
      p.boxShadow = '0 20px 60px rgba(0, 0, 0, 0.35)';

      var closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.setAttribute('aria-label', 'Close survey');
      closeButton.textContent = '×';
      var c = closeButton.style;
      c.position = 'absolute';
      c.top = '6px';
      c.right = '6px';
      c.width = '44px';
      c.height = '44px';
      c.border = '0';
      c.borderRadius = '22px';
      c.background = '#ffffff';
      c.color = '#1b1f24';
      c.font = '28px/1 system-ui, sans-serif';
      c.cursor = 'pointer';
      c.zIndex = '1';
      closeButton.addEventListener('click', close);

      var frame = makeFrame(trigger, '100%');
      panel.appendChild(closeButton);
      panel.appendChild(frame);
      overlay.appendChild(panel);
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) close();
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      closeButton.focus();
    }

    trigger.addEventListener('click', function (event) {
      event.preventDefault();
      open();
    });
    var delay = Number(trigger.getAttribute('data-open-after'));
    if (delay > 0 && delay <= 600) setTimeout(open, delay * 1000);
  }

  // Inline frames grow with the survey (messages only from this origin and our own frames).
  window.addEventListener('message', function (event) {
    if (event.origin !== origin || !event.data || typeof event.data !== 'object') return;
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      if (frame.contentWindow !== event.source) continue;
      if (event.data.type === 'survey:resize' && typeof event.data.height === 'number' && frame.style.height !== '100%') {
        frame.style.height = Math.max(200, Math.min(event.data.height, 20000)) + 'px';
      }
      if (event.data.type === 'survey:completed') {
        frame.dispatchEvent(new CustomEvent('survey:completed', { bubbles: true }));
      }
    }
  });

  function init() {
    var nodes = document.querySelectorAll('[data-survey]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.__surveyEmbed || !surveyUrl(el)) continue;
      el.__surveyEmbed = true;
      if (el.getAttribute('data-mode') === 'popup') setupPopup(el);
      else setupInline(el);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
