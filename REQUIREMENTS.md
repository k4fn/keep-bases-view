# Keep Bases View Requirements

## Purpose

Keep Bases View is an Obsidian plugin that adds a Google Keep-style card layout as a custom Bases view.

## Functional Requirements

- Register a custom Bases view named `Keep Bases View` with the `layout-grid` icon.
- Display `.base` query results as responsive Google Keep-style masonry cards.
- Preserve left-to-right card ordering before wrapping to the next masonry row.
- Keep vertical masonry gaps compact.
- Calculate exact card heights before cards are inserted into the visible masonry grid.
- Preserve the current tab's scroll position when switching away and back.
- Use the Bases-provided scroll element as the only vertical scroll container.
- Split pinned notes into a `Pinned` section when `keep_pinned` is true.
- Display all other notes in an `Others` section when pinned notes exist.
- Allow pinning and unpinning Markdown notes via `keep_pinned` frontmatter.
- Allow card color changes via `keep_color` frontmatter.
- Allow deleting a note after confirmation by moving it to the Obsidian trash.
- Show a context menu with open in new tab, pin/unpin, color, and delete actions.
- Open a clicked card in a popup editor by default.
- Open a clicked card in a normal Obsidian leaf when the popup setting is disabled or the modifier key is used.
- Trigger Obsidian hover previews for cards.
- Display a configurable title property, falling back to the file basename/name.
- Display selected Bases properties, excluding duplicate title/file-name properties.
- Display tags from frontmatter and inline metadata when enabled.
- Display an optional cover image from a configured property.
- Support cover image `cover` and `contain` fit modes.
- Render Markdown or text body previews with frontmatter removed and length limited.
- Render body previews lazily, prioritizing cards near the visible viewport.
- Do not change card masonry spans after cards become visible during normal scrolling.
- Optionally render embedded `.base` files as card previews.
- Provide view options for title property, image property, image fit, card widths, tags, pinned notes, `.base` previews, card preview height, and `.base` preview height.
- Provide plugin settings for the specific `.base` path, popup behavior, popup width, and layout animation.
- Provide commands to fuzzy-open any `.base` file and to open a configured `.base` file.

## Non-Functional Requirements

- Avoid rebuilding DOM when Bases sends the same data and configuration again.
- Avoid nested scroll containers inside the Bases view.
- Prefer normal document flow and CSS Grid row spans over vertical CSS columns or manual absolute positioning for cards.
- Split large result rendering across animation frames so opening a `.base` file stays responsive.
- Use browser-level offscreen rendering skips so scrolling cost does not grow sharply with every loaded card.
- Keep cover image frames stable with a fixed aspect ratio.
- Preload additional cards before the user reaches the bottom of the current rendered window.
- Retry cover image resolution when metadata is not ready during the first render.
- Keep preview rendering best-effort so one failed card does not break the whole view.
- Keep implementation self-contained in `main.js` and compatible with the existing `manifest.json` and `styles.css`.
