# Keep Bases View Requirements

## Purpose

Keep Bases View is an Obsidian plugin that adds a Google Keep-style card layout as a custom Bases view.

The plugin is optimized for large `.base` result sets by using a fixed-width virtual masonry layout, lightweight note previews, and offscreen card measurement before visible cards are mounted.

## Functional Requirements

- Register a custom Bases view named `Keep Bases View` with the `layout-dashboard` icon.
- Display `.base` query results as Google Keep-style masonry cards.
- Use fixed card widths from the view options for desktop, tablet, and mobile.
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
- Represent common Markdown structures in lightweight previews where practical, including paragraphs, headings, bullet lines, task checkboxes, code blocks, tables, callouts, and images.
- Add a bottom fade only when preview content is actually clipped or truncated.
- Hide body preview spacing when a file has no renderable body preview.
- Hide tag spacing when tags are disabled or absent.
- Optionally render embedded `.base` files as card previews.
- Use Obsidian's Markdown embed renderer for `.base` previews when enabled.
- Provide view options for title property, image property, image fit, desktop/tablet/mobile card widths, tags, pinned notes, `.base` previews, card preview height, and `.base` preview height.
- Provide plugin settings for the specific `.base` path, popup behavior, popup width, and performance logging.
- Provide commands to fuzzy-open any `.base` file and to open a configured `.base` file.

## Virtual Masonry Requirements

- Mount only cards near the visible viewport plus an overscan range.
- Keep virtual card positions absolute within each virtual section.
- Calculate card heights before mounting cards into the visible masonry grid whenever no height cache exists.
- Measure cards in a hidden/offscreen measurement container.
- Use measured height cache keys that account for file path, file mtime, card width, preview height, `.base` preview height, tag visibility, title/image settings, shown properties, and virtual preview line count.
- Do not visibly grow or shrink an already mounted card during normal scrolling.
- Prioritize measuring cards that are in or near the viewport.
- Avoid pre-rendering heavy `.base` previews far ahead of the viewport.
- Use cached measured heights for revisited cards so returning to a previous scroll area is fast.
- Recalculate layout when card width, pane width, relevant configuration, or result data changes.
- Keep mobile bottom padding large enough that floating Obsidian controls do not hide the last cards.

## Performance Requirements

- Avoid rebuilding DOM when Bases sends the same data and configuration again.
- Avoid nested scroll containers inside the Bases view.
- Keep normal note previews lightweight; do not use full Obsidian Markdown rendering for Markdown or text cards.
- Keep preview rendering best-effort so one failed card does not break the whole view.
- Render and measure work in small asynchronous batches where possible.
- Keep scroll handlers cheap and schedule virtual window updates with animation frames.
- Keep cover image frames stable with a fixed aspect ratio.
- Retry cover image resolution when metadata is not ready during the first render.
- Avoid scroll jank caused by visible card height changes.
- Allow optional performance logging to the developer console for diagnosing slow cards or previews.
- Keep implementation self-contained in `main.js` and compatible with the existing `manifest.json` and `styles.css`.

## Animation Requirements

- Animate cards sliding to their new positions when the column count changes due to window or sidebar resize (card reflow).
- Provide a setting in the Community Plugin options to toggle this animation on/off (`enableAnimation`, enabled by default).
- For the standard (non-virtual) grid layout:
  - Implement a traditional FLIP (First, Last, Invert, Play) animation.
  - Measure before/after bounding rects, apply the inverted transform instantly with transitions disabled, force a reflow, and trigger the transition back to the default position in the next animation frame.
- For the virtual masonry layout:
  - Avoid standard DOM rect-based FLIP animations because `ResizeObserver` fires continuously during resizing/sidebar dragging, which introduces timing gaps (e.g. `requestAnimationFrame` delay) that cause jitter, lag, or incorrect intermediate states.
  - Use the Web Animations API (`Element.animate`) to transition directly and atomically from the old logical position to the new logical position.
  - Track target logical positions via a custom property (`_kgVirtualTransform`) to avoid reading mid-animation styles.
  - Cancel any ongoing reflow animation (`_kgReflowAnimation.cancel()`) immediately when a new resize event fires, avoiding animation stack-up and ensuring responsiveness during active dragging.
  - Ensure standard CSS transitions are disabled for virtual cards (`.kg-no-animations .kg-virtual-card { transition: none !important; }`) to prevent interference with Web Animations API.
