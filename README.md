# Keep Bases View

A custom [Bases](https://obsidian.md/ja/help/bases) view plugin for Obsidian that displays your notes in a Google Keep-style masonry grid.

![Keep Bases View screenshot](https://github.com/user-attachments/assets/eb923fe2-584f-4f63-a0d5-799eb5ce2333)

## Getting Started

1. Enable the **Bases** plugin in Obsidian.
2. Open a `.base` file and switch the view type to **Keep Bases View**.
3. Use the > icon to configure the view options.

## Features

| Feature | Description |
|---------|-------------|
| **Masonry grid** | Responsive card layout, columns auto-adjust as the panel resizes |
| **Pin notes** | Pin important notes to the top. Synced with `keep_pinned` frontmatter |
| **Card colors** | Color-code notes like Google Keep. Synced with `keep_color` frontmatter |
| **Cover images** | Display a cover image from any note property |
| **Body preview** | Shows a markdown preview of each note's body text |
| **Popup editor** | Click a card to edit it in a Google Keep-style popup containing the full Obsidian Live Preview editor |
| **.base preview** | Embed another `.base` file's table directly in a card |
| **Context menu** | Right-click (desktop) or long-press (mobile) for quick actions |

## View Options

Configure these from the > icon in the Bases view:

- **Card title property** — Property to use as the card title (default: file name)
- **Cover image property** — Property containing the cover image
- **Image fit** — Crop to fill (Cover) or show full image (Contain)
- **Card width** — Separate width settings for Desktop / Tablet / Mobile
- **Show tags** — Toggle tag display on cards
- **Pin important notes to the top** — Shows pinned notes in a separate "Pinned" section
- **Preview .base file contents** — Toggle inline `.base` table preview
- **Card preview max height** — Maximum height of the body preview area
- **.base embed fixed height** — Fixed height for embedded `.base` previews

## Plugin Settings

**Settings → Community Plugins → Keep Bases View**

- **Enable layout animation** — Smoothly animate cards when the window or sidebar is resized (default: ON)
- **Open in popup** — Open cards in a Google Keep-like popup modal for quick editing
- **Popup max width (px)** — Set the maximum width of the edit popup (default: 800)
- **Specific .base file path** — Path used by the "Open specific .base file" command

## Context Menu

Right-click a card on desktop (or long-press on mobile) to access these actions:

| Action | Description |
|--------|-------------|
| **Open in new tab** | Opens the note in a new Obsidian tab |
| **Pin / Unpin** | Toggles the pin state (`keep_pinned` frontmatter) |
| **Change color** | Opens a color palette to set the card color (`keep_color` frontmatter) |
| **Delete** | Moves the note to the trash (with a confirmation prompt) |

## Commands

- **Open a .base file** — Fuzzy search and open any `.base` file in the vault
- **Open specific .base file** — Instantly open the `.base` file set in Plugin Settings
