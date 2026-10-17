# Keep Bases View Requirements

## Purpose

Keep Bases View is an Obsidian plugin that adds a Google Keep-style card layout as a custom Bases view.

The plugin is optimized for large `.base` result sets by using a fixed-width virtual masonry layout, lightweight note previews, and offscreen card measurement before visible cards are mounted.

## Functional Requirements

- Register a custom Bases view named `Keep Bases View` with the `layout-dashboard` icon.
- Display `.base` query results as Google Keep-style masonry cards.
- Use configured card widths for desktop, tablet, and mobile, constrained to the available pane width.
- Optionally use an even two-column layout on mobile, calculating card width from the available width and gap.
- Change the number of columns when the pane width changes, instead of stretching cards.
- Keep horizontal and vertical masonry gaps compact.
- Split notes with `keep_pinned: true` into a `Pinned` section when pinned notes are enabled.
- Display all other notes in an `Others` section when pinned notes exist.
- Preserve the current tab's scroll position when opening a card and returning to the view.
- Reset scroll naturally when the view/tab itself is closed and opened fresh.
- Use the Bases-provided scroll element as the only vertical scroll container.
- Allow pinning and unpinning Markdown notes via `keep_pinned` frontmatter.
- Allow card color changes on Markdown notes via `keep_color` frontmatter.
- Allow deleting a file after confirmation by moving it to the Obsidian trash.
- Show a context menu with open in new tab, pin/unpin, color, and delete actions.
- Show desktop hover controls for pin, color, and delete actions.
- Create desktop controls lazily on hover; show the pinned indicator immediately for pinned cards. Use the context menu for mobile actions.
- Open a clicked card in a popup editor by default.
- Open a clicked card in a normal Obsidian leaf when the popup setting is disabled or a modifier key is used.
- Trigger Obsidian hover previews for cards.
- Display a configurable title property, falling back to the file basename/name.
- Display selected Bases properties, excluding duplicate title and file-name properties.
- Display tags from frontmatter and inline metadata when enabled.
- Display an optional cover image from a configured property.
- Support cover image `cover` and `contain` fit modes.
- Render Markdown and text body previews with a lightweight renderer only.
- Remove frontmatter from body previews.
- Limit body preview length and preview height.
- Extract at most the first 25 body lines and 1,000 characters; bound visible preview lines according to the configured preview height.
- Allow body image previews to be disabled independently of cover images.
- Represent common Markdown structures in lightweight previews where practical, including paragraphs, headings, bullet lines, task checkboxes, code blocks, tables, callouts, and images.
- Add a bottom fade only when preview content is actually clipped or truncated.
- Hide body preview spacing when a file has no renderable body preview.
- Hide tag spacing when tags are disabled or absent.
- Optionally render embedded `.base` files as card previews.
- Use Obsidian's Markdown embed renderer for `.base` previews when enabled.
- Provide view options for title property, image property, image fit, desktop/tablet/mobile card widths, tags, pinned notes, `.base` previews, card preview height, and `.base` preview height.
- Provide plugin settings for the specific `.base` path, popup behavior, popup width, card move animation, mobile even two-column layout, and performance logging.
- Provide commands to fuzzy-open any `.base` file and to open a configured `.base` file.

## View Options and Plugin Settings

View options are stored per Bases view.

| Option | Default | UI range / values |
| --- | --- | --- |
| Card title property | File name fallback | Bases property |
| Cover image property | None | Bases property |
| Image fit | `cover` | `cover`, `contain` |
| Desktop card width | 240 px | 150–500 px |
| Tablet card width | 200 px | 100–500 px |
| Mobile card width | 150 px | 100–500 px |
| Show tags | Enabled | Toggle |
| Pin important notes to the top | Enabled | Toggle |
| Preview `.base` file contents | Enabled | Toggle |
| Preview images in cards | Enabled | Toggle |
| Card preview max height | 320 px | 120–800 px |
| `.base` embed fixed height | 150 px | 80–500 px |

Plugin settings apply across views: specific `.base` path (empty by default), open in popup (enabled), popup max width (800 px), card move animation (enabled), mobile even two-column layout (disabled), and performance logging (disabled).

## Virtual Masonry Requirements

- Use the virtual masonry renderer for all card grids, with absolutely positioned cards and an 8 px gap.
- Measure card heights in a hidden container before mounting them. Process up to 40 cards per asynchronous batch, fetching and parsing each card independently.
- Follow strict prefix order: within each section, only mount cards at or before the last consecutively measured item. Finish measuring all Pinned cards before mounting any Others cards.
- For deep jumps and scroll restoration, measure the required prefix from the beginning rather than mounting cards at estimated positions.
- Hide content during scroll restoration until the required prefix is ready and the saved scroll position can be applied.
- Show a fixed, non-interactive `Measuring cards...` status while the visible area or restoration is waiting for measurement; keep the status outside the masonry layout.
- Reuse section item objects during layout. Keep each item's measured height and image locks throughout the current render and layout epoch, even if its shared cache entry is evicted.
- Do not change an already mounted card's height, column, or Y coordinate because later cards finish measuring, images finish loading, or a failure TTL expires. Data/configuration changes and explicit resize reflows initiate a new layout as appropriate.
- Separate the mount range from the measurement range. Calculate mount overscan as `max(600, min(1200, round(2200 / sqrt(columnCount))))` px. Advance prefix measurement toward the viewport bottom plus 2,000 px when scrolling down, or 800 px when scrolling up.
- Maintain per-column arrays ordered by Y coordinate and use binary search to find cards intersecting the mount range. Cache section offsets during layout instead of reading them on every scroll frame.
- Reuse the measured DOM directly for cards entering the mount range. Discard unused measurement DOM instead of caching detached card elements.
- Use a fixed-height placeholder to measure `.base` previews; start Obsidian embed rendering after mounting. Do not wait for cover image loads or `.base` rendering to measure cards.
- If a card's body read or parse fails, measure a no-body-preview fallback and continue the prefix. Keep this fallback only in the current render, allowing a later update to retry.
- After asynchronous reads or image probes, discard results if the render token or layout epoch changed.
- Recalculate layout when actual card width, pane width, relevant configuration, CSS generation, or result data changes.
- Keep mobile bottom padding large enough that floating Obsidian controls do not hide the last cards.

## Image Requirements

- Keep cover frames stable with a 16:9 aspect ratio and a 180 px maximum height, supporting `cover` and `contain`. Retry cover resolution when metadata is not initially ready.
- Resolve body images from supported wiki and Markdown image lines, including local Vault files and external HTTP(S) URLs.
- Resolve image dimensions before measuring cards. Share both in-flight promises and completed probe results across views through the plugin.
- Limit image probes to eight concurrent loads. Start a 3,000 ms timeout when a probe acquires a slot; treat errors, invalid dimensions, and timeouts as failures.
- Reserve a successful body's image wrapper using its natural width/height ratio. Display the image at full available width with automatic height; do not substitute a 16:9 crop for body images. The overall body preview height limit still applies.
- Render failed or unresolved images as missing-image labels without an `img` element. Cache failures for 60 seconds and carry the earliest image failure expiry into the card layout cache.
- Freeze image success/failure decisions and height during the current display. Retry expired failures on a subsequent render/update or layout configuration change, rather than changing the card in place during scrolling.
- After workspace layout is ready, observe image `create`, `modify`, `delete`, and `rename` events. Invalidate image dimension results and schedule open views to render again, including when a previously missing image is added.

## Cache Requirements

| Cache | Capacity | Contents / key inputs |
| --- | --- | --- |
| Card layout | 10,000 entries | Height, clipping, parsed preview blocks, source, image locks, and failure expiry; keyed by entry signature and layout configuration |
| Raw preview text | 3,000 entries | Extracted Markdown and truncation; keyed by file path, mtime, size, line limit, and character limit |
| Image dimensions | 2,000 entries | Natural dimensions or failed status/expiry; keyed by resolved Vault path/mtime/size, external URL, or unresolved link |

- Apply least-recently-used eviction, refreshing access order on cache hits.
- Include file path/stat, frontmatter, inline tags, selected property values, title/cover values, and resolved embedded-file signatures in each entry signature.
- Include actual rendered card width, title/cover settings, fit mode, preview limits, visibility toggles, ordered displayed properties, CSS generation, device pixel ratio, and container font size in the layout configuration key.
- Validate cached body-image locks by re-resolving local links, including standard Markdown image links. Detect missing-to-resolved changes, deletion, and file stat changes.
- Invalidate expired card failures on the next render or relevant layout change. Do not persist read/parse failure fallbacks in the raw preview or card layout caches.

## Interaction and Performance Requirements

- Avoid rebuilding DOM when Bases sends unchanged data/configuration and no image lock or failure expiry requires retry.
- Use delegated card click, context-menu, and hover events on the content container. Clone cached action icon templates when creating controls.
- During scrolling, suppress hover previews and hover visual effects. Restore hover controls 120 ms after scrolling stops, using the last pointer coordinates and `elementFromPoint` even if the pointer does not move.
- Keep card clicks and context menus active during scrolling and immediately afterward. Do not disable pointer events on cards to suppress hover effects.
- Avoid nested scroll containers and full Markdown rendering for ordinary Markdown/text card previews.
- Batch DOM writes before height/clipping/image-wrapper reads, then commit item state and perform one layout update per measurement batch.
- Schedule scroll updates with animation frames. Avoid whole-result scans, layout-width reads, unchanged card-position writes, and per-card preview-queue sorting in the scroll window update.
- Observe the scroll container with `ResizeObserver`; do not observe content height changes. Schedule initial layout retry checks only when the initial width is not yet usable.
- Avoid permanent `will-change: transform` on virtual cards and avoid applying light-theme embed blend modes to every descendant.
- Keep runtime implementation self-contained in `main.js`, `manifest.json`, and `styles.css`; development test dependencies are not required by the installed plugin.

## Animation Requirements

- Animate card reflow after pane/sidebar resize when the card move animation setting is enabled.
- Use Web Animations API transforms between old and new logical positions, with 220 ms duration and `ease` easing.
- Animate only cards whose old or new bounds intersect the viewport.
- If a width change requires new measurement and replacement DOM, preserve the old position until the replacement is measured and mounted, and animate it only within the matching layout epoch.
- Cancel previous reflow animations when applying a new target position, avoiding animation stacking and mid-animation style reads.
- Disable conflicting CSS transitions during initial rendering. When animation is disabled, apply the new layout immediately.
- The removed non-virtual grid and its FLIP animation path are not part of the current implementation.

## Validation and Diagnostics

- Provide optional logs for first visible render, measurement batches, scroll restoration, virtual-window frame duration (including average/maximum), resize duration, layout pass count, mounted cards, and DOM element count.
- Cover prefix dependencies, isolated failures, warm restoration, stale epoch rejection, cache eviction, image probe sharing/concurrency/timeout/TTL, image invalidation, and scroll interactions with automated regression tests.
- Run `npm test`, `npm run check`, and `git diff --check` for implementation changes.
- Treat actual pixel stability, natural image appearance, and frame-time improvements as Obsidian runtime validation, separate from mocked-layout tests.
- The optimization plan's restoration and deep-jump timings are performance targets, not established guarantees. See [performance validation](performance-validation.md) for coverage and remaining real-device measurements, and [the optimization plan](performance-optimization-plan.md) for design background.
