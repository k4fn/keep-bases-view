/*
 * Keep Bases View — main.js
 * Google Keep-style masonry grid layout for Obsidian Bases.
 *
 * Registers as a custom Bases layout via registerBasesView().
 * Cards are rendered using CSS `columns` (native Masonry).
 * Body text: metadata cache first, vault.cachedRead() async fallback.
 */
"use strict";

const obsidian = require("obsidian");

// ─── Constants ────────────────────────────────────────────────────────────────

const KEEP_VIEW_TYPE = "keep-grid-view";
const HOVER_SOURCE   = "keep-bases-view";
const DEBOUNCE_MS    = 50;



// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip YAML front-matter and return truncated markdown body.
 * Preserves checkboxes, tables, code blocks, etc. for MarkdownRenderer.
 */
function extractBodyMarkdown(content, maxLines = 25, maxChars = 1000) {
	let body = content;
	if (body.startsWith("---")) {
		const end = body.indexOf("\n---", 3);
		if (end !== -1) body = body.slice(end + 4).trimStart();
	}
	if (!body.trim()) return null;

	const lines = body.split("\n");
	const kept = lines.slice(0, maxLines).join("\n");
	const result = kept.length > maxChars ? kept.slice(0, maxChars) : kept;
	return result.trim() || null;
}

/** Resolve a raw image value (URL or wiki-link) to an <img> src. */
function resolveImageSrc(raw, filePath, app) {
	if (!raw) return null;
	if (/^https?:\/\//i.test(raw)) return raw;

	let linkText = raw.replace(/^!\s*/, "");
	const wiki = linkText.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/);
	if (wiki) linkText = wiki[1].trim();

	const imgFile = app.metadataCache.getFirstLinkpathDest(linkText, filePath);
	return imgFile ? app.vault.getResourcePath(imgFile) : null;
}

// ─── KeepGridView ─────────────────────────────────────────────────────────────

class KeepGridView extends obsidian.BasesView {

	constructor(controller, scrollEl) {
		super(controller);
		this.type        = KEEP_VIEW_TYPE;
		this.hoverPopover = null;

		this._scrollEl    = scrollEl;
		this._containerEl = scrollEl.createDiv({ cls: "kg-container" });

		// config values (populated in loadConfig)
		this._imagePropertyId     = null;
		this._cardTitlePropertyId = null;
		this._cardWidthPc = 240;
		this._cardWidthTablet = 200;
		this._cardWidthMobile = 150;
		this._lastColumnCount = null; // FLIPアニメーション用
		this._showTags     = true;
		this._showPinned   = true;
		this._imageFit     = "cover";

		this._debouncedRender = obsidian.debounce(() => {
			try {
				this.loadConfig();
				this.render();
			} catch (err) {
				console.error("[KeepGridView] render error:", err);
			}
		}, DEBOUNCE_MS);

		// ResizeObserver: コンテナ幅が変わったらグリッド幅を再計算
		this._resizeObserver = new ResizeObserver(() => this._updateGridWidth());
		this._resizeObserver.observe(this._containerEl);
	}

	// ── Bases lifecycle ────────────────────────────────────────────────────────

	onDataUpdated() {
		this._debouncedRender();
	}

	onClose() {
		this._debouncedRender.cancel();
		this._resizeObserver.disconnect();
	}

	// ── Config ─────────────────────────────────────────────────────────────────

	loadConfig() {
		const cfg = this.config;
		this._imagePropertyId     = cfg?.getAsPropertyId("imageProperty")     ?? null;
		this._cardTitlePropertyId = cfg?.getAsPropertyId("cardTitleProperty")  ?? null;
		this._cardWidthPc = Math.max(150, Math.min(500, Number(cfg?.get("cardWidthPc") ?? 240)));
		this._cardWidthTablet = Math.max(100, Math.min(500, Number(cfg?.get("cardWidthTablet") ?? 200)));
		this._cardWidthMobile = Math.max(100, Math.min(500, Number(cfg?.get("cardWidthMobile") ?? 150)));
		this._showTags   = cfg?.get("showTags")   !== false;
		this._showPinned = cfg?.get("showPinned") !== false;
		this._imageFit   = String(cfg?.get("imageFit") ?? "cover");
		this._showBasePreview = cfg?.get("showBasePreview") !== false;
		this._cardMaxHeight = Number(cfg?.get("cardMaxHeight") ?? 320);
		this._basePreviewHeight = Number(cfg?.get("basePreviewHeight") ?? 150);
	}

	static getViewOptions() {
		return [
			{
				displayName: "カードタイトルのプロパティ",
				type: "property",
				key: "cardTitleProperty",
				placeholder: "デフォルト: ファイル名",
			},
			{
				displayName: "画像プロパティ",
				type: "property",
				key: "imageProperty",
				placeholder: "任意: カバー画像のプロパティを指定",
			},
			{
				displayName: "画像の表示方法",
				type: "dropdown",
				key: "imageFit",
				default: "cover",
				options: { cover: "枠に合わせて切り抜き (Cover)", contain: "画像全体を表示 (Contain)" },
			},
			{
				displayName: "カード幅 (PC) (px)",
				type: "slider",
				key: "cardWidthPc",
				default: 240,
				min: 150,
				max: 500,
				step: 5,
			},
			{
				displayName: "カード幅 (タブレット) (px)",
				type: "slider",
				key: "cardWidthTablet",
				default: 200,
				min: 100,
				max: 500,
				step: 5,
			},
			{
				displayName: "カード幅 (スマホ) (px)",
				type: "slider",
				key: "cardWidthMobile",
				default: 150,
				min: 100,
				max: 500,
				step: 5,
			},
			{
				displayName: "タグを表示する",
				type: "toggle",
				key: "showTags",
			},
			{
				displayName: "ピン留めしたノートを上部に表示",
				type: "toggle",
				key: "showPinned",
			},
			{
				displayName: ".baseファイルの中身をプレビューする",
				type: "toggle",
				key: "showBasePreview",
				default: true,
			},
			{
				displayName: "カードのプレビュー最大高さ (px)",
				type: "slider",
				key: "cardMaxHeight",
				default: 320,
				min: 100,
				max: 800,
				step: 5,
			},
			{
				displayName: ".baseプレビューの固定高さ (px)",
				type: "slider",
				key: "basePreviewHeight",
				default: 150,
				min: 50,
				max: 500,
				step: 5,
			},
		];
	}

	get currentCardWidth() {
		// Obsidian adds .is-phone or .is-tablet to document.body on mobile devices
		if (document.body.classList.contains("is-phone")) {
			return this._cardWidthMobile;
		} else if (document.body.classList.contains("is-tablet")) {
			return this._cardWidthTablet;
		}
		return this._cardWidthPc;
	}

	// ── Render ─────────────────────────────────────────────────────────────────

	render() {
		const entries = this.data?.data ?? [];
		const el = this._containerEl;
		el.empty();

		// 再レンダー後の最初の _updateGridWidth() はアニメーションさせない
		// （ノートから戻ったときなどにアニメーションが走るのを防ぐ）
		this._lastColumnCount = null;
		
		el.style.setProperty("--kg-card-max-height", `${this._cardMaxHeight}px`);
		el.style.setProperty("--kg-card-max-lines", Math.floor(this._cardMaxHeight / 19.5).toString());
		el.style.setProperty("--kg-base-preview-height", `${this._basePreviewHeight}px`);

		if (entries.length === 0) {
			el.createDiv({ cls: "kg-empty", text: "No notes found." });
			return;
		}

		let pinned = [];
		let normal = [];

		if (this._showPinned) {
			for (const entry of entries) {
				const fm = this._getFrontmatter(entry.file);
				if (fm["keep_pinned"] === true || fm["keep_pinned"] === "true") {
					pinned.push(entry);
				} else {
					normal.push(entry);
				}
			}
		} else {
			normal = entries;
		}

		if (pinned.length > 0) {
			this._renderSection(el, "固定済み", pinned);
		}
		if (normal.length > 0) {
			this._renderSection(el, pinned.length > 0 ? "その他" : null, normal);
		}

		// レンダー後にグリッド幅を確定させる
		this._updateGridWidth();
	}

	/**
	 * コンテナ幅からカラム数を整数計算し、グリッドの width を
	 * N × cardWidth + (N-1) × gap に固定することでカード幅を一定に保つ。
	 * カラム数が変化したときのみFLIPアニメーションを実行する。
	 */
	_updateGridWidth() {
		const gap = 12;
		const cardWidth = this.currentCardWidth;
		const containerWidth = this._containerEl.clientWidth - 32; // padding 16px×2
		const n = Math.max(1, Math.floor((containerWidth + gap) / (cardWidth + gap)));
		const gridWidth = n * cardWidth + (n - 1) * gap;

		// カラム数が変化したときのみFLIPを実行（毎ピクセルのリサイズでは発火しない）
		const prevN = this._lastColumnCount;
		const shouldAnimate = prevN !== null && prevN !== n;
		this._lastColumnCount = n;

		for (const grid of this._containerEl.querySelectorAll(".kg-grid")) {
			if (shouldAnimate) {
				// FLIP: First — 変更前の各カード座標を記録
				const cards = [...grid.querySelectorAll(".kg-card")];
				const oldRects = cards.map(c => c.getBoundingClientRect());

				// FLIP: Last — レイアウトを即座に適用
				grid.style.setProperty("--kg-columns", String(n));
				grid.style.width = `${gridWidth}px`;

				// FLIP: Invert & Play — 旧座標に巧居りしてから新座標へアニメーション
				cards.forEach((card, i) => {
					const newRect = card.getBoundingClientRect();
					const dx = oldRects[i].left - newRect.left;
					const dy = oldRects[i].top  - newRect.top;

					if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

					// 旧座標に瞬時戻す（transitionなし）
					card.style.transition = "none";
					card.style.transform  = `translate(${dx}px, ${dy}px)`;

					// リフローを強制して "none" 状態をコミット
					void card.offsetWidth;

					// 新座標へアニメーション
					card.style.transition = "transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)";
					card.style.transform  = "";

					// 完了後にインラインスタイルをクリーンアップ（hoverのtransformを活かす）
					const onEnd = (e) => {
						if (e.propertyName !== "transform") return;
						card.style.transition = "";
						card.removeEventListener("transitionend", onEnd);
					};
					card.addEventListener("transitionend", onEnd);
				});
			} else {
				// 初回レンダーまたは同カラム数の場合は即座に適用
				grid.style.setProperty("--kg-columns", String(n));
				grid.style.width = `${gridWidth}px`;
			}
		}
	}

	_renderSection(parentEl, label, entries) {
		const section = parentEl.createDiv({ cls: "kg-section" });
		if (label) {
			section.createDiv({ cls: "kg-section-label", text: label });
		}
		const grid = section.createDiv({ cls: "kg-grid" });
		for (const entry of entries) {
			grid.appendChild(this._createCard(entry));
		}
	}

	// ── Card ───────────────────────────────────────────────────────────────────

	_createCard(entry) {
		const file = entry.file;
		const fm   = this._getFrontmatter(file);
		const cache = this.app?.metadataCache.getFileCache(file) ?? {};

		const cardEl = document.createElement("div");
		cardEl.className = "kg-card";
		cardEl.setAttribute("data-path", file.path);
		if (fm["keep_color"]) {
			cardEl.dataset.keepColor = fm["keep_color"];
		}

		// ── Pin badge (Mobile only) ────────────────────────────────────────────
		const isPinned = fm["keep_pinned"] === true || fm["keep_pinned"] === "true";
		if (obsidian.Platform.isMobile && isPinned) {
			const pinEl = cardEl.createDiv({ cls: "kg-card-pin" });
			obsidian.setIcon(pinEl, "pin");
		}

		// ── Cover image ────────────────────────────────────────────────────────
		if (this._imagePropertyId) {
			this._renderCover(cardEl, entry, file.path);
		}

		// ── Title ──────────────────────────────────────────────────────────────
		const titleEl = cardEl.createDiv({ cls: "kg-card-title" });
		this._renderTitle(titleEl, entry);

		// ── Selected properties ────────────────────────────────────────────────
		this._renderProperties(cardEl, entry);

		// ── Body preview (async) ───────────────────────────────────────────────
		// markdown-rendered class is required for Obsidian's theme CSS
		// (checkbox, code block, etc.) to apply correctly.
		const bodyEl = cardEl.createDiv({ cls: "kg-card-body markdown-rendered" });
		bodyEl.style.display = "none"; // hidden until content arrives

		if (this.app) {
			if (file.extension === "base") {
				if (this._showBasePreview) {
					bodyEl.style.display = "";
					bodyEl.addClass("kg-card-body-base");
					obsidian.MarkdownRenderer.render(
						this.app,
						`![[${file.path}]]`,
						bodyEl,
						file.path,
						this
					);
				}
			} else {
				this.app.vault.cachedRead(file)
					.then(async content => {
						const markdown = extractBodyMarkdown(content);
						if (markdown) {
							bodyEl.style.display = "";
							await obsidian.MarkdownRenderer.render(
								this.app,
								markdown,
								bodyEl,
								file.path,
								this  // Component (BasesView extends Component)
							);
						}
					})
					.catch(() => {});
			}
		}

		// ── Tags ───────────────────────────────────────────────────────────────
		if (this._showTags) {
			this._renderTags(cardEl, fm, cache.tags);
		}

		// ── Interactions ───────────────────────────────────────────────────────

		const handlePin = async () => {
			if (file.extension !== "md") {
				new obsidian.Notice("ピン留めはMarkdown(.md)ファイルでのみサポートされています。");
				return;
			}
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				frontmatter["keep_pinned"] = !isPinned;
			});
		};

		const handleColorChange = (e) => {
			e.stopPropagation();
			// Remove any existing color palette popups
			document.querySelectorAll(".kg-color-palette").forEach(el => el.remove());

			if (file.extension !== "md") {
				new obsidian.Notice("色の変更はMarkdown(.md)ファイルでのみサポートされています。");
				return;
			}

			const currentColor = fm["keep_color"] ?? "default";

			const colors = [
				{ id: "default", label: "デフォルト", hex: null },
				{ id: "red",     label: "レッド",     hex: "#f28b82" },
				{ id: "orange",  label: "オレンジ",   hex: "#fbbc04" },
				{ id: "yellow",  label: "イエロー",   hex: "#fff475" },
				{ id: "green",   label: "グリーン",   hex: "#ccff90" },
				{ id: "cyan",    label: "シアン",     hex: "#a8f0e0" },
				{ id: "blue",    label: "ブルー",     hex: "#aecbfa" },
				{ id: "purple",  label: "パープル",   hex: "#d7aefb" },
				{ id: "pink",    label: "ピンク",     hex: "#fdcfe8" },
			];

			const palette = document.createElement("div");
			palette.className = "kg-color-palette";

			colors.forEach(color => {
				const btn = palette.createEl("button", { cls: "kg-color-swatch" });
				btn.setAttribute("aria-label", color.label);
				btn.setAttribute("title", color.label);
				if (color.hex) {
					btn.style.backgroundColor = color.hex;
				} else {
					// "default" — eraser icon
					btn.classList.add("kg-color-swatch-default");
				}
				// Show checkmark if this is the currently selected color
				if (color.id === currentColor) {
					btn.classList.add("kg-color-swatch-active");
					const check = btn.createEl("span", { cls: "kg-color-check" });
					obsidian.setIcon(check, "check");
				}
				btn.addEventListener("click", async (ev) => {
					ev.stopPropagation();
					palette.remove();
					await this.app.fileManager.processFrontMatter(file, (fm) => {
						if (color.id === "default") delete fm["keep_color"];
						else fm["keep_color"] = color.id;
					});
				});
			});

			// Position near the button
			const rect = e.target.closest(".kg-action-btn")?.getBoundingClientRect?.() || { bottom: e.clientY, left: e.clientX };
			document.body.appendChild(palette);
			const pw = palette.offsetWidth;
			const ph = palette.offsetHeight;
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			let top = rect.bottom + 6;
			let left = rect.left;
			if (left + pw > vw - 8) left = vw - pw - 8;
			if (top + ph > vh - 8) top = (rect.top || rect.bottom) - ph - 6;
			palette.style.top = `${top}px`;
			palette.style.left = `${left}px`;

			// Close on outside click
			const close = (ev) => {
				if (!palette.contains(ev.target)) {
					palette.remove();
					document.removeEventListener("click", close, true);
				}
			};
			setTimeout(() => document.addEventListener("click", close, true), 0);
		};

		const handleDelete = async () => {
			new ConfirmModal(this.app, `「${file.name}」を削除してゴミ箱に移動しますか？`, async () => {
				await this.app.vault.trash(file, true);
			}).open();
		};

		// Hover actions (PC only)
		if (!obsidian.Platform.isMobile) {
			// Pin button (Top Right)
			const pinBtn = cardEl.createEl("button", { 
				cls: "kg-pin-btn clickable-icon" + (isPinned ? " is-pinned" : ""), 
				attr: { "aria-label": isPinned ? "ピン留め解除" : "ピン留め" } 
			});
			obsidian.setIcon(pinBtn, isPinned ? "pin-off" : "pin");
			pinBtn.addEventListener("click", (e) => { e.stopPropagation(); handlePin(); });

			// Bottom Right Actions
			const actionsEl = cardEl.createDiv({ cls: "kg-card-actions" });
			
			const colBtn = actionsEl.createEl("button", { cls: "kg-action-btn clickable-icon", attr: { "aria-label": "色を変更" } });
			obsidian.setIcon(colBtn, "palette");
			colBtn.addEventListener("click", (e) => { e.stopPropagation(); handleColorChange(e); });
			
			const delBtn = actionsEl.createEl("button", { cls: "kg-action-btn clickable-icon", attr: { "aria-label": "削除" } });
			obsidian.setIcon(delBtn, "trash");
			delBtn.addEventListener("click", (e) => { e.stopPropagation(); handleDelete(); });
		}

		// Context menu (Mobile / iPad long-press)
		cardEl.addEventListener("contextmenu", (e) => {
			if (obsidian.Platform.isMobile) {
				e.preventDefault();
				const menu = new obsidian.Menu();
				menu.addItem((item) => {
					item.setTitle(isPinned ? "ピン留めを解除" : "ピン留め")
						.setIcon(isPinned ? "pin-off" : "pin")
						.onClick(handlePin);
				});
				menu.addItem((item) => {
					item.setTitle("色を変更")
						.setIcon("palette")
						.onClick(() => handleColorChange(e));
				});
				menu.addItem((item) => {
					item.setTitle("削除")
						.setIcon("trash")
						.onClick(handleDelete);
				});
				menu.showAtMouseEvent(e);
			}
		});

		cardEl.addEventListener("click", (e) => {
			// Avoid opening note if clicked on an action button or link
			if (e.target instanceof Element && (e.target.closest("a") || e.target.closest(".kg-action-btn") || e.target.closest(".kg-pin-btn"))) return;
			if (!this.app?.workspace) return;
			
			const newLeaf = obsidian.Keymap.isModEvent(e);
			const leaf = this.app.workspace.getLeaf(newLeaf);
			void leaf.openFile(file);
		});

		cardEl.addEventListener("mouseover", (e) => {
			if (e.relatedTarget instanceof Element && cardEl.contains(e.relatedTarget)) return;
			if (e.target instanceof Element && e.target.closest("a")) return;
			this.app?.workspace.trigger("hover-link", {
				event: e,
				source: HOVER_SOURCE,
				hoverParent: this,
				targetEl: cardEl,
				linktext: file.path,
				sourcePath: "",
			});
		});

		return cardEl;
	}

	// ── Sub-renderers ──────────────────────────────────────────────────────────

	_renderCover(cardEl, entry, filePath) {
		const value = entry.getValue(this._imagePropertyId);
		if (!value) return;
		// Check for Obsidian's NullValue
		try {
			if (value instanceof obsidian.NullValue) return;
		} catch (_) {}
		const raw = value.toString().trim();
		if (!raw) return;

		const src = resolveImageSrc(raw, filePath, this.app);
		if (!src) return;

		const coverEl = cardEl.createDiv({
			cls: `kg-card-cover kg-card-cover--${this._imageFit}`,
		});
		coverEl.createEl("img", { attr: { src, alt: "" } });
	}

	_renderTitle(titleEl, entry) {
		if (this._cardTitlePropertyId) {
			const val = entry.getValue(this._cardTitlePropertyId);
			if (val) {
				try { if (val instanceof obsidian.NullValue) throw new Error(); } catch (_) {}
				const str = val.toString().trim();
				if (str) {
					if (this.app?.renderContext) {
						try {
							val.renderTo(titleEl, this.app.renderContext);
							return;
						} catch (_) {}
					}
					titleEl.textContent = str;
					return;
				}
			}
		}
		titleEl.textContent = entry.file.basename;
	}

	_renderTags(cardEl, fm, inlineTags) {
		const seen = new Set();
		const tags = [];

		const fmRaw = fm["tags"] ?? fm["tag"] ?? [];
		const fmList = Array.isArray(fmRaw) ? fmRaw
		             : typeof fmRaw === "string" ? [fmRaw] : [];
		for (const t of fmList) {
			const tag = t.startsWith("#") ? t : `#${t}`;
			if (!seen.has(tag)) { seen.add(tag); tags.push(tag); }
		}
		for (const item of inlineTags ?? []) {
			const tag = item.tag ?? item;
			if (!seen.has(tag)) { seen.add(tag); tags.push(tag); }
		}

		if (tags.length === 0) return;
		const tagsEl = cardEl.createDiv({ cls: "kg-card-tags" });
		for (const tag of tags.slice(0, 5)) {
			tagsEl.createSpan({ cls: "kg-tag", text: tag });
		}
	}

	// ── Utilities ──────────────────────────────────────────────────────────────

	_renderProperties(cardEl, entry) {
		// Bases UI (top right) gives us exactly the list of selected properties
		const props = this.data?.properties ?? [];

		const shown = [];
		for (const propId of props) {
			if (propId === this._cardTitlePropertyId) continue;
			// Ignore redundant title properties even if selected
			if (propId === "file.name" || propId === "file.basename" || propId === "file.fullname") continue;

			const value = entry.getValue(propId);
			if (!value) continue;
			try { if (value instanceof obsidian.NullValue) continue; } catch (_) {}
			const str = value.toString().trim();
			if (!str || str === "null") continue;

			shown.push({ propId, value });
		}

		if (shown.length === 0) return;

		const propsEl = cardEl.createDiv({ cls: "kg-card-props" });
		for (const { propId, value } of shown) {
			const rowEl = propsEl.createDiv({ cls: "kg-prop" });
			const label = this._propDisplayName(propId);
			rowEl.createSpan({ cls: "kg-prop-label", text: label });
			const valEl = rowEl.createSpan({ cls: "kg-prop-value" });
			try {
				if (this.app?.renderContext) {
					value.renderTo(valEl, this.app.renderContext);
					continue;
				}
			} catch (_) {}
			valEl.textContent = value.toString();
		}
	}

	_propDisplayName(propId) {
		try {
			const parsed = obsidian.parsePropertyId(propId);
			if (parsed?.name) return parsed.name;
		} catch (_) {}
		return propId.charAt(0).toUpperCase() + propId.slice(1);
	}

	_getFrontmatter(file) {
		return this.app?.metadataCache.getFileCache(file)?.frontmatter ?? {};
	}
}

// ─── Modals ───────────────────────────────────────────────────────────────────

class ConfirmModal extends obsidian.Modal {
	constructor(app, message, onConfirm) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "確認" });
		contentEl.createEl("p", { text: this.message });

		const btnContainer = contentEl.createDiv({ cls: "modal-button-container" });
		
		const cancelBtn = btnContainer.createEl("button", { text: "キャンセル" });
		cancelBtn.addEventListener("click", () => this.close());
		
		const confirmBtn = btnContainer.createEl("button", { text: "削除", cls: "mod-warning" });
		confirmBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

class KeepBasesViewSettingTab extends obsidian.PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Keep Bases View 設定" });

		new obsidian.Setting(containerEl)
			.setName("特定の.baseファイルパス")
			.setDesc("コマンドパレットから直接開く.baseファイルのパスを入力してください。")
			.addText(text => text
				.setPlaceholder("path/to/file.base")
				.setValue(this.plugin.settings.specificBaseFilePath || "")
				.onChange(async (value) => {
					this.plugin.settings.specificBaseFilePath = value.trim();
					await this.plugin.saveSettings();
				}));
	}
}

class BaseFileSuggester extends obsidian.FuzzySuggestModal {
	constructor(app, files) {
		super(app);
		this.files = files;
		this.setPlaceholder(".base ファイルを選択して開く");
	}

	getItems() {
		return this.files;
	}

	getItemText(item) {
		return item.path;
	}

	onChooseItem(item, evt) {
		const leaf = this.app.workspace.getLeaf(false);
		leaf.openFile(item);
	}
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

class KeepBasesViewPlugin extends obsidian.Plugin {
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new KeepBasesViewSettingTab(this.app, this));

		this.registerHoverLinkSource(HOVER_SOURCE, {
			display: "Keep Bases View",
			defaultMod: true,
		});

		this.registerBasesView(KEEP_VIEW_TYPE, {
			name: "Keep Bases View",
			icon: "layout-grid",
			factory: (controller, scrollEl) => new KeepGridView(controller, scrollEl),
			options: KeepGridView.getViewOptions,
		});

		this.addCommand({
			id: "open-base-file-suggester",
			name: "任意の.baseファイルを開く",
			callback: () => {
				const files = this.app.vault.getFiles().filter(f => f.extension === "base");
				if (files.length === 0) {
					new obsidian.Notice(".base ファイルが見つかりません。");
					return;
				}
				new BaseFileSuggester(this.app, files).open();
			}
		});

		this.addCommand({
			id: "open-specific-base-file",
			name: "特定の.baseファイルを開く",
			callback: () => {
				const path = this.settings.specificBaseFilePath?.trim();
				if (!path) {
					new obsidian.Notice("設定画面で特定の.baseファイルパスが設定されていません。");
					return;
				}
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof obsidian.TFile) {
					this.app.workspace.getLeaf(false).openFile(file);
				} else {
					new obsidian.Notice(`ファイルが見つかりません: "${path}"`);
				}
			}
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, { specificBaseFilePath: "" }, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {}
}

module.exports = KeepBasesViewPlugin;
