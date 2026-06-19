"use strict";

const obsidian = require("obsidian");

const KEEP_VIEW_TYPE = "keep-grid-view";
const HOVER_SOURCE = "keep-bases-view";
const DEBOUNCE_MS = 50;

function extractBodyMarkdownInfo(content, maxLines = 25, maxChars = 1000) {
	let body = content;
	if (body.startsWith("---")) {
		const end = body.indexOf("\n---", 3);
		if (end !== -1) body = body.slice(end + 4).trimStart();
	}
	if (!body.trim()) return { markdown: null, truncated: false };

	const lines = body.split("\n");
	const kept = lines.slice(0, maxLines).join("\n");
	const result = kept.length > maxChars ? kept.slice(0, maxChars) : kept;
	return {
		markdown: result.trim() || null,
		truncated: lines.length > maxLines || kept.length > maxChars,
	};
}

function extractBodyMarkdown(content, maxLines = 25, maxChars = 1000) {
	return extractBodyMarkdownInfo(content, maxLines, maxChars).markdown;
}

function isNullValue(value) {
	try {
		return value instanceof obsidian.NullValue;
	} catch (_) {
		return false;
	}
}

function valueToString(value) {
	if (!value || isNullValue(value)) return "";
	if (Array.isArray(value)) return value.map(valueToString).filter(Boolean).join(" ");
	return value.toString?.().trim?.() ?? "";
}

function resolveImageSrc(raw, filePath, app) {
	if (!raw) return null;
	if (/^https?:\/\//i.test(raw)) return raw;

	let linkText = raw.replace(/^!\s*/, "");
	const wiki = linkText.match(/^\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/);
	if (wiki) linkText = wiki[1].trim();
	if (!/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(linkText)) {
		linkText = linkText.split(/\s+/).find(part => /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(part)) ?? linkText;
	}

	let imgFile = app.metadataCache.getFirstLinkpathDest(linkText, filePath);
	if (!imgFile) {
		const direct = app.vault.getAbstractFileByPath(obsidian.normalizePath(linkText));
		if (direct instanceof obsidian.TFile) imgFile = direct;
	}
	return imgFile ? app.vault.getResourcePath(imgFile) : null;
}

function escapeWikiLinkPath(path) {
	return String(path ?? "").replace(/]/g, "\\]");
}

class KeepGridView extends obsidian.BasesView {
	constructor(controller, scrollEl, plugin) {
		super(controller);
		this._controller = controller;
		this.plugin = plugin;
		this.type = KEEP_VIEW_TYPE;
		this.hoverPopover = null;

		this._scrollEl = scrollEl;
		this._scrollEl.addClass("kg-container");
		this._contentEl = scrollEl.createDiv({ cls: "kg-content" });
		this._measureEl = scrollEl.createDiv({ cls: "kg-measure" });

		this._renderSignature = null;
		this._renderToken = 0;
		this._masonryRowHeight = 4;
		this._masonryGap = 8;
		this._previewQueue = [];
		this._queuedPreviewCards = new Set();
		this._activePreviewLoads = 0;
		this._maxPreviewLoads = 2;
		this._eagerPreviewCardsPerSection = 48;
		this._previewQueueLimit = 96;
		this._previewScrollTicking = false;
		this._previewProcessScheduled = false;
		this._scrollTickCount = 0;
		this._lastScrollTop = this._scrollEl.scrollTop || 0;
		this._scrollDirection = 1;
		this._trackedCards = [];
		this._visibleCards = new Set();
		this._virtual = null;
		this._virtualTicking = false;
		this._virtualOverscan = 2600;
		this._measureQueue = [];
		this._queuedMeasureKeys = new Set();
		this._activeMeasureLoads = 0;
		this._maxMeasureLoads = 2;
		this._lastLayoutWidth = 0;
		this._lastMeasuredCardWidth = 0;
		this._lastCardRects = new Map();
		this._resizeTicking = false;
		this._sections = [];
		this._isAppendingCards = false;
		this._appendScheduled = false;
		this._scrollRestoreKey = null;
		this._lastSavedScrollTop = null;
		this._localScrollTop = null;

		this._imagePropertyId = null;
		this._cardTitlePropertyId = null;
		this._cardWidthPc = 240;
		this._cardWidthTablet = 200;
		this._cardWidthMobile = 150;
		this._showTags = true;
		this._showPinned = true;
		this._imageFit = "cover";
		this._showBasePreview = true;
		this._cardMaxHeight = 320;
		this._basePreviewHeight = 150;

		this._onScroll = () => {
			if (this._previewScrollTicking) return;
			this._previewScrollTicking = true;
			requestAnimationFrame(() => {
				this._previewScrollTicking = false;
				const scrollTop = this._scrollEl.scrollTop || 0;
				this._scrollDirection = scrollTop >= this._lastScrollTop ? 1 : -1;
				this._lastScrollTop = scrollTop;
				this._saveScrollPosition(scrollTop, false);
				if (this._virtual) {
					this._renderVirtualWindow();
				} else {
					this._appendCardsNearViewport();
					this._queueVisiblePreviews();
				}
				this._scrollTickCount++;
			});
		};
		this._scrollEl.addEventListener("scroll", this._onScroll, { passive: true });

		this._previewObserver = new IntersectionObserver(entries => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					this._visibleCards.add(entry.target);
					const rootBounds = entry.rootBounds ?? this._scrollEl.getBoundingClientRect();
					const isActuallyVisible = entry.boundingClientRect.bottom >= rootBounds.top && entry.boundingClientRect.top <= rootBounds.bottom;
					this._queuePreview(entry.target, isActuallyVisible);
				} else {
					this._visibleCards.delete(entry.target);
				}
			}
		}, {
			root: this._scrollEl,
			rootMargin: "2200px 0px",
		});

		this._resizeObserver = new ResizeObserver(entries => {
			const width = this._getVirtualContentWidth();
			if (width <= 1) {
				this._lastLayoutWidth = 0;
				return;
			}
			if (Math.abs(width - this._lastLayoutWidth) < 1) return;
			this._lastLayoutWidth = width;
			this._scheduleResizeAnimation();
		});
		this._resizeObserver.observe(this._scrollEl);
		this._resizeObserver.observe(this._contentEl);

		this._debouncedRender = obsidian.debounce(() => {
			try {
				this.render();
			} catch (err) {
				console.error("[KeepBasesView] render error:", err);
			}
		}, DEBOUNCE_MS);
	}

	_perfLog(label, data = {}) {
		if (!this.plugin?.settings?.enablePerformanceLogging) return;
		console.log("[KeepBasesView perf]", label, {
			...data,
			tracked: this._trackedCards.length,
			visible: this._visibleCards.size,
			queue: this._previewQueue.length,
		});
	}

	onDataUpdated() {
		this._debouncedRender();
	}

	onClose() {
		this._clearSavedScrollPosition();
		this._debouncedRender.cancel();
		this._previewObserver.disconnect();
		this._resizeObserver.disconnect();
		this._scrollEl.removeEventListener("scroll", this._onScroll);
	}

	loadConfig() {
		const cfg = this.config;
		this._imagePropertyId = cfg?.getAsPropertyId("imageProperty") ?? null;
		this._cardTitlePropertyId = cfg?.getAsPropertyId("cardTitleProperty") ?? null;
		this._cardWidthPc = Math.max(150, Math.min(500, Number(cfg?.get("cardWidthPc") ?? 240)));
		this._cardWidthTablet = Math.max(100, Math.min(500, Number(cfg?.get("cardWidthTablet") ?? 200)));
		this._cardWidthMobile = Math.max(100, Math.min(500, Number(cfg?.get("cardWidthMobile") ?? 150)));
		this._showTags = cfg?.get("showTags") !== false;
		this._showPinned = cfg?.get("showPinned") !== false;
		this._imageFit = String(cfg?.get("imageFit") ?? "cover");
		this._showBasePreview = cfg?.get("showBasePreview") !== false;
		this._cardMaxHeight = Number(cfg?.get("cardMaxHeight") ?? 320);
		this._basePreviewHeight = Number(cfg?.get("basePreviewHeight") ?? 150);
	}

	static getViewOptions() {
		return [
			{
				displayName: "Card title property",
				type: "property",
				key: "cardTitleProperty",
				placeholder: "Default: file name",
			},
			{
				displayName: "Cover image property",
				type: "property",
				key: "imageProperty",
				placeholder: "Optional: property containing the cover image",
			},
			{
				displayName: "Image fit",
				type: "dropdown",
				key: "imageFit",
				default: "cover",
				options: { cover: "Crop to fill (Cover)", contain: "Show full image (Contain)" },
			},
			{
				displayName: "Card width - Desktop (px)",
				type: "slider",
				key: "cardWidthPc",
				default: 240,
				min: 150,
				max: 500,
				step: 5,
			},
			{
				displayName: "Card width - Tablet (px)",
				type: "slider",
				key: "cardWidthTablet",
				default: 200,
				min: 100,
				max: 500,
				step: 5,
			},
			{
				displayName: "Card width - Mobile (px)",
				type: "slider",
				key: "cardWidthMobile",
				default: 150,
				min: 100,
				max: 500,
				step: 5,
			},
			{
				displayName: "Show tags",
				type: "toggle",
				key: "showTags",
				default: true,
			},
			{
				displayName: "Pin important notes to the top",
				type: "toggle",
				key: "showPinned",
				default: true,
			},
			{
				displayName: "Preview .base file contents",
				type: "toggle",
				key: "showBasePreview",
				default: true,
			},
			{
				displayName: "Card preview max height (px)",
				type: "slider",
				key: "cardMaxHeight",
				default: 320,
				min: 120,
				max: 800,
				step: 10,
			},
			{
				displayName: ".base embed fixed height (px)",
				type: "slider",
				key: "basePreviewHeight",
				default: 150,
				min: 80,
				max: 500,
				step: 10,
			},
		];
	}

	get currentCardWidth() {
		if (this._isMobileEvenColumns()) {
			const w = this._getMobileEvenCardWidth();
			if (w > 0) return w;
		}
		if (document.body.classList.contains("is-phone")) return this._cardWidthMobile;
		if (document.body.classList.contains("is-tablet")) return this._cardWidthTablet;
		return this._cardWidthPc;
	}

	_isMobileEvenColumns() {
		if (this.plugin?.settings?.mobileEvenColumns !== true) return false;
		return document.body.classList.contains("is-phone") || document.body.classList.contains("is-mobile");
	}

	_getMobileEvenCardWidth() {
		const contentWidth = this._getVirtualContentWidth();
		if (contentWidth <= 1) return 0;
		const gap = this._masonryGap;
		// cardWidth = (contentWidth - gap) / 2
		// This makes: left padding (container) = gap, gap between cards = gap, right padding (container) = gap
		// Container padding is set via CSS variable --kg-mobile-even-padding
		return Math.max(80, Math.floor((contentWidth - gap) / 2));
	}

	render() {
		this.loadConfig();
		const entries = this.data?.data ?? [];

		const signature = this._getRenderSignature(entries);
		if (this._renderSignature === signature) return;

		const token = ++this._renderToken;
		const scrollKey = this._getScrollKey(entries);
		this._scrollRestoreKey = scrollKey;
		const savedRecord = this.plugin?._scrollPositions?.get(scrollKey);
		const savedScrollTop = savedRecord?.persist === true ? savedRecord.top : this._localScrollTop;
		if (savedRecord != null) this.plugin._scrollPositions.delete(scrollKey);
		const shouldRestoreSavedScroll = savedScrollTop != null && savedScrollTop > 0;
		const previousScrollTop = savedScrollTop ?? this._scrollEl.scrollTop;
		this._renderSignature = signature;

		this._previewObserver.disconnect();
		this._previewQueue = [];
		this._queuedPreviewCards.clear();
		this._measureQueue = [];
		this._queuedMeasureKeys.clear();
		this._activeMeasureLoads = 0;
		this._trackedCards = [];
		this._visibleCards.clear();
		this._scrollTickCount = 0;
		this._sections = [];
		this._isAppendingCards = false;
		this._appendScheduled = false;
		this._scrollEl.classList.toggle("kg-restoring-scroll", shouldRestoreSavedScroll);
		this._contentEl.empty();
		this._scrollEl.addClass("kg-no-animations");
		requestAnimationFrame(() => requestAnimationFrame(() => this._scrollEl.removeClass("kg-no-animations")));
		this._scrollEl.style.setProperty("--kg-card-width", `${this.currentCardWidth}px`);
		this._scrollEl.style.setProperty("--kg-masonry-row-height", `${this._masonryRowHeight}px`);
		this._scrollEl.style.setProperty("--kg-masonry-gap", `${this._masonryGap}px`);
		this._scrollEl.style.setProperty("--kg-card-max-height", `${this._cardMaxHeight}px`);
		this._scrollEl.style.setProperty("--kg-card-max-lines", Math.floor(this._cardMaxHeight / 19.5).toString());
		this._scrollEl.style.setProperty("--kg-base-preview-height", `${this._basePreviewHeight}px`);

		if (entries.length === 0) {
			this._scrollEl.removeClass("kg-restoring-scroll");
			this._contentEl.createDiv({ cls: "kg-empty", text: "No notes found." });
			return;
		}

		this._renderVirtual(entries, token, previousScrollTop, shouldRestoreSavedScroll);
	}

	_renderVirtual(entries, token, targetScrollTop, restoring) {
		const { pinned, normal } = this._splitEntries(entries);
		const sections = [];
		if (pinned.length > 0) sections.push({ label: "Pinned", entries: pinned });
		if (normal.length > 0) sections.push({ label: pinned.length > 0 ? "Others" : null, entries: normal });

		this._virtual = {
			token,
			sections: [],
			mounted: new Map(),
			width: 0,
			cardWidth: this.currentCardWidth,
			columnCount: 1,
		};

		for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++) {
			const sectionEl = this._contentEl.createDiv({ cls: "kg-section kg-virtual-section" });
			if (sections[sectionIndex].label) sectionEl.createDiv({ cls: "kg-section-label", text: sections[sectionIndex].label });
			const gridEl = sectionEl.createDiv({ cls: "kg-virtual-grid" });
			this._virtual.sections.push({
				id: sectionIndex,
				entries: sections[sectionIndex].entries,
				sectionEl,
				gridEl,
				items: [],
				height: 0,
			});
		}

		this._layoutVirtualSections();
		this._scrollEl.scrollTop = Math.min(targetScrollTop || 0, Math.max(0, this._scrollEl.scrollHeight - this._scrollEl.clientHeight));
		this._renderVirtualWindow();
		this._scheduleVirtualRelayoutChecks();
		if (restoring) requestAnimationFrame(() => this._scrollEl.removeClass("kg-restoring-scroll"));
		else this._scrollEl.removeClass("kg-restoring-scroll");
	}

	_layoutVirtualSections() {
		if (!this._virtual) return;
		const contentWidth = this._getVirtualContentWidth();
		if (contentWidth <= 1) {
			this._scrollEl.addClass("kg-layout-pending");
			return;
		}
		const gap = this._masonryGap;
		const mobileEven = this._isMobileEvenColumns();
		let cardWidth, columnCount;
		if (mobileEven) {
			columnCount = 2;
			cardWidth = Math.max(80, Math.floor((contentWidth - gap) / 2));
			const scrollbarW = this._scrollEl.offsetWidth - this._scrollEl.clientWidth;
			this._scrollEl.style.setProperty("--kg-scrollbar-width", `${scrollbarW}px`);
			this._scrollEl.classList.add("kg-mobile-even");
		} else {
			cardWidth = Math.max(1, Math.min(this.currentCardWidth, contentWidth));
			columnCount = Math.max(1, Math.floor((contentWidth + gap - 1) / (cardWidth + gap)));
			this._scrollEl.classList.remove("kg-mobile-even");
		}
		const shouldHideUntilPositioned = this._virtual.columnCount <= 1 && columnCount > 1;
		if (shouldHideUntilPositioned) this._scrollEl.addClass("kg-layout-pending");
		this._virtual.width = contentWidth;
		this._virtual.cardWidth = cardWidth;
		this._virtual.columnCount = columnCount;
		this._scrollEl.style.setProperty("--kg-card-width", `${cardWidth}px`);

		for (const section of this._virtual.sections) {
			const columns = Array.from({ length: columnCount }, () => 0);
			section.items = section.entries.map((entry, index) => {
				const fm = entry._cachedFm ?? {};
				const cache = entry._cachedCache ?? {};
				const cachedHeight = this._getCachedVirtualHeight(entry);
				const height = cachedHeight ?? this._estimateCardHeight(entry, fm, cache);
				let column = 0;
				for (let i = 1; i < columns.length; i++) {
					if (columns[i] < columns[column]) column = i;
				}
				const x = column * (cardWidth + gap);
				const y = columns[column];
				columns[column] += height + gap;
				return { entry, fm, cache, index, key: `${section.id}:${entry.file.path}`, x, y, height, measured: cachedHeight != null, column, mountedEl: null };
			});

			section.height = Math.max(0, ...columns) || 0;
			if (section.height > 0) section.height -= gap;
			section.gridEl.style.height = `${section.height}px`;
			section.gridEl.style.setProperty("--kg-card-width", `${cardWidth}px`);
			for (const item of section.items) {
				if (item.mountedEl?.isConnected) this._positionVirtualCard(item.mountedEl, item);
			}
		}
		this._scrollEl.removeClass("kg-layout-pending");
	}

	_getVirtualContentWidth() {
		const rectWidth = this._contentEl?.getBoundingClientRect?.().width ?? 0;
		const clientWidth = this._contentEl?.clientWidth ?? 0;
		const contentWidth = Math.max(rectWidth, clientWidth);
		if (contentWidth > 1) return contentWidth;

		const styles = window.getComputedStyle(this._scrollEl);
		const paddingLeft = parseFloat(styles.paddingLeft) || 0;
		const paddingRight = parseFloat(styles.paddingRight) || 0;
		const scrollClientWidth = this._scrollEl?.clientWidth ?? 0;
		const fallbackWidth = scrollClientWidth - paddingLeft - paddingRight;
		return fallbackWidth > 1 ? fallbackWidth : 0;
	}

	_ensureVirtualLayoutFresh() {
		if (!this._virtual) return;
		const width = this._getVirtualContentWidth();
		if (width <= 1) return;
		const gap = this._masonryGap;
		let cardWidth, columnCount;
		if (this._isMobileEvenColumns()) {
			columnCount = 2;
			cardWidth = Math.max(80, Math.floor((width - gap) / 2));
		} else {
			cardWidth = Math.max(1, Math.min(this.currentCardWidth, width));
			columnCount = Math.max(1, Math.floor((width + gap - 1) / (cardWidth + gap)));
		}
		const wasSingleColumn = this._virtual.columnCount <= 1 && columnCount > 1;
		if (wasSingleColumn || Math.abs(width - this._virtual.width) > 1 || Math.abs(cardWidth - this._virtual.cardWidth) > 1) {
			this._layoutVirtualSections();
		}
	}

	_scheduleVirtualRelayoutChecks() {
		const token = this._renderToken;
		const check = () => {
			if (this._renderToken !== token || !this._virtual) return;
			this._ensureVirtualLayoutFresh();
			this._renderVirtualWindow();
		};
		queueMicrotask(check);
		requestAnimationFrame(check);
		setTimeout(check, 80);
		setTimeout(check, 300);
	}

	_renderVirtualWindow() {
		if (!this._virtual || this._renderToken !== this._virtual.token) return;
		this._ensureVirtualLayoutFresh();
		const rootTop = this._scrollEl.scrollTop;
		const rootBottom = rootTop + this._scrollEl.clientHeight;
		const overscan = this._virtualOverscan;
		const keep = new Set();
		const priorityCards = [];

		for (const section of this._virtual.sections) {
			const sectionTop = section.gridEl.offsetTop;
			const minY = rootTop - overscan - sectionTop;
			const maxY = rootBottom + overscan - sectionTop;

			for (const item of section.items) {
				if (item.y > maxY || item.y + item.height < minY) continue;
				keep.add(item.key);
				const cardTop = sectionTop + item.y;
				const actuallyVisible = cardTop + item.height >= rootTop && cardTop <= rootBottom;
				if (!item.measured) {
					if (item.entry.file.extension !== "base" || actuallyVisible) this._queueVirtualMeasure(item, actuallyVisible);
					continue;
				}

				let cardEl = this._virtual.mounted.get(item.key);
				if (!cardEl) {
					cardEl = this._mountVirtualCard(section, item);
				} else {
					cardEl._kgVirtualItem = item;
					item.mountedEl = cardEl;
					this._positionVirtualCard(cardEl, item);
				}

				if (actuallyVisible) priorityCards.push(cardEl);
				else if (item.entry.file.extension !== "base") this._queuePreview(cardEl, false);
			}
		}

		for (const [key, cardEl] of this._virtual.mounted) {
			if (keep.has(key)) continue;
			this._queuedPreviewCards.delete(cardEl);
			this._previewQueue = this._previewQueue.filter(item => item !== cardEl);
			cardEl.remove();
			this._virtual.mounted.delete(key);
		}

		this._trackedCards = [...this._virtual.mounted.values()];
		for (const cardEl of priorityCards) this._queuePreview(cardEl, true);
	}

	_mountVirtualCard(section, item) {
		const cardEl = this._createCard(item.entry, item.fm, item.cache);
		cardEl.addClass("kg-virtual-card");
		cardEl._kgVirtualItem = item;
		cardEl._kgPreviewLoaded = false;
		cardEl._kgNeedsMarkdownUpgrade = true;
		cardEl.style.setProperty("--kg-preview-lines", String(this._getVirtualPreviewLines()));
		this._positionVirtualCard(cardEl, item);
		section.gridEl.appendChild(cardEl);
		this._virtual.mounted.set(item.key, cardEl);
		item.mountedEl = cardEl;
		this._queuePreview(cardEl, true);
		return cardEl;
	}

	_queueVirtualMeasure(item, priority = false) {
		if (!this._virtual || item.measured || item.measuring || this._queuedMeasureKeys.has(item.key)) return;
		this._queuedMeasureKeys.add(item.key);
		const task = { item, token: this._renderToken };
		if (priority) this._measureQueue.unshift(task);
		else this._measureQueue.push(task);
		this._processMeasureQueue();
	}

	_processMeasureQueue() {
		while (this._activeMeasureLoads < this._maxMeasureLoads && this._measureQueue.length > 0) {
			const task = this._measureQueue.shift();
			const { item, token } = task;
			if (!this._virtual || token !== this._renderToken || item.measured || item.measuring) {
				this._queuedMeasureKeys.delete(item.key);
				continue;
			}

			item.measuring = true;
			this._activeMeasureLoads++;
			void this._measureVirtualItem(task)
				.finally(() => {
					item.measuring = false;
					this._queuedMeasureKeys.delete(item.key);
					this._activeMeasureLoads = Math.max(0, this._activeMeasureLoads - 1);
					if (token === this._renderToken) this._processMeasureQueue();
				});
		}
	}

	async _measureVirtualItem({ item, token }) {
		if (!this._virtual || token !== this._renderToken) return;
		const cardEl = this._createCard(item.entry, item.fm, item.cache);
		cardEl.addClass("kg-virtual-measuring");
		cardEl._kgVirtualItem = item;
		cardEl.style.width = `${this._virtual.cardWidth}px`;
		cardEl.style.height = "auto";
		cardEl.style.transform = "none";
		cardEl.style.setProperty("--kg-preview-lines", String(this._getVirtualPreviewLines()));
		this._measureEl.style.width = `${this._virtual.cardWidth}px`;
		this._measureEl.appendChild(cardEl);

		try {
			const hasPreview = await this._loadCardBody(cardEl, token, { mode: "upgrade" });
			if (token !== this._renderToken) return;
			if (!hasPreview) {
				cardEl.addClass("kg-no-preview");
				cardEl._keepBodyEl?.remove();
				cardEl._keepBodyEl = null;
			}
			this._updateBodyFade(cardEl);
			if (item.entry.file.extension === "base" || cardEl.querySelector("img")) {
				await this._waitForVirtualMeasurePaint();
				if (token !== this._renderToken) return;
			}
			const measured = this._measureTightCardHeight(cardEl);
			if (!Number.isFinite(measured) || measured <= 0) return;
			item.height = measured;
			item.measured = true;
			this._setCachedVirtualHeight(item.entry, measured);
			this._layoutVirtualSections();
			this._renderVirtualWindow();
		} finally {
			cardEl.remove();
		}
	}

	_waitForVirtualMeasurePaint() {
		return new Promise(resolve => {
			requestAnimationFrame(() => requestAnimationFrame(resolve));
		});
	}

	_measureTightCardHeight(cardEl) {
		const rect = cardEl.getBoundingClientRect();
		const style = getComputedStyle(cardEl);
		const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
		const borderBottom = Number.parseFloat(style.borderBottomWidth) || 0;
		let bottom = 0;

		for (const child of Array.from(cardEl.children)) {
			if (child.matches?.(".kg-pin-btn, .kg-card-actions")) continue;
			const childStyle = getComputedStyle(child);
			if (childStyle.position === "absolute" || childStyle.position === "fixed") continue;
			const childRect = child.getBoundingClientRect();
			bottom = Math.max(bottom, childRect.bottom - rect.top);
		}

		if (bottom <= 0) return Math.ceil(rect.height);
		return Math.ceil(bottom + paddingBottom + borderBottom);
	}

	_getVirtualPreviewLines() {
		return Math.max(1, Math.floor(this._cardMaxHeight / 19.5));
	}

	_positionVirtualCard(cardEl, item) {
		const width = `${this._virtual.cardWidth}px`;
		const height = `${Math.max(1, Math.ceil(item.height))}px`;
		const transform = `translate3d(${Math.round(item.x)}px, ${Math.round(item.y)}px, 0)`;
		const widthChanged = cardEl._kgVirtualWidth !== width;
		if (widthChanged) {
			cardEl._kgVirtualWidth = width;
			cardEl.style.width = width;
		}
		if (widthChanged || !cardEl._kgVirtualHeight) {
			cardEl._kgVirtualHeight = height;
			cardEl.style.height = height;
		}
		if (cardEl._kgVirtualTransform !== transform) {
			// Cancel any in-progress reflow animation so the new position takes effect immediately
			if (cardEl._kgReflowAnimation) {
				cardEl._kgReflowAnimation.cancel();
				cardEl._kgReflowAnimation = null;
			}
			cardEl._kgVirtualTransform = transform;
			cardEl.style.transform = transform;
		}
	}

	_onVirtualPreviewReady(cardEl) {
		const item = cardEl?._kgVirtualItem;
		if (!item || !this._virtual || !cardEl.isConnected) return;
		this._updateBodyFade(cardEl);
	}

	_getVirtualHeightKey(entry) {
		return [
			entry.file?.path,
			entry.file?.stat?.mtime ?? 0,
			this.currentCardWidth,
			this._cardMaxHeight,
			this._basePreviewHeight,
			this._showTags,
			this._imagePropertyId ?? "",
			this._cardTitlePropertyId ?? "",
			(this.data?.properties ?? []).join(","),
			this._getVirtualPreviewLines(),
			"fixed-before-mount-v4",
		].join("\u001f");
	}

	_getCachedVirtualHeight(entry) {
		return this.plugin?._cardHeightCache?.get(this._getVirtualHeightKey(entry));
	}

	_setCachedVirtualHeight(entry, height) {
		const cache = this.plugin?._cardHeightCache;
		if (!cache) return;
		cache.set(this._getVirtualHeightKey(entry), height);
		if (cache.size > 1000) {
			const firstKey = cache.keys().next().value;
			if (firstKey) cache.delete(firstKey);
		}
	}

	_estimateCardHeight(entry, fm, cache) {
		const title = this._cardTitlePropertyId ? valueToString(entry.getValue(this._cardTitlePropertyId)) : entry.file.basename;
		const titleLines = Math.max(1, Math.min(3, Math.ceil((title.length || 12) / 24)));
		let height = 24 + titleLines * 20;

		if (this._imagePropertyId && valueToString(entry.getValue(this._imagePropertyId))) height += 145;

		const props = this.data?.properties ?? [];
		let propCount = 0;
		for (const propId of props) {
			if (propId === this._cardTitlePropertyId) continue;
			if (propId === "file.name" || propId === "file.basename" || propId === "file.fullname") continue;
			if (valueToString(entry.getValue(propId))) propCount++;
		}
		if (propCount > 0) height += 12 + Math.min(4, propCount) * 20;

		if (entry.file.extension === "base" && this._showBasePreview) height += this._basePreviewHeight + 8;
		else if (entry.file.extension === "md" || entry.file.extension === "txt") height += Math.min(this._cardMaxHeight, 145);

		const fmTags = fm?.tags ?? fm?.tag ?? [];
		const tagCount = (Array.isArray(fmTags) ? fmTags.length : typeof fmTags === "string" && fmTags ? 1 : 0) + (cache?.tags?.length ?? 0);
		if (this._showTags && tagCount > 0) height += tagCount > 2 ? 48 : 26;

		return Math.max(54, Math.min(height, this._cardMaxHeight + 230));
	}

	_splitEntries(entries) {
		const pinned = [];
		const normal = [];

		for (const entry of entries) {
			const cache = this.app?.metadataCache.getFileCache(entry.file) ?? {};
			const fm = cache.frontmatter ?? {};
			entry._cachedFm = fm;
			entry._cachedCache = cache;

			if (this._showPinned && (fm.keep_pinned === true || fm.keep_pinned === "true")) {
				pinned.push(entry);
			} else {
				normal.push(entry);
			}
		}

		return { pinned, normal };
	}

	_renderSection(label, entries, token) {
		const sectionEl = this._contentEl.createDiv({ cls: "kg-section" });
		if (label) sectionEl.createDiv({ cls: "kg-section-label", text: label });
		const gridEl = sectionEl.createDiv({ cls: "kg-grid" });
		const section = { entries, gridEl, rendered: 0, token };
		this._sections.push(section);

		return this._appendCardsToSection(section, label ? 18 : 48);
	}

	async _appendCardsToSection(section, count) {
		if (!section || this._renderToken !== section.token) return 0;
		const t0 = performance.now();
		const end = Math.min(section.entries.length, section.rendered + count);

		for (let i = section.rendered; i < end; i++) {
			const entry = section.entries[i];
			if (this._renderToken !== section.token) return 0;
			const cardEl = this._createCard(entry, entry._cachedFm, entry._cachedCache);
			const mode = i < this._eagerPreviewCardsPerSection ? "layout" : "shell";
			const isReady = await this._prepareCardForDisplay(cardEl, section.gridEl, section.token, { mode });
			if (!isReady) return 0;
			section.gridEl.appendChild(cardEl);
			this._trackedCards.push(cardEl);
			this._previewObserver.observe(cardEl);
		}

		const appended = end - section.rendered;
		section.rendered = end;
		if (appended > 0) requestAnimationFrame(() => this._rememberCardRects());
		const elapsed = performance.now() - t0;
		if (elapsed > 16) this._perfLog("appendCards", { appended, elapsed: Math.round(elapsed), requested: count });
		return appended;
	}

	_appendCardsNearViewport() {
		if (this._isAppendingCards || this._appendScheduled) return;
		const remaining = this._sections.some(section => section.rendered < section.entries.length);
		if (!remaining) return;

		const distanceToBottom = this._scrollEl.scrollHeight - this._scrollEl.scrollTop - this._scrollEl.clientHeight;
		if (distanceToBottom > this._scrollEl.clientHeight * 6) return;

		this._appendScheduled = true;
		this._scheduleIdle(() => this._appendNextCardChunk());
	}

	async _appendNextCardChunk() {
		this._appendScheduled = false;
		this._isAppendingCards = true;
		try {
			let appended = 0;
			for (const section of this._sections) {
				if (section.rendered >= section.entries.length) continue;
				appended += await this._appendCardsToSection(section, 12);
				if (appended >= 24) break;
			}
			} finally {
				this._isAppendingCards = false;
			}

		const distanceToBottom = this._scrollEl.scrollHeight - this._scrollEl.scrollTop - this._scrollEl.clientHeight;
		if (distanceToBottom < this._scrollEl.clientHeight * 5) {
			this._appendCardsNearViewport();
		}
	}

	async _restoreScrollPosition(token, targetScrollTop) {
		try {
			const targetBottom = targetScrollTop + this._scrollEl.clientHeight;
			let guard = 0;

			while (
				this._renderToken === token &&
				this._scrollEl.scrollHeight < targetBottom &&
				this._sections.some(section => section.rendered < section.entries.length) &&
				guard < 200
			) {
				let appended = 0;
				for (const section of this._sections) {
					if (section.rendered >= section.entries.length) continue;
					appended += await this._appendCardsToSection(section, 18);
					if (appended >= 36) break;
				}
				if (appended === 0) break;
				guard++;
			}

			if (this._renderToken !== token) return;
			const maxScrollTop = Math.max(0, this._scrollEl.scrollHeight - this._scrollEl.clientHeight);
			this._scrollEl.scrollTop = Math.min(targetScrollTop, maxScrollTop);
			this._queueVisiblePreviews();
			this._appendCardsNearViewport();
		} finally {
			if (this._renderToken === token) this._scrollEl.removeClass("kg-restoring-scroll");
		}
	}

	_scheduleIdle(callback) {
		if (typeof window.requestIdleCallback === "function") {
			window.requestIdleCallback(callback, { timeout: 30 });
		} else {
			setTimeout(callback, 16);
		}
	}

	async _prepareCardForDisplay(cardEl, gridEl, token, options = {}) {
		cardEl.style.setProperty("--kg-preview-lines", String(Math.max(1, Math.floor(this._cardMaxHeight / 19.5))));
		const mode = options.mode ?? "layout";
		const hasPreview = await this._loadCardBody(cardEl, token, { mode });
		if (this._renderToken !== token) return false;
		cardEl._kgPreviewLoaded = mode !== "shell";
		if (!hasPreview) {
			cardEl.addClass("kg-no-preview");
			cardEl.style.setProperty("--kg-preview-lines", "0");
			cardEl._keepBodyEl?.remove();
			cardEl._keepBodyEl = null;
		}

		const width = this._getGridColumnWidth(gridEl);
		this._measureEl.style.width = `${width}px`;
		cardEl.style.width = `${width}px`;
		this._measureEl.appendChild(cardEl);
		this._updateBodyFade(cardEl);

		const height = cardEl.getBoundingClientRect().height;
		const span = Math.max(1, Math.ceil((height + this._masonryGap) / (this._masonryRowHeight + this._masonryGap)));
		cardEl._kgGridSpan = span;
		cardEl.style.gridRowEnd = `span ${span}`;
		cardEl.style.width = "";
		return true;
	}

	_updateCardSpan(cardEl) {
		const firstRects = this._captureCardRects();
		const changed = this._recalculateCardSpan(cardEl);
		if (changed) {
			this._animateCardMoves(firstRects);
			requestAnimationFrame(() => this._rememberCardRects());
		}
	}

	_recalculateCardSpan(cardEl) {
		const gridEl = cardEl?.closest?.(".kg-grid");
		if (!gridEl || !this._measureEl) return false;

		const width = this._getGridColumnWidth(gridEl);
		this._lastMeasuredCardWidth = width;
		this._measureEl.style.width = `${width}px`;
		const clone = cardEl.cloneNode(true);
		clone.style.width = `${width}px`;
		clone.style.height = "auto";
		clone.style.gridRowEnd = "";
		this._measureEl.appendChild(clone);
		const height = clone.getBoundingClientRect().height;
		clone.remove();

		const span = Math.max(1, Math.ceil((height + this._masonryGap) / (this._masonryRowHeight + this._masonryGap)));
		if (span !== cardEl._kgGridSpan) {
			cardEl._kgGridSpan = span;
			cardEl.style.gridRowEnd = `span ${span}`;
			return true;
		}
		return false;
	}

	_getGridColumnWidth(gridEl) {
		const gridWidth = gridEl.clientWidth || this._contentEl.clientWidth || this._scrollEl.clientWidth || this.currentCardWidth;
		return Math.max(1, Math.min(this.currentCardWidth, gridWidth));
	}

	_scheduleResizeAnimation() {
		if (this._resizeTicking) return;
		this._resizeTicking = true;
		requestAnimationFrame(() => {
			this._resizeTicking = false;
			this._animateResizeLayout();
		});
	}

	_animateResizeLayout() {
		const t0 = performance.now();
		if (this._virtual) {
			this._scrollEl.style.setProperty("--kg-card-width", `${this.currentCardWidth}px`);
			const animEnabled = this.plugin?.settings?.enableAnimation !== false;

			if (animEnabled) {
				// Step 1: Capture each card's current logical position (= last layout target)
				// Using _kgVirtualTransform avoids reading mid-animation style.transform values.
				const oldTransforms = new Map();
				for (const [, cardEl] of this._virtual.mounted) {
					if (!cardEl.isConnected) continue;
					oldTransforms.set(cardEl, cardEl._kgVirtualTransform ?? cardEl.style.transform);
				}

				// Step 2: Apply new layout (updates _kgVirtualTransform + style.transform for all cards)
				this._layoutVirtualSections();
				this._renderVirtualWindow();

				// Step 3: For each card whose position changed, start a Web Animation.
				// Web Animations API is atomic: no rAF gap, no CSS transition timing issues.
				for (const [cardEl, oldTransform] of oldTransforms) {
					if (!cardEl.isConnected) continue;
					const newTransform = cardEl._kgVirtualTransform ?? cardEl.style.transform;
					if (oldTransform === newTransform) continue;

					// Cancel previous animation (if column count changed twice rapidly)
					cardEl._kgReflowAnimation?.cancel();

					// Animate from old logical position to new logical position
					const anim = cardEl.animate(
						[{ transform: oldTransform }, { transform: newTransform }],
						{ duration: 220, easing: "ease", fill: "none" }
					);
					cardEl._kgReflowAnimation = anim;
					const done = () => { if (cardEl._kgReflowAnimation === anim) cardEl._kgReflowAnimation = null; };
					anim.onfinish = done;
					anim.oncancel = done;
				}
			} else {
				this._layoutVirtualSections();
				this._renderVirtualWindow();
			}

			const elapsed = performance.now() - t0;
			if (elapsed > 16) this._perfLog("resizeLayout", { elapsed: Math.round(elapsed), virtual: true });
			return;
		}
		if (!this._trackedCards.length) return;
		this._scrollEl.style.setProperty("--kg-card-width", `${this.currentCardWidth}px`);

		const gridEl = this._contentEl.querySelector(".kg-grid");
		const nextCardWidth = gridEl ? this._getGridColumnWidth(gridEl) : this.currentCardWidth;
		const widthChanged = Math.abs(nextCardWidth - this._lastMeasuredCardWidth) > 1;
		const visibleCards = this._getVisibleTrackedCards();
		if (!widthChanged && visibleCards.length === 0) {
			this._lastCardRects = new Map();
			return;
		}

		const firstRects = this._getRememberedRectsForCards(visibleCards);

		if (widthChanged) {
			for (const cardEl of visibleCards) {
				this._recalculateCardSpan(cardEl);
			}
			this._lastMeasuredCardWidth = nextCardWidth;
		}

		if (firstRects?.size) this._animateCardMoves(firstRects);
		if (visibleCards.length > 0) requestAnimationFrame(() => this._rememberCardRects());
		const elapsed = performance.now() - t0;
		if (elapsed > 16) this._perfLog("resizeLayout", { elapsed: Math.round(elapsed), widthChanged });
	}

	_getVisibleTrackedCards() {
		const cards = [];
		const source = this._visibleCards?.size ? this._visibleCards : [];
		for (const cardEl of source) {
			if (!cardEl.isConnected) continue;
			cards.push(cardEl);
		}
		return cards;
	}

	_captureCardRects(cards = this._getVisibleTrackedCards()) {
		if (this.plugin?.settings?.enableAnimation === false) return null;
		const rects = new Map();
		for (const cardEl of cards) {
			if (!cardEl.isConnected) continue;
			rects.set(cardEl, cardEl.getBoundingClientRect());
		}
		return rects;
	}

	_getRememberedRectsForCards(cards) {
		if (this.plugin?.settings?.enableAnimation === false || !cards?.length) return null;
		const remembered = this._lastCardRects;
		if (!remembered?.size) return null;

		const rects = new Map();
		for (const cardEl of cards) {
			const rect = remembered.get(cardEl);
			if (rect) rects.set(cardEl, rect);
		}
		return rects.size ? rects : null;
	}

	_rememberCardRects() {
		if (this.plugin?.settings?.enableAnimation === false) {
			this._lastCardRects = new Map();
			return;
		}
		this._lastCardRects = this._captureCardRects(this._getVisibleTrackedCards()) ?? new Map();
	}

	_animateCardMoves(firstRects) {
		if (!firstRects || this.plugin?.settings?.enableAnimation === false) return;

		const moves = [];
		for (const cardEl of firstRects.keys()) {
			const first = firstRects.get(cardEl);
			if (!first || !cardEl.isConnected) continue;
			const last = cardEl.getBoundingClientRect();
			const dx = first.left - last.left;
			const dy = first.top - last.top;
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
			moves.push({ cardEl, dx, dy });
		}
		if (moves.length === 0) return;

		for (const { cardEl, dx, dy } of moves) {
			cardEl.style.transition = "none";
			cardEl.style.transform = `translate(${dx}px, ${dy}px)`;
		}
		for (const { cardEl } of moves) {
			cardEl.getBoundingClientRect();
		}

		requestAnimationFrame(() => {
			for (const { cardEl } of moves) {
				if (!cardEl.isConnected) continue;
				cardEl.style.transition = "";
				cardEl.style.transform = "";
			}
		});
	}

	_queueVisiblePreviews() {
		const rootRect = this._scrollEl.getBoundingClientRect();
		const cards = this._visibleCards?.size ? [...this._visibleCards] : [];
		cards.sort((a, b) => {
			const scoreA = this._getPreviewQueueScore(a, rootRect);
			const scoreB = this._getPreviewQueueScore(b, rootRect);
			return scoreA.group - scoreB.group || scoreA.distance - scoreB.distance || scoreA.top - scoreB.top || scoreA.left - scoreB.left;
		});

		for (let i = 0, len = cards.length; i < len; i++) {
			const cardEl = cards[i];
			if (!cardEl.isConnected) continue;
			if ((cardEl._kgPreviewLoaded && !cardEl._kgNeedsMarkdownUpgrade) || cardEl._kgPreviewLoading) continue;
			const rect = cardEl.getBoundingClientRect();
			const isVisible = rect.bottom >= rootRect.top && rect.top <= rootRect.bottom;
			this._queuePreview(cardEl, isVisible);
		}
	}

	_queuePreview(cardEl, priority = false) {
		if (!cardEl || (cardEl._kgPreviewLoaded && !cardEl._kgNeedsMarkdownUpgrade) || cardEl._kgPreviewLoading || this._queuedPreviewCards.has(cardEl)) return;
		this._queuedPreviewCards.add(cardEl);
		this._previewQueue.push(cardEl);
		if (priority) this._processPreviewQueue();
		else this._schedulePreviewProcessing();
	}

	_schedulePreviewProcessing() {
		if (this._previewProcessScheduled) return;
		this._previewProcessScheduled = true;
		this._scheduleIdle(() => {
			this._previewProcessScheduled = false;
			this._processPreviewQueue();
		});
	}

	_processPreviewQueue() {
		this._refreshPreviewQueue();
		while (this._activePreviewLoads < this._maxPreviewLoads && this._previewQueue.length > 0) {
			const cardEl = this._previewQueue.shift();
			this._queuedPreviewCards.delete(cardEl);
			if (!cardEl?.isConnected || (cardEl._kgPreviewLoaded && !cardEl._kgNeedsMarkdownUpgrade) || cardEl._kgPreviewLoading) continue;

			const token = this._renderToken;
			cardEl._kgPreviewLoading = true;
			this._activePreviewLoads++;
			void this._loadCardBody(cardEl, token, { mode: "upgrade" })
				.then(hasPreview => {
					if (token === this._renderToken && !hasPreview) {
						cardEl.addClass("kg-no-preview");
						cardEl._kgNeedsMarkdownUpgrade = false;
						cardEl._keepBodyEl?.remove();
						cardEl._keepBodyEl = null;
						if (this._virtual) this._onVirtualPreviewReady(cardEl);
					} else if (token === this._renderToken) {
						cardEl._kgNeedsMarkdownUpgrade = false;
						this._updateBodyFade(cardEl);
						if (this._virtual) this._onVirtualPreviewReady(cardEl);
						else this._updateCardSpan(cardEl);
					}
				})
				.finally(() => {
					cardEl._kgPreviewLoading = false;
					this._activePreviewLoads = Math.max(0, this._activePreviewLoads - 1);
					if (token === this._renderToken) {
						cardEl._kgPreviewLoaded = true;
					}
					this._processPreviewQueue();
				});
		}
	}

	_refreshPreviewQueue() {
		if (this._previewQueue.length <= 1) return;
		const rootRect = this._scrollEl.getBoundingClientRect();
		const seen = new Set();
		const cards = [];
		for (const cardEl of this._previewQueue) {
			if (!cardEl?.isConnected || seen.has(cardEl)) continue;
			if ((cardEl._kgPreviewLoaded && !cardEl._kgNeedsMarkdownUpgrade) || cardEl._kgPreviewLoading) continue;
			const score = this._getPreviewQueueScore(cardEl, rootRect);
			if (score.group >= 3) continue;
			seen.add(cardEl);
			cards.push({ cardEl, score });
		}

		cards.sort((a, b) => {
			const scoreA = a.score;
			const scoreB = b.score;
			return scoreA.group - scoreB.group || scoreA.distance - scoreB.distance || scoreA.top - scoreB.top || scoreA.left - scoreB.left;
		});

		this._previewQueue = cards.slice(0, this._previewQueueLimit).map(item => item.cardEl);
		this._queuedPreviewCards = new Set(this._previewQueue);
	}

	_getPreviewQueueScore(cardEl, rootRect = this._scrollEl.getBoundingClientRect()) {
		if (this._virtual && cardEl?._kgVirtualItem) {
			const item = cardEl._kgVirtualItem;
			const sectionTop = cardEl.parentElement?.offsetTop ?? 0;
			const topAbs = sectionTop + item.y;
			const bottomAbs = topAbs + item.height;
			const rootTopAbs = this._scrollEl.scrollTop;
			const rootBottomAbs = rootTopAbs + this._scrollEl.clientHeight;
			const margin = this._virtualOverscan;
			const isVisible = bottomAbs >= rootTopAbs && topAbs <= rootBottomAbs;
			if (isVisible) {
				return {
					group: 0,
					distance: 0,
					top: topAbs,
					left: item.x,
				};
			}

			const isBelow = topAbs > rootBottomAbs;
			const distance = isBelow ? topAbs - rootBottomAbs : rootTopAbs - bottomAbs;
			if (distance > margin) return { group: 3, distance, top: topAbs, left: item.x };
			const directionGroup = this._scrollDirection >= 0
				? (isBelow ? 1 : 2)
				: (isBelow ? 2 : 1);
			return { group: directionGroup, distance, top: topAbs, left: item.x };
		}

		const rect = cardEl.getBoundingClientRect();
		const rootTop = rootRect.top;
		const rootBottom = rootRect.bottom;
		const margin = 2200;
		const isVisible = rect.bottom >= rootTop && rect.top <= rootBottom;
		if (isVisible) {
			return {
				group: 0,
				distance: 0,
				top: Math.max(rect.top, rootTop),
				left: rect.left,
			};
		}

		const isBelow = rect.top > rootBottom;
		const distance = isBelow ? rect.top - rootBottom : rootTop - rect.bottom;
		if (distance > margin) {
			return { group: 3, distance, top: rect.top, left: rect.left };
		}

		const directionGroup = this._scrollDirection >= 0
			? (isBelow ? 1 : 2)
			: (isBelow ? 2 : 1);
		return {
			group: directionGroup,
			distance,
			top: rect.top,
			left: rect.left,
		};
	}

	_getRenderSignature(entries) {
		const config = [
			this._imagePropertyId,
			this._cardTitlePropertyId,
			this._cardWidthPc,
			this._cardWidthTablet,
			this._cardWidthMobile,
			this._showTags,
			this._showPinned,
			this._imageFit,
			this._showBasePreview,
			this._cardMaxHeight,
			this._basePreviewHeight,
			...(this.data?.properties ?? []),
		];

		const entrySig = entries.map(entry => {
			const cache = this.app?.metadataCache.getFileCache(entry.file) ?? {};
			const fm = cache.frontmatter ?? {};
			return [
				entry.file?.path,
				entry.file?.stat?.mtime,
				fm.keep_pinned,
				fm.keep_color,
				this._imagePropertyId ? valueToString(entry.getValue(this._imagePropertyId)) : "",
				this._cardTitlePropertyId ? valueToString(entry.getValue(this._cardTitlePropertyId)) : "",
			].join("\u001f");
		});

		return JSON.stringify({ config, entries: entrySig });
	}

	_getScrollKey(entries) {
		const candidates = [
			this._controller?.file?.path,
			this._controller?.sourceFile?.path,
			this._controller?.view?.file?.path,
			this.data?.file?.path,
			this.data?.sourceFile?.path,
			this.data?.path,
		];
		const directKey = candidates.find(value => typeof value === "string" && value.length > 0);
		if (directKey) return `file:${directKey}`;

		const paths = entries
			.map(entry => entry.file?.path)
			.filter(Boolean)
			.slice(0, 200);
		return `entries:${entries.length}:${paths.join("\u001f")}`;
	}

	_saveScrollPosition(scrollTop = null, persist = false) {
		const nextScrollTop = scrollTop ?? this._scrollEl.scrollTop ?? 0;
		if (this._lastSavedScrollTop !== nextScrollTop) {
			this._lastSavedScrollTop = nextScrollTop;
			this._localScrollTop = nextScrollTop;
		}
		if (!persist || !this.plugin?._scrollPositions) return;
		const key = this._scrollRestoreKey ?? this._getScrollKey(this.data?.data ?? []);
		this.plugin._scrollPositions.set(key, { top: nextScrollTop, persist: true });
	}

	_clearSavedScrollPosition() {
		if (!this.plugin?._scrollPositions) return;
		const key = this._scrollRestoreKey ?? this._getScrollKey(this.data?.data ?? []);
		this.plugin._scrollPositions.delete(key);
		this._lastSavedScrollTop = null;
	}

	_createCard(entry, fm, cache) {
		const file = entry.file;
		const cardEl = document.createElement("div");
		cardEl.className = "kg-card";
		cardEl.setAttribute("data-path", file.path);
		if (fm?.keep_color) cardEl.dataset.keepColor = fm.keep_color;

		const isPinned = fm?.keep_pinned === true || fm?.keep_pinned === "true";
		if (obsidian.Platform.isMobile && isPinned) {
			const pinEl = cardEl.createDiv({ cls: "kg-card-pin" });
			obsidian.setIcon(pinEl, "pin");
		}

		if (this._imagePropertyId) this._renderCover(cardEl, entry, file.path);

		const titleEl = cardEl.createDiv({ cls: "kg-card-title" });
		this._renderTitle(titleEl, entry);
		this._renderProperties(cardEl, entry);

		const bodyEl = cardEl.createDiv({ cls: "kg-card-body markdown-rendered" });
		bodyEl.style.display = "none";
		cardEl._keepEntry = entry;
		cardEl._keepBodyEl = bodyEl;

		const hasTags = this._showTags && this._renderTags(cardEl, fm, cache?.tags);
		if (!hasTags) cardEl.addClass("kg-no-tags");

		this._attachCardActions(cardEl, entry, fm, isPinned);
		return cardEl;
	}

	_attachCardActions(cardEl, entry, fm, isPinned) {
		const file = entry.file;
		const handlePin = async () => {
			if (file.extension !== "md") {
				new obsidian.Notice("Pinning is only supported for Markdown (.md) files.");
				return;
			}
			await this.app.fileManager.processFrontMatter(file, frontmatter => {
				frontmatter.keep_pinned = !isPinned;
			});
		};

		const handleColorChange = event => {
			event?.stopPropagation?.();
			document.querySelectorAll(".kg-color-palette").forEach(el => el.remove());

			if (file.extension !== "md") {
				new obsidian.Notice("Color change is only supported for Markdown (.md) files.");
				return;
			}

			const currentColor = fm?.keep_color ?? "default";
			const colors = [
				{ id: "default", label: "Default", hex: null },
				{ id: "red", label: "Red", hex: "#f28b82" },
				{ id: "orange", label: "Orange", hex: "#fbbc04" },
				{ id: "yellow", label: "Yellow", hex: "#fff475" },
				{ id: "green", label: "Green", hex: "#ccff90" },
				{ id: "cyan", label: "Cyan", hex: "#a8f0e0" },
				{ id: "blue", label: "Blue", hex: "#aecbfa" },
				{ id: "purple", label: "Purple", hex: "#d7aefb" },
				{ id: "pink", label: "Pink", hex: "#fdcfe8" },
			];

			const palette = document.createElement("div");
			palette.className = "kg-color-palette";
			for (const color of colors) {
				const btn = palette.createEl("button", { cls: "kg-color-swatch" });
				btn.setAttribute("aria-label", color.label);
				btn.setAttribute("title", color.label);
				if (color.hex) {
					btn.style.backgroundColor = color.hex;
				} else {
					btn.classList.add("kg-color-swatch-default");
				}
				if (color.id === currentColor) {
					btn.classList.add("kg-color-swatch-active");
					const check = btn.createEl("span", { cls: "kg-color-check" });
					obsidian.setIcon(check, "check");
				}
				btn.addEventListener("click", async ev => {
					ev.stopPropagation();
					palette.remove();
					await this.app.fileManager.processFrontMatter(file, nextFm => {
						if (color.id === "default") delete nextFm.keep_color;
						else nextFm.keep_color = color.id;
					});
				});
			}

			const rect = event?.target?.closest?.(".kg-action-btn, .kg-pin-btn")?.getBoundingClientRect?.()
				?? { bottom: event?.clientY ?? 0, left: event?.clientX ?? 0, top: event?.clientY ?? 0 };
			document.body.appendChild(palette);
			const pw = palette.offsetWidth;
			const ph = palette.offsetHeight;
			let top = rect.bottom + 6;
			let left = rect.left;
			const margin = obsidian.Platform.isMobile ? 12 : 8;
			if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
			if (left < margin) left = margin;
			if (top + ph > window.innerHeight - margin) top = (rect.top || rect.bottom) - ph - 6;
			if (top < margin) top = margin;
			palette.style.top = `${top}px`;
			palette.style.left = `${left}px`;

			const close = ev => {
				if (!palette.contains(ev.target)) {
					palette.remove();
					document.removeEventListener("click", close, true);
				}
			};
			setTimeout(() => document.addEventListener("click", close, true), 0);
		};

		const handleDelete = async () => {
			new ConfirmModal(this.app, `Move "${file.name}" to trash?`, async () => {
				await this.app.vault.trash(file, true);
			}).open();
		};

		if (!obsidian.Platform.isMobile) {
			const pinBtn = cardEl.createEl("button", {
				cls: `kg-pin-btn clickable-icon${isPinned ? " is-pinned" : ""}`,
				attr: { "aria-label": isPinned ? "Unpin" : "Pin" },
			});
			obsidian.setIcon(pinBtn, isPinned ? "pin-off" : "pin");
			pinBtn.addEventListener("click", event => {
				event.stopPropagation();
				void handlePin();
			});

			const actionsEl = cardEl.createDiv({ cls: "kg-card-actions" });
			const colorBtn = actionsEl.createEl("button", { cls: "kg-action-btn clickable-icon", attr: { "aria-label": "Change color" } });
			obsidian.setIcon(colorBtn, "palette");
			colorBtn.addEventListener("click", handleColorChange);

			const deleteBtn = actionsEl.createEl("button", { cls: "kg-action-btn clickable-icon", attr: { "aria-label": "Delete" } });
			obsidian.setIcon(deleteBtn, "trash");
			deleteBtn.addEventListener("click", event => {
				event.stopPropagation();
				void handleDelete();
			});
		}

		cardEl.addEventListener("contextmenu", event => {
			event.preventDefault();
			const menu = new obsidian.Menu();
			menu.addItem(item => {
				item.setTitle("Open in new tab")
					.setIcon("file-plus")
					.onClick(() => {
						this._saveScrollPosition(null, true);
						const leaf = this.app.workspace.getLeaf("tab");
						void leaf.openFile(file);
					});
			});
			menu.addSeparator();
			menu.addItem(item => {
				item.setTitle(isPinned ? "Unpin" : "Pin")
					.setIcon(isPinned ? "pin-off" : "pin")
					.onClick(handlePin);
			});
			menu.addItem(item => {
				item.setTitle("Change color")
					.setIcon("palette")
					.onClick(() => handleColorChange(event));
			});
			menu.addItem(item => {
				item.setTitle("Delete")
					.setIcon("trash")
					.onClick(handleDelete);
			});
			menu.showAtMouseEvent(event);
		});

		cardEl.addEventListener("click", event => {
			if (event.target instanceof Element && (event.target.closest("a") || event.target.closest(".kg-action-btn") || event.target.closest(".kg-pin-btn"))) return;
			if (!this.app?.workspace) return;

			const newLeaf = obsidian.Keymap.isModEvent(event);
			if (!newLeaf && this.plugin?.settings?.openInPopup !== false) {
				new KeepEditModal(this.app, file, this.plugin).open();
			} else {
				this._saveScrollPosition(null, true);
				const leaf = this.app.workspace.getLeaf(newLeaf);
				void leaf.openFile(file);
			}
		});

		cardEl.addEventListener("mouseover", event => {
			if (event.relatedTarget instanceof Element && cardEl.contains(event.relatedTarget)) return;
			if (event.target instanceof Element && event.target.closest("a")) return;
			this.app?.workspace.trigger("hover-link", {
				event,
				source: HOVER_SOURCE,
				hoverParent: this,
				targetEl: cardEl,
				linktext: file.path,
				sourcePath: "",
			});
		});
	}

	async _loadCardBody(cardEl, token, options = {}) {
		const t0 = performance.now();
		const entry = cardEl._keepEntry;
		const bodyEl = cardEl._keepBodyEl;
		const file = entry?.file;
		if (!this.app || !file || !bodyEl) return false;
		const mode = options.mode ?? "full";

		try {
			bodyEl.removeClass("kg-card-body-base");
			bodyEl.removeClass("kg-markdown-rendered");
			bodyEl.removeClass("kg-lite-rendered");

			if (file.extension === "base") {
				if (!this._showBasePreview) return false;
				bodyEl.style.display = "";
				bodyEl.addClass("kg-card-body-base");
				bodyEl.addClass("kg-markdown-rendered");
				bodyEl.empty();
				bodyEl.dataset.keepTruncated = "false";
				if (mode === "layout" || mode === "shell") {
					cardEl._kgNeedsMarkdownUpgrade = true;
					bodyEl.createDiv({ cls: "kg-base-placeholder", text: file.path });
					return true;
				}
				if (typeof obsidian.MarkdownRenderer.render === "function") {
					await obsidian.MarkdownRenderer.render(this.app, `![[${file.path}]]`, bodyEl, file.path, this);
				} else {
					await this._renderMarkdown(`![[${escapeWikiLinkPath(file.path)}]]`, bodyEl, file.path);
				}
				cardEl._kgNeedsMarkdownUpgrade = false;
				return true;
			}

			if (file.extension !== "md" && file.extension !== "txt") return false;
			if (mode === "shell") {
				cardEl._kgNeedsMarkdownUpgrade = true;
				bodyEl.style.display = "none";
				bodyEl.empty();
				bodyEl.dataset.keepTruncated = "false";
				return true;
			}

			const maxLines = 25;
			const maxChars = 1000;
			const previewSource = await this._getPreviewSource(file, maxLines, maxChars);
			if (this._renderToken !== token) return false;
			bodyEl.style.display = "";
			if (!previewSource.markdown) return false;

			cardEl._kgNeedsMarkdownUpgrade = false;
			bodyEl.addClass("kg-lite-rendered");
			const preview = this._renderLightweightPreview(bodyEl, previewSource.markdown, cardEl);
			bodyEl.dataset.keepTruncated = previewSource.truncated || preview.truncated ? "true" : "false";
			if (preview.renderedLines === 0) {
				bodyEl.style.display = "none";
				bodyEl.empty();
				return false;
			}
			return true;
		} catch (_) {
			// Card previews are best-effort; failed previews should not break the view.
			return false;
		} finally {
			const elapsed = performance.now() - t0;
			if (elapsed > 24) {
				this._perfLog("loadCardBody", {
					elapsed: Math.round(elapsed),
					mode,
					ext: file?.extension,
					path: file?.path,
				});
			}
		}
	}

	_renderLightweightPreview(bodyEl, markdown, cardEl) {
		bodyEl.empty();
		const maxLines = Math.max(1, Number(cardEl?.style.getPropertyValue("--kg-preview-lines") || 8));
		const lines = markdown
			.split("\n")
			.map(line => line.trimEnd())
			.filter(line => line.trim().length > 0);

		let renderedLines = 0;
		let renderableLines = 0;
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			const codeBlock = this._readCodeBlock(lines, index);
			if (codeBlock) {
				renderableLines += Math.max(1, codeBlock.lines.length);
				if (renderedLines < maxLines) {
					this._renderPreviewCodeBlock(bodyEl, codeBlock, maxLines - renderedLines);
					renderedLines += Math.min(Math.max(1, codeBlock.lines.length), maxLines - renderedLines);
				}
				index = codeBlock.endIndex;
				continue;
			}

			const table = this._readMarkdownTable(lines, index);
			if (table) {
				const rowCount = 1 + table.rows.length;
				renderableLines += rowCount;
				if (renderedLines < maxLines) {
					const renderedRows = this._renderPreviewTable(bodyEl, table, maxLines - renderedLines);
					renderedLines += renderedRows;
				}
				index = table.endIndex;
				continue;
			}

			const callout = this._readCallout(lines, index);
			if (callout) {
				const lineCount = 1 + callout.lines.length;
				renderableLines += lineCount;
				if (renderedLines < maxLines) {
					this._renderPreviewCallout(bodyEl, callout, maxLines - renderedLines);
					renderedLines += Math.min(lineCount, maxLines - renderedLines);
				}
				index = callout.endIndex;
				continue;
			}

			const image = this._readPreviewImage(line, cardEl);
			if (image) {
				renderableLines++;
				if (renderedLines < maxLines) {
					this._renderPreviewImage(bodyEl, image);
					renderedLines++;
				}
				continue;
			}

			const cleanLine = this._cleanPreviewText(line);
			if (!cleanLine) continue;
			renderableLines++;
			if (renderedLines >= maxLines) continue;
			const task = line.match(/^(\s*)[-*]\s+\[([ xX])]\s*(.*)$/);
			if (task) {
				const text = this._cleanPreviewText(task[3]);
				const row = bodyEl.createDiv({ cls: "kg-lite-task" });
				this._applyPreviewIndent(row, task[1]);
				const checkbox = row.createEl("input", { type: "checkbox" });
				checkbox.checked = task[2].toLowerCase() === "x";
				checkbox.disabled = true;
				if (text) row.createSpan({ text });
				renderedLines++;
				continue;
			}

			const heading = line.match(/^#{1,6}\s+(.*)$/);
			if (heading) {
				const text = this._cleanPreviewText(heading[1]);
				if (!text) continue;
				bodyEl.createDiv({ cls: "kg-lite-heading", text });
				renderedLines++;
				continue;
			}

			const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
			if (bullet) {
				const text = this._cleanPreviewText(bullet[2]);
				if (!text) continue;
				const row = bodyEl.createDiv({ cls: "kg-lite-bullet" });
				this._applyPreviewIndent(row, bullet[1]);
				row.createSpan({ cls: "kg-lite-bullet-dot", text: "-" });
				row.createSpan({ text });
				renderedLines++;
				continue;
			}

			bodyEl.createDiv({ cls: "kg-lite-line", text: cleanLine });
			renderedLines++;
		}
		return {
			renderedLines,
			truncated: renderableLines > renderedLines,
		};
	}

	_applyPreviewIndent(row, indent) {
		const depth = Math.floor((indent ?? "").replace(/\t/g, "    ").length / 2);
		if (depth > 0) row.style.marginLeft = `${Math.min(28, depth * 10)}px`;
	}

	_readMarkdownTable(lines, startIndex) {
		if (startIndex + 1 >= lines.length) return null;
		const headerLine = lines[startIndex];
		const separatorLine = lines[startIndex + 1];
		if (!headerLine.includes("|") || !separatorLine.includes("|")) return null;

		const separatorCells = this._splitTableRow(separatorLine);
		if (separatorCells.length === 0 || separatorCells.some(cell => !/^:?-{3,}:?$/.test(cell.trim()))) return null;

		const headers = this._splitTableRow(headerLine).map(cell => this._cleanPreviewText(cell));
		if (headers.length === 0 || headers.every(cell => !cell)) return null;

		const rows = [];
		let index = startIndex + 2;
		while (index < lines.length && lines[index].includes("|")) {
			const cells = this._splitTableRow(lines[index]).map(cell => this._cleanPreviewText(cell));
			if (cells.length === 0 || cells.every(cell => !cell)) break;
			rows.push(cells);
			index++;
		}

		return {
			headers,
			rows,
			endIndex: index - 1,
		};
	}

	_splitTableRow(line) {
		return line
			.trim()
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map(cell => cell.trim());
	}

	_renderPreviewTable(bodyEl, table, maxRows) {
		if (maxRows <= 0) return 0;

		const wrapEl = bodyEl.createDiv({ cls: "kg-lite-table-wrap" });
		const tableEl = wrapEl.createEl("table", { cls: "kg-lite-table" });
		const thead = tableEl.createEl("thead");
		const headRow = thead.createEl("tr");
		for (const header of table.headers) headRow.createEl("th", { text: header });

		let renderedRows = 1;
		const tbody = tableEl.createEl("tbody");
		for (const row of table.rows.slice(0, Math.max(0, maxRows - 1))) {
			const rowEl = tbody.createEl("tr");
			for (let index = 0; index < table.headers.length; index++) {
				rowEl.createEl("td", { text: row[index] ?? "" });
			}
			renderedRows++;
		}

		return renderedRows;
	}

	_readCodeBlock(lines, startIndex) {
		const first = lines[startIndex];
		const fence = first.match(/^```(.*)$/);
		if (!fence) return null;

		const codeLines = [];
		let index = startIndex + 1;
		while (index < lines.length && !/^```/.test(lines[index])) {
			codeLines.push(lines[index]);
			index++;
		}

		return {
			language: fence[1]?.trim() ?? "",
			lines: codeLines,
			endIndex: Math.min(index, lines.length - 1),
		};
	}

	_renderPreviewCodeBlock(bodyEl, codeBlock, maxRows) {
		const pre = bodyEl.createEl("pre", { cls: "kg-lite-code" });
		const code = pre.createEl("code");
		if (codeBlock.language) code.setAttribute("data-language", codeBlock.language);
		code.textContent = codeBlock.lines.slice(0, Math.max(1, maxRows)).join("\n") || " ";
	}

	_readCallout(lines, startIndex) {
		const first = lines[startIndex].match(/^>\s*\[!([^\]]+)]\s*(.*)$/);
		if (!first) return null;

		const bodyLines = [];
		let index = startIndex + 1;
		while (index < lines.length && /^>/.test(lines[index])) {
			bodyLines.push(lines[index].replace(/^>\s?/, ""));
			index++;
		}

		return {
			type: first[1].trim(),
			title: first[2].trim(),
			lines: bodyLines,
			endIndex: index - 1,
		};
	}

	_renderPreviewCallout(bodyEl, callout, maxRows) {
		const calloutEl = bodyEl.createDiv({ cls: "kg-lite-callout" });
		const title = callout.title || callout.type.charAt(0).toUpperCase() + callout.type.slice(1).toLowerCase();
		calloutEl.createDiv({ cls: "kg-lite-callout-title", text: title });
		const contentEl = calloutEl.createDiv({ cls: "kg-lite-callout-content" });
		for (const line of callout.lines.slice(0, Math.max(0, maxRows - 1))) {
			const text = this._cleanPreviewText(line);
			if (text) contentEl.createDiv({ text });
		}
	}

	_readPreviewImage(line, cardEl) {
		const wiki = line.match(/^!\[\[([^\]]+)]]/);
		const markdown = line.match(/^!\[[^\]]*]\(([^)]+)\)/);
		const raw = wiki?.[1] ?? markdown?.[1];
		if (!raw) return null;

		const filePath = cardEl?._keepEntry?.file?.path ?? "";
		const src = resolveImageSrc(raw, filePath, this.app);
		return src ? { src, label: raw } : { src: null, label: raw };
	}

	_renderPreviewImage(bodyEl, image) {
		const wrap = bodyEl.createDiv({ cls: "kg-lite-image-wrap" });
		if (image.src) {
			wrap.createEl("img", { cls: "kg-lite-image", attr: { src: image.src, alt: "", loading: "lazy", decoding: "async" } });
		} else {
			wrap.createDiv({ cls: "kg-lite-image-missing", text: image.label });
		}
	}

	async _renderMarkdown(markdown, el, sourcePath) {
		if (typeof obsidian.MarkdownRenderer.renderMarkdown === "function") {
			await obsidian.MarkdownRenderer.renderMarkdown(markdown, el, sourcePath, this);
			return;
		}

		if (typeof obsidian.MarkdownRenderer.render === "function") {
			await obsidian.MarkdownRenderer.render(this.app, markdown, el, sourcePath, this);
		}
	}

	async _getPreviewSource(file, maxLines, maxChars) {
		const cacheKey = `${file.path}\u001f${file.stat?.mtime ?? 0}\u001f${maxLines}\u001f${maxChars}`;
		const cache = this.plugin?._previewSourceCache;
		if (cache?.has(cacheKey)) return cache.get(cacheKey);

		const content = await this.app.vault.cachedRead(file);
		const preview = extractBodyMarkdownInfo(content, maxLines, maxChars);
		if (cache) {
			cache.set(cacheKey, preview);
			if (cache.size > 500) {
				const firstKey = cache.keys().next().value;
				if (firstKey) cache.delete(firstKey);
			}
		}
		return preview;
	}

	_hasRenderedPreviewContent(bodyEl) {
		if (bodyEl.textContent.trim()) return true;
		return Boolean(bodyEl.querySelector("img, table, pre, code, .callout, .internal-embed, .markdown-embed, iframe, video, audio, canvas, svg"));
	}

	async _waitForPreviewImages(bodyEl, timeoutMs) {
		const images = [...bodyEl.querySelectorAll("img")].filter(img => !img.complete);
		if (images.length === 0) return;

		await Promise.race([
			Promise.all(images.slice(0, 8).map(img => new Promise(resolve => {
				img.addEventListener("load", resolve, { once: true });
				img.addEventListener("error", resolve, { once: true });
			}))),
			new Promise(resolve => setTimeout(resolve, timeoutMs)),
		]);
	}

	_updateBodyFade(cardEl) {
		const bodyEl = cardEl?._keepBodyEl;
		if (!bodyEl || bodyEl.style.display === "none") {
			cardEl?.removeClass?.("kg-body-clipped");
			return;
		}

		const clippedByHeight = bodyEl.scrollHeight > bodyEl.clientHeight + 1;
		const clippedByPreviewLimit = bodyEl.dataset.keepTruncated === "true";
		cardEl.classList.toggle("kg-body-clipped", clippedByHeight || clippedByPreviewLimit);
	}

	_cleanPreviewText(text) {
		return text
			.replace(/!\[\[([^\]]+)]]/g, "$1")
			.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, (_, target, label) => label || target)
			.replace(/!?\[([^\]]*)]\([^)]+\)/g, "$1")
			.replace(/[`*_~>#]/g, "")
			.trim();
	}

	_renderCover(cardEl, entry, filePath) {
		const raw = valueToString(entry.getValue(this._imagePropertyId));
		if (!raw) return;

		const coverEl = cardEl.createDiv({ cls: `kg-card-cover kg-card-cover--${this._imageFit}` });
		this._applyCoverImage(coverEl, raw, filePath, 0);
	}

	_applyCoverImage(coverEl, raw, filePath, attempt) {
		const src = resolveImageSrc(raw, filePath, this.app);
		if (src) {
			coverEl.empty();
			coverEl.removeClass("kg-card-cover-loading");
			coverEl.createEl("img", { attr: { src, alt: "", loading: "lazy", decoding: "async" } });
			return;
		}

		coverEl.addClass("kg-card-cover-loading");
		if (attempt < 6) {
			setTimeout(() => this._applyCoverImage(coverEl, raw, filePath, attempt + 1), 250 * (attempt + 1));
		}
	}

	_renderTitle(titleEl, entry) {
		let rendered = false;
		if (this._cardTitlePropertyId) {
			const value = entry.getValue(this._cardTitlePropertyId);
			const str = valueToString(value);
			if (str) {
				titleEl.textContent = str;
				rendered = true;
			}
		}

		if (!rendered) {
			titleEl.textContent = entry.file.extension !== "md" ? entry.file.name : entry.file.basename;
		} else if (entry.file.extension !== "md") {
			const ext = `.${entry.file.extension}`;
			if (!titleEl.textContent.endsWith(ext)) titleEl.appendChild(document.createTextNode(ext));
		}
	}

	_renderProperties(cardEl, entry) {
		const props = this.data?.properties ?? [];
		const shown = [];

		for (const propId of props) {
			if (propId === this._cardTitlePropertyId) continue;
			if (propId === "file.name" || propId === "file.basename" || propId === "file.fullname") continue;

			const value = entry.getValue(propId);
			const str = valueToString(value);
			if (!str || str === "null") continue;
			shown.push({ propId, value });
		}

		if (shown.length === 0) return;
		const propsEl = cardEl.createDiv({ cls: "kg-card-props" });
		for (const { propId, value } of shown) {
			const rowEl = propsEl.createDiv({ cls: "kg-prop" });
			rowEl.createSpan({ cls: "kg-prop-label", text: this._propDisplayName(propId) });
			const valEl = rowEl.createSpan({ cls: "kg-prop-value" });
			valEl.textContent = value.toString();
		}
	}

	_renderTags(cardEl, fm, inlineTags) {
		const seen = new Set();
		const tags = [];
		const fmRaw = fm?.tags ?? fm?.tag ?? [];
		const fmList = Array.isArray(fmRaw) ? fmRaw : typeof fmRaw === "string" ? [fmRaw] : [];

		for (const raw of fmList) {
			const tag = raw.startsWith("#") ? raw : `#${raw}`;
			if (!seen.has(tag)) {
				seen.add(tag);
				tags.push(tag);
			}
		}
		for (const item of inlineTags ?? []) {
			const tag = item.tag ?? item;
			if (!seen.has(tag)) {
				seen.add(tag);
				tags.push(tag);
			}
		}

		if (tags.length === 0) return false;
		const tagsEl = cardEl.createDiv({ cls: "kg-card-tags" });
		for (const tag of tags.slice(0, 5)) tagsEl.createSpan({ cls: "kg-tag", text: tag });
		return true;
	}

	_propDisplayName(propId) {
		try {
			const parsed = obsidian.parsePropertyId(propId);
			if (parsed?.name) return parsed.name;
		} catch (_) {}
		return propId.charAt(0).toUpperCase() + propId.slice(1);
	}
}

class ConfirmModal extends obsidian.Modal {
	constructor(app, message, onConfirm) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "Confirm" });
		contentEl.createEl("p", { text: this.message });

		const btnContainer = contentEl.createDiv({ cls: "modal-button-container" });
		const cancelBtn = btnContainer.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = btnContainer.createEl("button", { text: "Delete", cls: "mod-warning" });
		confirmBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

class KeepEditModal extends obsidian.Modal {
	constructor(app, file, plugin) {
		super(app);
		this.file = file;
		this.plugin = plugin;
		this.leaf = null;
	}

	async onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("kg-edit-modal");
		const width = this.plugin?.settings?.popupWidth || 800;
		this.modalEl.style.setProperty("max-width", `${width}px`, "important");
		contentEl.empty();

		try {
			const activeLeaf = this.app.workspace.getLeaf(false);
			const WorkspaceLeaf = activeLeaf.constructor;
			this.leaf = new WorkspaceLeaf(this.app);
			contentEl.appendChild(this.leaf.containerEl);
			await this.leaf.openFile(this.file);
		} catch (err) {
			console.error("[KeepBasesView] Failed to mount detached leaf:", err);
			contentEl.createEl("p", { text: "Failed to load the standard editor." });
		}
	}

	onClose() {
		if (this.leaf) {
			this.leaf.detach();
			this.leaf = null;
		}
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
		containerEl.createEl("h2", { text: "Keep Bases View Settings" });

		new obsidian.Setting(containerEl)
			.setName("Specific .base file path")
			.setDesc("Path to the .base file opened by the \"Open specific .base file\" command.")
			.addText(text => text
				.setPlaceholder("path/to/file.base")
				.setValue(this.plugin.settings.specificBaseFilePath || "")
				.onChange(async value => {
					this.plugin.settings.specificBaseFilePath = value.trim();
					await this.plugin.saveSettings();
				}));

		new obsidian.Setting(containerEl)
			.setName("Open in popup")
			.setDesc("Open cards in a Google Keep-like popup modal for quick editing.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.openInPopup !== false)
				.onChange(async value => {
					this.plugin.settings.openInPopup = value;
					await this.plugin.saveSettings();
				}));

		new obsidian.Setting(containerEl)
			.setName("Popup max width (px)")
			.setDesc("Set the maximum width of the edit popup in pixels. Default is 800.")
			.addText(text => text
				.setPlaceholder("800")
				.setValue(String(this.plugin.settings.popupWidth || 800))
				.onChange(async value => {
					const parsed = parseInt(value, 10);
					if (!Number.isNaN(parsed) && parsed > 0) {
						this.plugin.settings.popupWidth = parsed;
						await this.plugin.saveSettings();
					}
				}));

		new obsidian.Setting(containerEl)
			.setName("Card move animation")
			.setDesc("Animate cards sliding to their new positions when the column count changes due to a window or sidebar resize.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableAnimation !== false)
				.onChange(async value => {
					this.plugin.settings.enableAnimation = value;
					await this.plugin.saveSettings();
				}));

		new obsidian.Setting(containerEl)
			.setName("Mobile: even 2-column layout")
			.setDesc("On mobile, always show 2 columns with equal left, gap, and right spacing. Overrides the mobile card width setting.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.mobileEvenColumns === true)
				.onChange(async value => {
					this.plugin.settings.mobileEvenColumns = value;
					await this.plugin.saveSettings();
				}));

		new obsidian.Setting(containerEl)
			.setName("Enable performance logging")
			.setDesc("Log slow Keep Bases View operations to the developer console for performance analysis.")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enablePerformanceLogging === true)
				.onChange(async value => {
					this.plugin.settings.enablePerformanceLogging = value;
					await this.plugin.saveSettings();
				}));
	}
}

class BaseFileSuggester extends obsidian.FuzzySuggestModal {
	constructor(app, files) {
		super(app);
		this.files = files;
		this.setPlaceholder("Select a .base file to open");
	}

	getItems() {
		return this.files;
	}

	getItemText(item) {
		return item.path;
	}

	onChooseItem(item) {
		const leaf = this.app.workspace.getLeaf(false);
		void leaf.openFile(item);
	}
}

class KeepBasesViewPlugin extends obsidian.Plugin {
	async onload() {
		await this.loadSettings();
		this._scrollPositions = new Map();
		this._previewSourceCache = new Map();
		this._cardHeightCache = new Map();
		this.addSettingTab(new KeepBasesViewSettingTab(this.app, this));

		this.registerHoverLinkSource(HOVER_SOURCE, {
			display: "Keep Bases View",
			defaultMod: true,
		});

		this.registerBasesView(KEEP_VIEW_TYPE, {
			name: "Keep Bases View",
			icon: "layout-dashboard",
			factory: (controller, scrollEl) => new KeepGridView(controller, scrollEl, this),
			options: KeepGridView.getViewOptions,
		});

		this.addCommand({
			id: "open-base-file-suggester",
			name: "Open a .base file",
			callback: () => {
				const files = this.app.vault.getFiles().filter(file => file.extension === "base");
				if (files.length === 0) {
					new obsidian.Notice("No .base files found.");
					return;
				}
				new BaseFileSuggester(this.app, files).open();
			},
		});

		this.addCommand({
			id: "open-specific-base-file",
			name: "Open specific .base file",
			callback: () => {
				const path = this.settings.specificBaseFilePath?.trim();
				if (!path) {
					new obsidian.Notice("No specific .base file path configured in settings.");
					return;
				}
				const file = this.app.vault.getAbstractFileByPath(path);
				if (file instanceof obsidian.TFile) {
					void this.app.workspace.getLeaf(false).openFile(file);
				} else {
					new obsidian.Notice(`File not found: "${path}"`);
				}
			},
		});
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			{ specificBaseFilePath: "", openInPopup: true, popupWidth: 800, enablePerformanceLogging: false, enableAnimation: true, mobileEvenColumns: false },
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

module.exports = KeepBasesViewPlugin;
