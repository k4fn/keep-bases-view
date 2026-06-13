# Keep Bases View

A custom [Bases](https://obsidian.md/help/bases) view plugin for Obsidian that displays `.base` results in a Google Keep-style card layout.

![Keep Bases View screenshot](https://github.com/user-attachments/assets/eb923fe2-584f-4f63-a0d5-799eb5ce2333)

## Getting Started

1. Enable the **Bases** core plugin in Obsidian.
2. Open a `.base` file.
3. Switch the view type to **Keep Bases View**.
4. Use the Bases view options menu to customize the cards.

## Features

| Feature | Description |
| --- | --- |
| **Keep-style cards** | Show Bases results as compact cards. |
| **Pinned notes** | Show notes with `keep_pinned: true` in a separate `Pinned` section. |
| **Card colors** | Color notes with `keep_color` frontmatter. |
| **Cover images** | Display a cover image from a configured property. |
| **Body previews** | Show note body previews with frontmatter removed. |
| **Tags** | Show frontmatter and inline tags on cards. |
| **.base previews** | Preview `.base` files inside cards when enabled. |
| **Popup editor** | Open cards in a Google Keep-like popup editor. |
| **Scroll restore** | Return to the previous scroll position after opening a card. |
| **Context menu** | Open, pin, recolor, or delete cards from the card menu. |

## View Options

Configure these from the Bases view options menu:

- **Card title property** - Property to use as the card title. Defaults to the file name.
- **Cover image property** - Property containing the cover image path or link.
- **Image fit** - Crop to fill (`cover`) or show the full image (`contain`).
- **Card width - Desktop (px)** - Card width on desktop.
- **Card width - Tablet (px)** - Card width on tablet.
- **Card width - Mobile (px)** - Card width on phone/mobile layouts.
- **Show tags** - Toggle tag display on cards.
- **Pin important notes to the top** - Show pinned notes in a separate `Pinned` section.
- **Preview .base file contents** - Toggle inline `.base` previews.
- **Card preview max height (px)** - Maximum height of note body previews.
- **.base embed fixed height (px)** - Height for embedded `.base` previews.

## Plugin Settings

Open **Settings > Community Plugins > Keep Bases View**:

- **Specific .base file path** - Path used by the `Open specific .base file` command.
- **Open in popup** - Open cards in the popup editor by default.
- **Popup max width (px)** - Maximum width of the edit popup. Default is `800`.
- **Enable performance logging** - Log slow operations to the developer console for troubleshooting.

## Card Actions

Click a card to open it in the popup editor. Use a modifier key, or disable **Open in popup**, to open it in a normal Obsidian tab.

Right-click a card on desktop, or long-press on mobile, to access:

| Action | Description |
| --- | --- |
| **Open in new tab** | Opens the note in a new Obsidian tab. |
| **Pin / Unpin** | Toggles `keep_pinned` frontmatter. Markdown files only. |
| **Change color** | Sets `keep_color` frontmatter. Markdown files only. |
| **Delete** | Moves the file to the Obsidian trash after confirmation. |

Desktop cards also show hover controls for pin, color, and delete.

## Commands

- **Open a .base file** - Fuzzy search and open any `.base` file in the vault.
- **Open specific .base file** - Open the `.base` file configured in Plugin Settings.
