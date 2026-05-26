/**
 * Browser runtime for Layer C server-island ("hole") lazy loading.
 *
 * Self-contained ES module — no dependencies, no TypeScript. The publisher
 * injects a `<script type="module" src="/_pb/hole-runtime.js" defer>` tag
 * into pages that contain at least one `<pb-hole>` placeholder.
 *
 * On load, the runtime uses `IntersectionObserver` with a 200 px root margin
 * to begin fetching each hole's rendered fragment just before it enters the
 * viewport. Holes already in view on initial paint begin fetching immediately.
 *
 * The fragment fetch URL is `/_pb/hole/<nodeId>?v=<publishVersion>`. The
 * version parameter lets the hole endpoint detect stale placeholders after a
 * re-publish and return a lightweight sentinel instead of cached stale HTML.
 *
 * When the fetch resolves, `el.outerHTML = html` swaps the placeholder with
 * the server-rendered fragment in-place. No morphdom / idiomorph dependency.
 * A fetch failure is silently swallowed — the author's skeleton content in the
 * placeholder continues to show as a meaningful fallback.
 */

export const HOLE_RUNTIME_JS = `const io = new IntersectionObserver(function(entries) {
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.isIntersecting) continue;
    var el = e.target;
    io.unobserve(el);
    var id = el.dataset.pbHole;
    var version = el.dataset.pbVersion || '';
    fetch('/_pb/hole/' + encodeURIComponent(id) + '?v=' + encodeURIComponent(version))
      .then(function(r) { return r.text(); })
      .then(function(html) { el.outerHTML = html; })
      .catch(function() {});
  }
}, { rootMargin: '200px 0px' });
var holes = document.querySelectorAll('pb-hole[data-pb-hole]');
for (var i = 0; i < holes.length; i++) {
  io.observe(holes[i]);
}
`
