"use strict";

const obsidian = require("obsidian");

const KEEP_VIEW_TYPE = "keep-grid-view";
const HOVER_SOURCE = "keep-bases-view";
const DEBOUNCE_MS = 50;

function lruSet(cache, key, value, limit) {
	cache.delete(key); cache.set(key, value);
	while (cache.size > limit) cache.delete(cache.keys().next().value);
}

function extractBodyMarkdownInfo(content, maxLines = 25, maxChars = 1000) {
	let body = content;
	if (body.startsWith("---")) {
		const end = body.indexOf("\n---", 3);
		if (end !== -1) body = body.slice(end + 4);
		if (end !== -1) { let first = 0; while (first < body.length && /\s/.test(body[first])) first++; body = body.slice(first); }
	}
	let pos = 0, lines = 1;
	const limit = Math.min(body.length, maxChars);
	while (lines <= maxLines) {
		const next = body.indexOf("\n", pos);
		if (next < 0 || next >= limit) { pos = limit; break; }
		if (lines === maxLines) { pos = next; break; }
		pos = next + 1;
		lines++;
	}
	return { markdown: body.slice(0, pos).trim() || null, truncated: pos < body.length };
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

function resolveImageFile(raw, filePath, app) {
	if (!raw || /^https?:\/\//i.test(raw)) return null;

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
	return imgFile instanceof obsidian.TFile ? imgFile : null;
}

function resolveImageSrc(raw, filePath, app) {
	if (!raw) return null;
	if (/^https?:\/\//i.test(raw)) return raw;
	const file = resolveImageFile(raw, filePath, app);
	return file ? app.vault.getResourcePath(file) : null;
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
		this._previewScrollTicking = false;
		this._lastScrollTop = this._scrollEl.scrollTop || 0;
		this._scrollDirection = 1;
		this._virtual = null;
		this._layoutEpoch = 0;
		this._batchRun = null;
		this._statusEl = scrollEl.createDiv({ cls: "kg-measuring-status" });
		this._statusEl.setAttribute("role", "status");
		this._statusEl.hidden = true;
		plugin._views.add(this);
		this._delegatedHandlers = {};
		for (const type of ["click", "contextmenu", "mouseover"]) {
			const handler = event => {
				const card = event.target.closest?.(".kg-card");
				if (!card || !this._contentEl.contains(card)) return;
				if (type === "mouseover" && this._scrolling) return;
				if (type === "mouseover") card._kgEnsureButtons?.();
				const action = type === "click" ? event.target.closest?.("[data-kg-action]") : null;
				if (action) { event.stopPropagation(); void card._kgActions?.[action.dataset.kgAction]?.(event); return; }
				card._kgHandlers?.[type]?.(event);
			};
			this._delegatedHandlers[type] = handler;
			this._contentEl.addEventListener(type, handler);
		}
		this._rememberPointer = event => { this._lastClientX = event.clientX; this._lastClientY = event.clientY; };
		this._scrollEl.addEventListener("pointermove", this._rememberPointer, { passive: true });
		this._scrollEl.addEventListener("wheel", this._rememberPointer, { passive: true });
		this._lastLayoutWidth = 0;
		this._resizeTicking = false;
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
			this._scrolling = true;
			this._scrollEl.addClass("kg-scrolling");
			clearTimeout(this._scrollStopTimer);
			this._scrollStopTimer = setTimeout(() => {
				this._scrolling = false;
				this._scrollEl.removeClass("kg-scrolling");
				const card = document.elementFromPoint(this._lastClientX ?? -1, this._lastClientY ?? -1)?.closest?.(".kg-card");
				if (card && this._contentEl.contains(card)) card._kgEnsureButtons?.();
			}, 120);
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
				}
			});
		};
		this._scrollEl.addEventListener("scroll", this._onScroll, { passive: true });


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
			mounted: this._virtual?.mounted.size ?? 0,
			domNodes: this._scrollEl.querySelectorAll("*").length,
		});
	}

	onDataUpdated() {
		this._debouncedRender();
	}

	onClose() {
		this._renderToken++;
		this._layoutEpoch++;
		this._virtual = null;
		this.plugin._views.delete(this);
		clearTimeout(this._scrollStopTimer);
		this._scrollEl.removeClass("kg-restoring-scroll", "kg-scrolling");
		this._statusEl.remove();
		for (const [type, handler] of Object.entries(this._delegatedHandlers)) this._contentEl.removeEventListener(type, handler);
		this._scrollEl.removeEventListener("pointermove", this._rememberPointer);
		this._scrollEl.removeEventListener("wheel", this._rememberPointer);
		this._clearSavedScrollPosition();
		this._debouncedRender.cancel();
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
		this._previewImages = cfg?.get("previewImages") !== false;
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
				displayName: "Preview images in cards",
				type: "toggle",
				key: "previewImages",
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
		if (this._renderSignature === signature && !this._virtual?.sections.some(section => section.items.some(item =>
			item.readFailed || (item.expiresAt && item.expiresAt <= Date.now()) || !this._isImageLocksValid(item.imageLocks, item.entry.file.path)))) return;

		const token = ++this._renderToken;
		this._layoutEpoch++;
		this._statusEl.hidden = true;
		const scrollKey = this._getScrollKey(entries);
		this._scrollRestoreKey = scrollKey;
		const savedRecord = this.plugin?._scrollPositions?.get(scrollKey);
		const savedScrollTop = savedRecord?.persist === true ? savedRecord.top : this._localScrollTop;
		if (savedRecord != null) this.plugin._scrollPositions.delete(scrollKey);
		const shouldRestoreSavedScroll = savedScrollTop != null && savedScrollTop > 0;
		const previousScrollTop = savedScrollTop ?? this._scrollEl.scrollTop;
		this._renderSignature = signature;

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
		this._renderStartedAt = performance.now();
		this._frameStats = null;
		this._layoutPasses = 0;
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

		this._virtual.targetScrollTop = targetScrollTop || 0;
		this._virtual.restoring = restoring;
		this._layoutVirtualSections();
		this._scrollEl.scrollTop = Math.min(targetScrollTop || 0, Math.max(0, this._scrollEl.scrollHeight - this._scrollEl.clientHeight));
		this._renderVirtualWindow();
		if (this._virtual.width <= 1) this._scheduleVirtualRelayoutChecks();
	}

	_layoutVirtualSections() {
		if (!this._virtual) return;
		this._layoutPasses++;
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

		const configKey = [cardWidth, this._cardTitlePropertyId, this._imagePropertyId, this._imageFit,
			this._cardMaxHeight, this._basePreviewHeight, this._showTags, this._showPinned,
			this._showBasePreview, this._previewImages, this._getVirtualPreviewLines(),
			(this.data?.properties ?? []).join("\u001e"), this.plugin._cssGeneration,
			window.devicePixelRatio, getComputedStyle(this._scrollEl).fontSize].join("\u001f");
		const changed = this._layoutConfigKey !== configKey;
		if (changed) { this._layoutConfigKey = configKey; this._layoutEpoch++; }
		for (const section of this._virtual.sections) {
			if (!section.items.length) section.items = section.entries.map((entry, index) => ({
				entry, fm: entry._cachedFm, cache: entry._cachedCache, index,
				key: `${section.id}:${entry.file.path}`, entrySignature: this._entrySignature(entry),
				estimatedHeight: this._estimateCardHeight(entry, entry._cachedFm, entry._cachedCache), measured: false,
			}));
			const columns = Array(columnCount).fill(0);
			section.columns = Array.from({ length: columnCount }, () => []);
			section.measuredPrefixEnd = -1;
			for (const item of section.items) {
				if (changed || item.height == null) {
					item.preparedEl = null;
					const cached = this._getLayoutCache(item);
					Object.assign(item, cached ?? { height: item.estimatedHeight, measured: false, imageLocks: [] });
					if (changed && item.mountedEl) {
						item.mountedEl.remove(); this._virtual.mounted.delete(item.key); item.mountedEl = null;
					}
				}
				if (item.measured && item.index === section.measuredPrefixEnd + 1) section.measuredPrefixEnd++;
				let column = 0;
				for (let i = 1; i < columns.length; i++) if (columns[i] < columns[column]) column = i;
				item.column = column; item.x = column * (cardWidth + gap); item.y = columns[column];
				columns[column] += item.height + gap;
				section.columns[column].push(item);
			}
			section.height = Math.max(0, ...columns) - gap;
			section.gridEl.style.height = `${Math.max(0, section.height)}px`;
			section.gridEl.style.setProperty("--kg-card-width", `${cardWidth}px`);
		}
		// Read section offsets once after all layout writes, never in the scroll loop.
		for (const section of this._virtual.sections) {
			section.top = section.gridEl.offsetTop;
			for (const item of section.items) if (item.mountedEl?.isConnected) this._positionVirtualCard(item.mountedEl, item);
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
		if (!this._virtual || this._renderToken !== this._virtual.token || this._virtual.width <= 1) return;
		const started = performance.now();
		const v = this._virtual;
		const top = v.restoring ? v.targetScrollTop : this._scrollEl.scrollTop;
		const bottom = top + this._scrollEl.clientHeight;
		const overscan = Math.max(600, Math.min(1200, Math.round(2200 / Math.sqrt(v.columnCount))));
		const keep = new Set();
		let precedingComplete = true, waiting = false, visibleWaiting = false;
		for (const section of v.sections) {
			const minY = top - overscan - section.top, maxY = bottom + overscan - section.top;
			if (precedingComplete) for (const column of section.columns) {
				let lo = 0, hi = column.length;
				while (lo < hi) { const mid = (lo + hi) >>> 1; if (column[mid].y + column[mid].height < minY) lo = mid + 1; else hi = mid; }
				for (let i = lo; i < column.length && column[i].y <= maxY; i++) {
					const item = column[i];
					if (item.index > section.measuredPrefixEnd) { waiting = true; if (item.y + section.top <= bottom && item.y + section.top + item.height >= top) visibleWaiting = true; continue; }
					keep.add(item.key);
					if (!v.mounted.has(item.key)) this._mountVirtualCard(section, item);
				}
			}
			const first = section.items[section.measuredPrefixEnd + 1];
			if (!precedingComplete && section.top <= bottom && section.top + section.height >= top) visibleWaiting = true;
			if (first && section.top + first.y <= bottom + (this._scrollDirection >= 0 ? 2000 : 800)) waiting = true;
			precedingComplete &&= !first;
		}
		for (const [key, card] of v.mounted) if (!keep.has(key)) {
			card.remove(); card._kgVirtualItem.mountedEl = null; v.mounted.delete(key);
		}
		for (const item of v.preparedItems ?? []) {
			if (item.preparedEl) { item.preparedEl.remove(); item.preparedEl = null; }
		}
		v.preparedItems = [];
		this._statusEl.hidden = !(visibleWaiting || (v.restoring && waiting));
		if (waiting) {
			const done = v.sections.reduce((n, section) => n + section.measuredPrefixEnd + 1, 0);
			this._statusEl.textContent = `Measuring cards... (${done} / ${v.sections.reduce((n, section) => n + section.items.length, 0)})`;
			void this._processMeasureQueue();
		} else if (v.restoring) {
			this._scrollEl.scrollTop = v.targetScrollTop;
			v.restoring = false;
			this._scrollEl.removeClass("kg-restoring-scroll");
			this._perfLog("scrollRestore", { elapsed: performance.now() - this._renderStartedAt, target: v.targetScrollTop, layoutPasses: this._layoutPasses });
		}
		if (!v.firstVisible && !visibleWaiting && v.mounted.size) {
			v.firstVisible = true;
			this._perfLog("firstVisible", { elapsed: performance.now() - this._renderStartedAt, layoutPasses: this._layoutPasses });
		}
		if (this.plugin.settings.enablePerformanceLogging) {
			const elapsed = performance.now() - started;
			const stats = this._frameStats ??= { count: 0, total: 0, max: 0 };
			stats.count++; stats.total += elapsed; stats.max = Math.max(stats.max, elapsed);
			this._perfLog("virtualWindow", { elapsed, average: stats.total / stats.count, max: stats.max, layoutPasses: this._layoutPasses });
		}
	}

	_mountVirtualCard(section, item) {
		const cardEl = item.preparedEl ?? this._buildMeasuredCard(item);
		item.preparedEl = null;
		cardEl.removeClass("kg-virtual-measuring");
		cardEl.addClass("kg-virtual-card");
		cardEl._kgVirtualItem = item;
		this._positionVirtualCard(cardEl, item);
		section.gridEl.appendChild(cardEl);
		this._virtual.mounted.set(item.key, cardEl);
		item.mountedEl = cardEl;
		const origin = item._kgResizeOrigin;
		delete item._kgResizeOrigin;
		if (origin && origin.epoch === this._layoutEpoch && this.plugin.settings.enableAnimation !== false) {
			const top = this._scrollEl.scrollTop, bottom = top + this._scrollEl.clientHeight;
			const newTop = section.top + item.y;
			if ((origin.top + origin.height >= top && origin.top <= bottom) || (newTop + item.height >= top && newTop <= bottom)) {
				const from = `translate3d(${origin.x}px, ${origin.top - section.top}px, 0)`;
				const to = cardEl._kgVirtualTransform;
				if (from !== to) {
					const anim = cardEl.animate([{ transform: from }, { transform: to }], { duration: 220, easing: "ease", fill: "none" });
				cardEl._kgReflowAnimation = anim;
				const done = () => { if (cardEl._kgReflowAnimation === anim) cardEl._kgReflowAnimation = null; };
					anim.onfinish = done;
					anim.oncancel = done;
				}
			}
		}
		if (item.fm?.keep_pinned === true || item.fm?.keep_pinned === "true") cardEl._kgEnsureButtons?.(false);
		if (item.entry.file.extension === "base" && this._showBasePreview) void this._loadCardBody(cardEl, this._renderToken, { mode: "upgrade" });
		return cardEl;
	}

	async _processMeasureQueue() {
		if (this._batchRun) return;
		const token = this._renderToken, epoch = this._layoutEpoch, v = this._virtual;
		const run = {}; this._batchRun = run;
		const valid = () => token === this._renderToken && epoch === this._layoutEpoch && v === this._virtual;
		const cards = [];
		const started = performance.now();
		try {
			const section = v.sections.find(section => section.measuredPrefixEnd + 1 < section.items.length);
			if (!section) return;
			const items = section.items.slice(section.measuredPrefixEnd + 1, section.measuredPrefixEnd + 41);
			const results = await Promise.all(items.map(async item => {
				try {
					const source = /^(md|txt)$/.test(item.entry.file.extension) ? await this._getPreviewSource(item.entry.file, 25, 1000) : { markdown: null };
					if (!valid()) return { item, source, imageLocks: [] };
					const parsedBlocks = this._parsePreviewBlocks(source.markdown ?? "", item.entry);
					const images = this._previewImages ? parsedBlocks.filter(block => block.type === "image").map(block => block.value) : [];
					const locks = await Promise.all(images.map(async image => ({ ...image, ...await this._probeImageDimensions(image) })));
					return { item, source, parsedBlocks, imageLocks: locks };
				} catch (_) { return { item, source: { markdown: null }, imageLocks: [], readFailed: true }; }
			}));
			if (!valid()) return;
			this._measureEl.style.width = `${v.cardWidth}px`;
			const fragment = document.createDocumentFragment();
			for (const result of results) {
				let card;
				try {
					result.parsedBlocks ??= [];
					card = this._buildMeasuredCard({ ...result.item, ...result });
				} catch (_) {
					result.source = { markdown: null }; result.parsedBlocks = []; result.readFailed = true;
					card = this._buildMeasuredCard({ ...result.item, ...result });
				}
				card.addClass("kg-virtual-measuring"); card.style.width = `${v.cardWidth}px`;
				fragment.appendChild(card); cards.push(card);
			}
			this._measureEl.appendChild(fragment);
			const readings = cards.map(card => ({
				height: Math.ceil(card.getBoundingClientRect().height),
				clipped: card._keepBodyEl?.scrollHeight > card._keepBodyEl?.clientHeight + 1 || card._keepBodyEl?.dataset.keepTruncated === "true",
				wrapHeights: [...card.querySelectorAll(".kg-lite-image-wrap")].map(wrap => wrap.getBoundingClientRect().height),
			}));
			if (!valid()) return;
			for (let i = 0; i < results.length; i++) {
				const { item, ...result } = results[i];
				Object.assign(item, result, { height: Math.max(1, readings[i].height), clipped: readings[i].clipped, measured: true, measuredEpoch: epoch });
				cards[i].classList.toggle("kg-body-clipped", item.clipped);
				item.imageLocks.forEach((lock, index) => { lock.wrapHeight = readings[i].wrapHeights[index]; });
				const failed = item.imageLocks.filter(lock => lock.expiresAt);
				item.expiresAt = failed.length ? Math.min(...failed.map(lock => lock.expiresAt)) : null;
				if (!item.readFailed) lruSet(this.plugin._cardLayoutCache, this._layoutCacheKey(item), {
					height: item.height, measured: true, clipped: item.clipped, parsedBlocks: item.parsedBlocks, source: item.source, imageLocks: item.imageLocks, expiresAt: item.expiresAt,
				}, 10000);
				item.preparedEl = cards[i];
			}
			v.preparedItems = items;
			this._layoutVirtualSections();
			this._renderVirtualWindow();
			this._perfLog("measureBatch", { elapsed: performance.now() - started, count: results.length, layoutPasses: this._layoutPasses });
		} finally {
			for (const card of cards) if (card.parentElement === this._measureEl) card.remove();
			if (this._batchRun === run) this._batchRun = null;
			if (this._virtual && this._renderToken === this._virtual.token) requestAnimationFrame(() => this._renderVirtualWindow());
		}
	}

	_buildMeasuredCard(item) {
		const card = this._createCard(item.entry, item.fm, item.cache);
		card._kgVirtualItem = item;
		card.style.setProperty("--kg-preview-lines", String(this._getVirtualPreviewLines()));
		const body = card._keepBodyEl;
		if (item.entry.file.extension === "base" && this._showBasePreview) {
			body.style.display = ""; body.addClass("kg-card-body-base");
			body.createDiv({ cls: "kg-base-placeholder", text: item.entry.file.path });
		} else if (item.source?.markdown) {
			body.style.display = ""; body.addClass("kg-lite-rendered");
			const preview = this._renderLightweightPreview(body, item.source.markdown, card);
			body.dataset.keepTruncated = item.source.truncated || preview.truncated ? "true" : "false";
			if (!preview.renderedLines) { body.remove(); card.addClass("kg-no-preview"); }
		} else { body.remove(); card.addClass("kg-no-preview"); }
		card.classList.toggle("kg-body-clipped", Boolean(item.clipped));
		return card;
	}

	_layoutCacheKey(item) { return `${item.entrySignature}\u001f${this._layoutConfigKey}`; }

	_getLayoutCache(item) {
		const cache = this.plugin._cardLayoutCache, key = this._layoutCacheKey(item);
		const value = cache.get(key);
		if (!value) return null;
		if ((value.expiresAt && Date.now() >= value.expiresAt) || !this._isImageLocksValid(value.imageLocks, item.entry.file.path)) { cache.delete(key); return null; }
		lruSet(cache, key, value, 10000); return value;
	}

	_entrySignature(entry) {
		const cache = this.app.metadataCache.getFileCache(entry.file) ?? {}, fm = cache.frontmatter ?? {};
		const props = [...new Set([...(this.data?.properties ?? []), this._cardTitlePropertyId, this._imagePropertyId].filter(Boolean))];
		return JSON.stringify([entry.file.path, entry.file.stat, fm, cache.tags,
			props.map(id => [id, valueToString(entry.getValue(id))]),
			(cache.embeds ?? []).map(embed => this._imageSpec(embed.link, entry.file.path).imageCacheKey),
			this._imagePropertyId ? this._imageSpec(valueToString(entry.getValue(this._imagePropertyId)), entry.file.path).imageCacheKey : ""]);
	}

	_imageSpec(raw, path) {
		const src = resolveImageSrc(raw, path, this.app);
		const file = resolveImageFile(raw, path, this.app);
		return { raw, label: raw, src, imageCacheKey: file instanceof obsidian.TFile ? `file:${file.path}\u001f${file.stat?.mtime ?? 0}\u001f${file.stat?.size ?? 0}` : src ? `url:${raw}` : `missing:${raw}` };
	}

	_isImageLocksValid(locks = [], path) { return locks.every(lock => this._imageSpec(lock.raw, path).imageCacheKey === lock.imageCacheKey); }

	_probeImageDimensions(spec) { return this.plugin._probeImageDimensions(spec); }

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
				const resizeOrigins = new Map();
				// Measurement can span several resize frames. Preserve pending origins
				// even when their old DOM has already been removed. Include measured
				// overscan cards that may enter the viewport after the reflow.
				for (const section of this._virtual.sections) {
					for (const item of section.items) {
						if (item._kgResizeOrigin) resizeOrigins.set(item, item._kgResizeOrigin);
						else if (item.measured) resizeOrigins.set(item, { x: item.x, top: section.top + item.y, height: item.height });
					}
				}
				for (const [, cardEl] of this._virtual.mounted) {
					if (!cardEl.isConnected) continue;
					const item = cardEl._kgVirtualItem;
					cardEl._kgOldTop = item.y + this._virtual.sections.find(section => section.items[item.index] === item).top;
					resizeOrigins.set(item, { x: item.x, top: cardEl._kgOldTop, height: item.height });
					oldTransforms.set(cardEl, cardEl._kgVirtualTransform ?? cardEl.style.transform);
				}

				// Step 2: Apply new layout (updates _kgVirtualTransform + style.transform for all cards)
				this._layoutVirtualSections();
				// Width-dependent measurement may replace the DOM. Carry the old
				// position to the replacement once its new height is confirmed.
				for (const [item, origin] of resizeOrigins) {
					if (!item.mountedEl?.isConnected) item._kgResizeOrigin = { ...origin, epoch: this._layoutEpoch };
				}
				this._renderVirtualWindow();

				// Step 3: For each card whose position changed, start a Web Animation.
				// Web Animations API is atomic: no rAF gap, no CSS transition timing issues.
				for (const [cardEl, oldTransform] of oldTransforms) {
					if (!cardEl.isConnected) continue;
					const newTransform = cardEl._kgVirtualTransform ?? cardEl.style.transform;
					if (oldTransform === newTransform) continue;
					const item = cardEl._kgVirtualItem;
					const section = this._virtual.sections.find(section => section.items[item.index] === item);
					const top = this._scrollEl.scrollTop, bottom = top + this._scrollEl.clientHeight;
					const overlaps = y => y + item.height >= top && y <= bottom;
					if (!overlaps(cardEl._kgOldTop) && !overlaps(section.top + item.y)) continue;

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
			this._perfLog("resizeLayout", { elapsed, virtual: true });
			return;
		}
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
			this._previewImages,
			this._cardMaxHeight,
			this._basePreviewHeight,
			...(this.data?.properties ?? []),
		];

		config.push(this.plugin._cssGeneration);
		const entrySig = entries.map(entry => this._entrySignature(entry));

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

	_setActionIcon(button, name) {
		this.plugin._iconTemplates ??= new Map();
		let template = this.plugin._iconTemplates.get(name);
		if (!template) {
			template = document.createElement("span"); obsidian.setIcon(template, name);
			this.plugin._iconTemplates.set(name, template);
		}
		for (const child of template.childNodes) button.appendChild(child.cloneNode(true));
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

		cardEl._kgActions = { pin: handlePin, color: handleColorChange, delete: handleDelete };
		cardEl._kgEnsureButtons = (full = true) => {
			if (obsidian.Platform.isMobile || cardEl._kgButtonsReady) return;
			if (!cardEl._kgPinReady) {
			cardEl._kgPinReady = true;
			const pinBtn = cardEl.createEl("button", {
				cls: `kg-pin-btn clickable-icon${isPinned ? " is-pinned" : ""}`,
				attr: { "aria-label": isPinned ? "Unpin" : "Pin" },
			});
			this._setActionIcon(pinBtn, isPinned ? "pin-off" : "pin");
			pinBtn.dataset.kgAction = "pin";
			}
			if (!full) return;
			cardEl._kgButtonsReady = true;

			const actionsEl = cardEl.createDiv({ cls: "kg-card-actions" });
			const colorBtn = actionsEl.createEl("button", { cls: "kg-action-btn clickable-icon", attr: { "aria-label": "Change color" } });
			this._setActionIcon(colorBtn, "palette");
			colorBtn.dataset.kgAction = "color";

			const deleteBtn = actionsEl.createEl("button", { cls: "kg-action-btn clickable-icon", attr: { "aria-label": "Delete" } });
			this._setActionIcon(deleteBtn, "trash");
			deleteBtn.dataset.kgAction = "delete";
		};
		cardEl._kgHandlers = {};
		cardEl._kgHandlers.contextmenu = event => {
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
		};

		cardEl._kgHandlers.click = event => {
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
		};

		cardEl._kgHandlers.mouseover = event => {
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
		};
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

	_parsePreviewBlocks(markdown, entry) {
		const lines = markdown.split("\n").map(line => line.trimEnd()).filter(line => line.trim());
		const blocks = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const code = this._readCodeBlock(lines, i);
			if (code) { blocks.push({ type: "code", value: code, count: Math.max(1, code.lines.length) }); i = code.endIndex; continue; }
			const table = this._readMarkdownTable(lines, i);
			if (table) { blocks.push({ type: "table", value: table, count: table.rows.length + 1 }); i = table.endIndex; continue; }
			const callout = this._readCallout(lines, i);
			if (callout) { blocks.push({ type: "callout", value: callout, count: callout.lines.length + 1 }); i = callout.endIndex; continue; }
			const image = this._readPreviewImage(line, { _keepEntry: entry });
			if (image) { blocks.push({ type: "image", value: image, text: line.trim(), count: 1 }); continue; }
			const task = line.match(/^(\s*)[-*]\s+\[([ xX])]\s*(.*)$/);
			const heading = line.match(/^#{1,6}\s+(.*)$/);
			const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
			const text = this._cleanPreviewText(task ? task[3] : heading ? heading[1] : bullet ? bullet[2] : line);
			if (!text && !task) continue;
			blocks.push({ type: task ? "task" : heading ? "heading" : bullet ? "bullet" : "line", text,
				indent: task?.[1] ?? bullet?.[1], checked: task?.[2]?.toLowerCase() === "x", count: 1 });
		}
		return blocks;
	}

	_renderLightweightPreview(bodyEl, markdown, cardEl) {
		bodyEl.empty();
		const maxLines = Math.max(1, Number(cardEl?.style.getPropertyValue("--kg-preview-lines") || 8));
		const item = cardEl?._kgVirtualItem;
		const blocks = item?.parsedBlocks ?? this._parsePreviewBlocks(markdown, cardEl?._keepEntry);
		let renderedLines = 0, renderableLines = 0;
		for (const block of blocks) {
			renderableLines += block.count;
			if (renderedLines >= maxLines) continue;
			const remaining = maxLines - renderedLines;
			if (block.type === "code") this._renderPreviewCodeBlock(bodyEl, block.value, remaining);
			else if (block.type === "table") this._renderPreviewTable(bodyEl, block.value, remaining);
			else if (block.type === "callout") this._renderPreviewCallout(bodyEl, block.value, remaining);
			else if (block.type === "image") {
				if (this._previewImages) this._renderPreviewImage(bodyEl, item?.imageLocks?.find(lock => lock.raw === block.value.raw) ?? block.value);
				else bodyEl.createDiv({ cls: "kg-lite-line", text: block.text });
			} else if (block.type === "task") {
				const row = bodyEl.createDiv({ cls: "kg-lite-task" }); this._applyPreviewIndent(row, block.indent);
				const checkbox = row.createEl("input", { type: "checkbox" }); checkbox.checked = block.checked; checkbox.disabled = true;
				if (block.text) row.createSpan({ text: block.text });
			} else if (block.type === "bullet") {
				const row = bodyEl.createDiv({ cls: "kg-lite-bullet" }); this._applyPreviewIndent(row, block.indent);
				row.createSpan({ cls: "kg-lite-bullet-dot", text: "-" }); row.createSpan({ text: block.text });
			} else bodyEl.createDiv({ cls: `kg-lite-${block.type}`, text: block.text });
			renderedLines += Math.min(block.count, remaining);
		}
		return { renderedLines, truncated: renderableLines > renderedLines };
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
		const raw = wiki ? wiki[1].split("|", 1)[0].split("#", 1)[0].trim() : markdown?.[1];
		if (!raw) return null;

		const filePath = cardEl?._keepEntry?.file?.path ?? "";
		return this._imageSpec(raw, filePath);
	}

	_renderPreviewImage(bodyEl, image) {
		const wrap = bodyEl.createDiv({ cls: "kg-lite-image-wrap" });
		if (image.src && image.status !== "failed") {
			if (image.naturalWidth) wrap.style.aspectRatio = `${image.naturalWidth} / ${image.naturalHeight}`;
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
		const cacheKey = `${file.path}\u001f${file.stat?.mtime ?? 0}\u001f${file.stat?.size ?? 0}\u001f${maxLines}\u001f${maxChars}`;
		const cache = this.plugin?._previewSourceCache;
		if (cache?.has(cacheKey)) { const value = cache.get(cacheKey); lruSet(cache, cacheKey, value, 3000); return value; }

		const content = await this.app.vault.cachedRead(file);
		const preview = extractBodyMarkdownInfo(content, maxLines, maxChars);
		if (cache) lruSet(cache, cacheKey, preview, 3000);
		return preview;
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
		this._cardLayoutCache = new Map();
		this._imageDimensionCache = new Map();
		this._inFlightImageProbes = new Map();
		this._imageProbeQueue = [];
		this._activeImageProbes = 0;
		this._maxConcurrentImageProbes = 8;
		this._cssGeneration = 0;
		this._views = new Set();
		const refresh = () => { for (const view of this._views) { view._renderSignature = null; view._debouncedRender(); } };
		this.registerEvent(this.app.workspace.on("css-change", () => { this._cssGeneration++; refresh(); }));
		this.app.workspace.onLayoutReady(() => {
			for (const event of ["create", "modify", "delete", "rename"]) this.registerEvent(this.app.vault.on(event, (file, oldPath) => {
				if (!/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(file.path) && !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(oldPath ?? "")) return;
				this._imageDimensionCache.clear(); refresh();
			}));
		});
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

	_probeImageDimensions(spec) {
		const key = spec.imageCacheKey, cache = this._imageDimensionCache;
		const cached = cache.get(key);
		if (cached && (!cached.expiresAt || cached.expiresAt > Date.now())) { lruSet(cache, key, cached, 2000); return Promise.resolve(cached); }
		cache.delete(key);
		if (this._inFlightImageProbes.has(key)) return this._inFlightImageProbes.get(key);
		const promise = new Promise(resolve => {
			this._imageProbeQueue.push(() => {
				const img = new Image(); img.decoding = "async"; let finished = false;
				const finish = ok => {
					if (finished) return; finished = true; clearTimeout(timer);
					img.onload = img.onerror = null;
					const result = ok && img.naturalWidth > 0 && img.naturalHeight > 0 ? { status: "ok", naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight } : { status: "failed", expiresAt: Date.now() + 60000 };
					if (result.status === "failed") img.src = "";
					result.imageCacheKey = key;
					lruSet(cache, key, result, 2000); this._inFlightImageProbes.delete(key);
					this._activeImageProbes--; resolve(result); this._drainImageProbes();
				};
				const timer = setTimeout(() => finish(false), 3000);
				img.onload = () => finish(true); img.onerror = () => finish(false);
				if (spec.src) { img.src = spec.src; if (img.complete) finish(img.naturalWidth > 0); } else finish(false);
			});
		});
		this._inFlightImageProbes.set(key, promise); this._drainImageProbes(); return promise;
	}

	_drainImageProbes() {
		while (this._activeImageProbes < this._maxConcurrentImageProbes && this._imageProbeQueue.length) {
			this._activeImageProbes++; this._imageProbeQueue.shift()();
		}
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
