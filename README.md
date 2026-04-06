# NoteSnap

A Chrome extension for capturing notes, screenshots, and voice memos — and syncing everything to your Obsidian vault.

---

## Features

### 📸 One-click screenshot capture
Click the camera button to capture the current tab as an image. The screenshot is embedded directly in your note as a thumbnail — no downloads, no file management.

### ✏️ Rich Markdown editor
Write notes with a full formatting toolbar: H1–H4 headings, bold, italic, strikethrough, inline code, bullet lists, numbered lists, checkboxes, blockquotes, code blocks, and horizontal rules. All formatting is stored as standard Markdown.

### 🎤 Voice notes
Click the microphone button to open the voice recorder. Speech is transcribed live using the Web Speech API and appended to your current note as a blockquote. Supports 10 languages:
- English (US / UK)
- Chinese (Mandarin · Traditional · Cantonese)
- Japanese · Korean
- Spanish · French · German

### 🔄 Obsidian sync
Notes sync to your local Obsidian vault via the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) community plugin. Each note becomes a `.md` file in your chosen vault folder. Images are saved to an `attachments/` subfolder and embedded as Obsidian wikilinks.

- **Save Note** pushes the note to Obsidian immediately.
- **Sync button (↻)** pulls the latest state from Obsidian, overwriting local edits with the vault's version.
- Images inserted directly in Obsidian (`![[...]]`) are fetched and shown as thumbnails on the next pull.
- Rearranging images in the editor preserves their order when pushed.

### 📁 Vault folder selection
Click the folder chip in the top bar to browse and select any folder in your vault as the sync destination. The folder is created automatically on first sync.

### 🔍 Search & filter
Search notes by text. Filter by status: All, Pending, Synced, or With Images.

### 🖱️ Drag to reorder images
In the editor, drag the grip handle (`⠿`) on any screenshot block to reorder it. The new order is pushed to Obsidian on the next save.

---

## Setup

### 1. Install the extension
1. Go to `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select the `video-notes-extension` folder

### 2. Connect to Obsidian
1. Open Obsidian → **Settings → Community plugins** → disable Restricted mode → click **Browse**
2. Search **Local REST API** → Install → Enable
3. Go to **Settings → Local REST API** → enable **"Enable Non-encrypted (HTTP) Server"** → copy the API key
4. In NoteSnap, click the **chain link icon** (top-right of the panel)
5. Click **"I have the API Key →"**, paste the URL (`http://127.0.0.1:27123`) and API key → **Test Connection** → **Save & Connect**

### 3. Select a vault folder
Click the **📁 folder chip** → type a folder path (e.g. `Video Notes`) → click **Set**.

---

## Usage

| Action | How |
|--------|-----|
| New note | Click ✏️ or the **Editor** tab |
| Capture screenshot | Click 📸 (inserts at cursor position) |
| Voice note | Click 🎤 → record → **Add to Note** |
| Format text | Select text → click a toolbar button |
| Save & push to Obsidian | Click **Save Note** (orange dot = unsaved changes) |
| Pull latest from Obsidian | Click ↻ sync button (top-right) |
| Open note | Click a note card in the **Notes** tab |
| Delete note | Click ··· on a note card → Delete |

---

## File format in Obsidian

A synced note is a plain `.md` file:

```markdown
This is my note text.

More paragraphs here.

> Voice transcription appears as a blockquote.

![[attachments/note-abc123-0.jpg]]
```

Images are stored at `<vault-folder>/attachments/<filename>.jpg`.

---

## Building for the Chrome Web Store

```bash
./build.sh
```

Creates `notesnap-v1.0.0.zip` with only the extension files. Upload to the [Chrome Developer Console](https://chrome.google.com/webstore/devconsole).

See `store-assets/store-listing.md` for the full store submission copy.

---

## Permissions

| Permission | Why it's needed |
|------------|-----------------|
| `activeTab` | Read the current tab's URL/title and capture a screenshot |
| `tabs` | Detect which tab has video content for note association |
| `storage` | Save notes and settings locally in the browser |
| `sidePanel` | Display the NoteSnap panel alongside web content |
| `unlimitedStorage` | Store embedded screenshots without the default 5 MB cap |
| `alarms` | Schedule automatic sync retries when Obsidian is temporarily offline |
| `host: <all_urls>` | Capture screenshots from any webpage |
| `host: 127.0.0.1` | Connect to Obsidian Local REST API on localhost |

---

## Project structure

```
src/
├── background/
│   ├── service-worker.js       # Message hub, screenshot capture
│   ├── obsidian-client.js      # Obsidian Local REST API wrapper
│   └── sync-manager.js         # Sync queue, pull/push logic, markdown parsing
├── content/
│   ├── content-script.js       # YouTube/Udemy video detection
│   └── frame-capturer.js       # Canvas frame capture
├── modules/
│   ├── speech/
│   │   └── speech-recognizer.js    # Web Speech API (auto-restart on silence)
│   ├── storage/
│   │   ├── note-repository.js      # Note CRUD
│   │   └── sync-queue.js           # Offline queue with exponential backoff
│   └── utils/
│       ├── message-bus.js          # Type-safe inter-context messaging
│       └── logger.js
└── sidepanel/
    ├── sidepanel.html
    ├── sidepanel.js            # UI logic
    └── sidepanel.css
```
