// dongminal 포크 — 원본 @replit/codemirror-minimap 0.5.2 (dist/index.js). 고친 자리는 README.md 에 있다.
// [dongminal] 표식이 붙은 곳이 고친 자리다.
import { Facet, combineConfig, StateField } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import crelt from 'crelt';
import { setDiagnosticsEffect, diagnosticCount, forEachDiagnostic } from '@codemirror/lint';
import { foldEffect, unfoldEffect, foldedRanges, language, highlightingFor } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { TreeFragment } from '@lezer/common';

var __rest = (undefined && undefined.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
const Config = /*@__PURE__*/Facet.define({
    combine: (c) => {
        const configs = [];
        for (let config of c) {
            if (!config) {
                continue;
            }
            const { create, gutters } = config, rest = __rest(config, ["create", "gutters"]);
            configs.push(Object.assign(Object.assign({}, rest), { enabled: true, gutters: gutters
                    ? gutters.filter((v) => Object.keys(v).length > 0)
                    : undefined }));
        }
        return combineConfig(configs, {
            enabled: configs.length > 0,
            displayText: "characters",
            eventHandlers: {},
            showOverlay: "always",
            gutters: [],
            // [dongminal] 뷰포트 표시의 자리(FR-CMR-61)와 줄 표식 층(FR-CMR-62·42).
            thumb: null,
            fromThumb: null,
            marks: null,
            gutter: null,
        });
    },
});
const Scale = {
    // Multiply the number of canvas pixels
    PixelMultiplier: 2,
    // Downscale the editor contents by this ratio
    SizeRatio: 4,
    // Maximum width of the minimap in pixels
    MaxWidth: 120,
};

const Theme$1 = /*@__PURE__*/EditorView.theme({
    ".cm-minimap-overlay-container": {
        position: "absolute",
        top: 0,
        height: "100%",
        width: "100%",
        "&.cm-minimap-overlay-mouse-over": {
            opacity: 0,
            transition: "visibility 0s linear 300ms, opacity 300ms",
        },
        "&.cm-minimap-overlay-mouse-over:hover": {
            opacity: 1,
            transition: "visibility 0s linear 0ms, opacity 300ms",
        },
        "&.cm-minimap-overlay-off": {
            display: "none",
        },
        "& .cm-minimap-overlay": {
            background: "rgb(121, 121, 121)",
            opacity: "0.2",
            position: "absolute",
            right: 0,
            top: 0,
            width: "100%",
            transition: "top 0s ease-in 0ms",
            "&:hover": {
                opacity: "0.3",
            },
        },
        "&.cm-minimap-overlay-active": {
            opacity: 1,
            visibility: "visible",
            transition: "visibility 0s linear 0ms, opacity 300ms",
            "& .cm-minimap-overlay": {
                opacity: "0.4",
            },
        },
    },
});
const SCALE = Scale.PixelMultiplier * Scale.SizeRatio;
const OverlayView = /*@__PURE__*/ViewPlugin.fromClass(class {
    constructor(view) {
        this.view = view;
        this._isDragging = false;
        if (view.state.facet(Config).enabled) {
            this.create(view);
        }
    }
    create(view) {
        this.container = crelt("div", { class: "cm-minimap-overlay-container" });
        this.dom = crelt("div", { class: "cm-minimap-overlay" });
        this.container.appendChild(this.dom);
        // Attach event listeners for overlay
        this.container.addEventListener("mousedown", this.onMouseDown.bind(this));
        window.addEventListener("mouseup", this.onMouseUp.bind(this));
        window.addEventListener("mousemove", this.onMouseMove.bind(this));
        // Attach the overlay elements to the minimap
        const inner = view.dom.querySelector(".cm-minimap-inner");
        if (inner) {
            inner.appendChild(this.container);
        }
        // Initially set overlay configuration styles, height, top
        this.computeShowOverlay();
        this.schedulePlace();
    }
    // [dongminal] FR-ELS-62: 슬라이더 자리는 레이아웃을 읽으므로 측정 단계에서 정한다. 미니맵의 자체 배치가 있으면 그것을,
    // 없으면(첫 그리기 전) thumb 좌표를 쓴다.
    schedulePlace() {
        if (!this._placeMeasure) {
            this._placeMeasure = {
                key: this,
                read: () => this.placement(),
                write: (r) => {
                    if (!r || !this.dom) return;
                    this.dom.style.top = r.top + "px";
                    this.dom.style.height = r.height + "px";
                },
            };
        }
        this.view.requestMeasure(this._placeMeasure);
    }
    placement() {
        const mm = this.view.plugin(minimapClass);
        const { thumb, minSlider } = this.view.state.facet(Config);
        const own = mm && mm.ownSlider(minSlider || 0);
        if (own) return own;
        if (!thumb) return null;
        const t = thumb(this.view);
        return { top: t.top, height: t.height, fromThumb: true };
    }
    // [dongminal] FR-ELS-63: 슬라이더 top(CSS px) → scrollTop. 자체 배치가 없으면 thumb 의 역이다.
    scrollFor(top) {
        const mm = this.view.plugin(minimapClass);
        const v = mm && mm.ownFromSlider(top);
        if (v != null) return v;
        const { fromThumb } = this.view.state.facet(Config);
        return fromThumb ? fromThumb(this.view, top) : null;
    }
    remove() {
        if (this.container) {
            this.container.removeEventListener("mousedown", this.onMouseDown);
            window.removeEventListener("mouseup", this.onMouseUp);
            window.removeEventListener("mousemove", this.onMouseMove);
            this.container.remove();
        }
    }
    update(update) {
        const prev = update.startState.facet(Config).enabled;
        const now = update.state.facet(Config).enabled;
        if (prev && !now) {
            this.remove();
            return;
        }
        if (!prev && now) {
            this.create(update.view);
        }
        if (now) {
            this.computeShowOverlay();
            if (update.geometryChanged || update.docChanged || update.heightChanged) {
                this.schedulePlace();
            }
        }
    }
    computeShowOverlay() {
        if (!this.container) {
            return;
        }
        const { showOverlay } = this.view.state.facet(Config);
        if (showOverlay === "mouse-over") {
            this.container.classList.add("cm-minimap-overlay-mouse-over");
        }
        else {
            this.container.classList.remove("cm-minimap-overlay-mouse-over");
        }
        const { clientHeight, scrollHeight } = this.view.scrollDOM;
        if (clientHeight === scrollHeight) {
            this.container.classList.add("cm-minimap-overlay-off");
        }
        else {
            this.container.classList.remove("cm-minimap-overlay-off");
        }
    }
    onMouseDown(event) {
        if (!this.container) {
            return;
        }
        // Ignore right click
        if (event.button === 2) {
            return;
        }
        // If target is the overlay start dragging
        const { clientY, target } = event;
        if (target === this.dom) {
            this._dragStartY = event.clientY;
            this._isDragging = true;
            this.container.classList.add("cm-minimap-overlay-active");
            return;
        }
        // [dongminal] FR-ELS-63: 누른 자리가 슬라이더 가운데가 되게 스크롤한다.
        const slider = this.placement();
        if (slider) {
            const y = clientY - target.getBoundingClientRect().top;
            const st = this.scrollFor(y - slider.height / 2);
            if (st != null) {
                this.view.scrollDOM.scrollTop = st;
                return;
            }
        }
        // Updates the scroll position of the EditorView based on the
        // position of the MouseEvent on the minimap canvas
        const { clientHeight, scrollHeight, scrollTop } = this.view.scrollDOM;
        const targetTop = target.getBoundingClientRect().top;
        const deltaY = (clientY - targetTop) * SCALE;
        const scrollRatio = scrollTop / (scrollHeight - clientHeight);
        const visibleRange = clientHeight * SCALE - clientHeight;
        const visibleTop = visibleRange * scrollRatio;
        const top = Math.max(0, scrollTop - visibleTop);
        this.view.scrollDOM.scrollTop = top + deltaY - clientHeight / 2;
    }
    onMouseUp(_event) {
        // Stop dragging on mouseup
        if (this._isDragging && this.container) {
            this._dragStartY = undefined;
            this._isDragging = false;
            this.container.classList.remove("cm-minimap-overlay-active");
        }
    }
    onMouseMove(event) {
        if (!this._isDragging || !this.dom) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        // Without an existing position, we're just beginning to drag.
        if (!this._dragStartY) {
            this._dragStartY = event.clientY;
            return;
        }
        const deltaY = event.clientY - this._dragStartY;
        // [dongminal] FR-ELS-63: 끈 만큼 슬라이더를 옮긴 자리로 스크롤한다.
        const slider = this.placement();
        if (slider) {
            const st = this.scrollFor(slider.top + deltaY);
            if (st != null) {
                this._dragStartY = event.clientY;
                this.view.scrollDOM.scrollTop = st;
                this.schedulePlace();
                return;
            }
        }
        const movingUp = deltaY < 0;
        const movingDown = deltaY > 0;
        // Update drag position for the next tick
        this._dragStartY = event.clientY;
        const canvasHeight = this.dom.getBoundingClientRect().height;
        const canvasAbsTop = this.dom.getBoundingClientRect().y;
        const canvasAbsBot = canvasAbsTop + canvasHeight;
        const canvasRelTopDouble = parseFloat(this.dom.style.top);
        const scrollPosition = this.view.scrollDOM.scrollTop;
        const editorHeight = this.view.scrollDOM.clientHeight;
        const contentHeight = this.view.scrollDOM.scrollHeight;
        const atTop = scrollPosition === 0;
        const atBottom = Math.round(scrollPosition) >= Math.round(contentHeight - editorHeight);
        // We allow over-dragging past the top/bottom, but the overlay just sticks
        // to the top or bottom of its range. These checks prevent us from immediately
        // moving the overlay when the drag changes direction. We should wait until
        // the cursor has returned to, and begun to pass the bottom/top of the range
        if ((atTop && movingUp) || (atTop && event.clientY < canvasAbsTop)) {
            return;
        }
        if ((atBottom && movingDown) ||
            (atBottom && event.clientY > canvasAbsBot)) {
            return;
        }
        // Set view scroll directly
        const scrollHeight = this.view.scrollDOM.scrollHeight;
        const clientHeight = this.view.scrollDOM.clientHeight;
        const maxTopNonOverflowing = (scrollHeight - clientHeight) / SCALE;
        const maxTopOverflowing = clientHeight - clientHeight / SCALE;
        const change = canvasRelTopDouble + deltaY;
        /**
         * ScrollPosOverflowing is calculated by:
         * - Calculating the offset (change) relative to the total height of the container
         * - Multiplying by the maximum scrollTop position for the scroller
         * - The maximum scrollTop position for the scroller is the total scroll height minus the client height
         */
        const relativeToMax = change / maxTopOverflowing;
        const scrollPosOverflowing = (scrollHeight - clientHeight) * relativeToMax;
        const scrollPosNonOverflowing = change * SCALE;
        this.view.scrollDOM.scrollTop = Math.max(scrollPosOverflowing, scrollPosNonOverflowing);
        // view.scrollDOM truncates if out of bounds. We need to mimic that behavior here with min/max guard
        const top = Math.min(Math.max(0, change), Math.min(maxTopOverflowing, maxTopNonOverflowing));
        this.dom.style.top = top + "px";
    }
    destroy() {
        this.remove();
    }
}, {
    eventHandlers: {
        scroll() {
            this.schedulePlace();
        },
    },
});
const Overlay = [Theme$1, OverlayView];

// TODO: renamed this file because something's weird with codemirror build
class LineBasedState {
    constructor(view) {
        this.map = new Map();
        this.view = view;
    }
    get(lineNumber) {
        return this.map.get(lineNumber);
    }
    set(lineNumber, value) {
        this.map.set(lineNumber, value);
    }
}

function computeLinesState(state) {
    var _a;
    if (!state.facet(Config).enabled) {
        return [];
    }
    const lines = [];
    const lineCursor = state.doc.iterLines();
    const foldedRangeCursor = foldedRanges(state).iter();
    let textOffset = 0;
    lineCursor.next();
    while (!lineCursor.done) {
        const lineText = lineCursor.value;
        let from = textOffset;
        let to = from + lineText.length;
        // Iterate through folded ranges until we're at or past the current line
        while (foldedRangeCursor.value && foldedRangeCursor.to < from) {
            foldedRangeCursor.next();
        }
        const { from: foldFrom, to: foldTo } = foldedRangeCursor;
        const lineStartInFold = from >= foldFrom && from < foldTo;
        const lineEndsInFold = to > foldFrom && to <= foldTo;
        if (lineStartInFold) {
            let lastLine = (_a = lines.pop()) !== null && _a !== void 0 ? _a : [];
            let lastRange = lastLine.pop();
            // If the last range is folded, we extend the folded range
            if (lastRange && lastRange.folded) {
                lastRange.to = foldTo;
            }
            // If we popped the last range, add it back
            if (lastRange) {
                lastLine.push(lastRange);
            }
            // If we didn't have a previous range, or the previous range wasn't folded add a new range
            if (!lastRange || !lastRange.folded) {
                lastLine.push({ from: foldFrom, to: foldTo, folded: true });
            }
            // If the line doesn't end in a fold, we add another token for the unfolded section
            if (!lineEndsInFold) {
                lastLine.push({ from: foldTo, to, folded: false });
            }
            lines.push(lastLine);
        }
        else if (lineEndsInFold) {
            lines.push([
                { from, to: foldFrom, folded: false },
                { from: foldFrom, to: foldTo, folded: true },
            ]);
        }
        else {
            lines.push([{ from, to, folded: false }]);
        }
        textOffset = to + 1;
        lineCursor.next();
    }
    return lines;
}
const LinesState = /*@__PURE__*/StateField.define({
    create: (state) => computeLinesState(state),
    update: (current, tr) => {
        if (foldsChanged([tr]) || tr.docChanged) {
            return computeLinesState(tr.state);
        }
        return current;
    },
});
/** Returns if the folds have changed in this update */
function foldsChanged(transactions) {
    return transactions.find((tr) => tr.effects.find((ef) => ef.is(foldEffect) || ef.is(unfoldEffect)));
}

class DiagnosticState extends LineBasedState {
    constructor(view) {
        super(view);
        this.count = undefined;
    }
    shouldUpdate(update) {
        // If the minimap is disabled
        if (!update.state.facet(Config).enabled) {
            return false;
        }
        // If the doc changed
        if (update.docChanged) {
            return true;
        }
        // If the diagnostics changed
        for (const tr of update.transactions) {
            for (const ef of tr.effects) {
                if (ef.is(setDiagnosticsEffect)) {
                    return true;
                }
            }
        }
        // If the folds changed
        if (foldsChanged(update.transactions)) {
            return true;
        }
        // If the minimap was previously hidden
        if (this.count === undefined) {
            return true;
        }
        return false;
    }
    update(update) {
        if (!this.shouldUpdate(update)) {
            return;
        }
        this.map.clear();
        const lines = update.state.field(LinesState);
        this.count = diagnosticCount(update.state);
        forEachDiagnostic(update.state, (diagnostic, from, to) => {
            // Find the start and end lines for the diagnostic
            const lineStart = this.findLine(from, lines);
            const lineEnd = this.findLine(to, lines);
            // Populate each line in the range with the highest severity diagnostic
            let severity = diagnostic.severity;
            for (let i = lineStart; i <= lineEnd; i++) {
                const previous = this.get(i);
                if (previous) {
                    severity = [severity, previous]
                        .sort(this.sort.bind(this))
                        .slice(0, 1)[0];
                }
                this.set(i, severity);
            }
        });
    }
    drawLine(ctx, lineNumber) {
        const { context, lineHeight, offsetX, offsetY } = ctx;
        const severity = this.get(lineNumber);
        if (!severity) {
            return;
        }
        // Draw the full line width rectangle in the background
        context.globalAlpha = 0.65;
        context.beginPath();
        context.rect(offsetX, offsetY /* TODO Scaling causes anti-aliasing in rectangles */, context.canvas.width - offsetX, lineHeight);
        context.fillStyle = this.color(severity);
        context.fill();
        // Draw diagnostic range rectangle in the foreground
        // TODO: We need to update the state to have specific ranges
        // context.globalAlpha = 1;
        // context.beginPath();
        // context.rect(offsetX, offsetY, textWidth, lineHeight);
        // context.fillStyle = this.color(severity);
        // context.fill();
    }
    /**
     * Given a position and a set of line ranges, return
     * the line number the position falls within
     */
    findLine(pos, lines) {
        const index = lines.findIndex((spans) => {
            const start = spans.slice(0, 1)[0];
            const end = spans.slice(-1)[0];
            if (!start || !end) {
                return false;
            }
            return start.from <= pos && pos <= end.to;
        });
        // Line numbers begin at 1
        return index + 1;
    }
    /**
     * Colors from @codemirror/lint
     * https://github.com/codemirror/lint/blob/e0671b43c02e72766ad1afe1579b7032fdcdb6c1/src/lint.ts#L597
     */
    color(severity) {
        return severity === "error"
            ? "#d11"
            : severity === "warning"
                ? "orange"
                : "#999";
    }
    /** Sorts severity from most to least severe */
    sort(a, b) {
        return this.score(b) - this.score(a);
    }
    /** Assigns a score to severity, with most severe being the highest */
    score(s) {
        switch (s) {
            case "error": {
                return 3;
            }
            case "warning": {
                return 2;
            }
            default: {
                return 1;
            }
        }
    }
}
function diagnostics(view) {
    return new DiagnosticState(view);
}

class SelectionState extends LineBasedState {
    constructor(view) {
        super(view);
        this.getDrawInfo();
        this._themeClasses = view.dom.classList.value;
    }
    shouldUpdate(update) {
        // If the minimap is disabled
        if (!update.state.facet(Config).enabled) {
            return false;
        }
        // If the doc changed
        if (update.docChanged) {
            return true;
        }
        // If the selection changed
        if (update.selectionSet) {
            return true;
        }
        // If the theme changed
        if (this._themeClasses !== this.view.dom.classList.value) {
            return true;
        }
        // If the folds changed
        if (foldsChanged(update.transactions)) {
            return true;
        }
        return false;
    }
    update(update) {
        if (!this.shouldUpdate(update)) {
            return;
        }
        this.map.clear();
        /* If class list has changed, clear and recalculate the selection style */
        if (this._themeClasses !== this.view.dom.classList.value) {
            this._drawInfo = undefined;
            this._themeClasses = this.view.dom.classList.value;
        }
        const { ranges } = update.state.selection;
        let selectionIndex = 0;
        for (const [index, line] of update.state.field(LinesState).entries()) {
            const selections = [];
            let offset = 0;
            for (const span of line) {
                do {
                    // We've already processed all selections
                    if (selectionIndex >= ranges.length) {
                        continue;
                    }
                    // The next selection begins after this span
                    if (span.to < ranges[selectionIndex].from) {
                        continue;
                    }
                    // Ignore 0-length selections
                    if (ranges[selectionIndex].from === ranges[selectionIndex].to) {
                        selectionIndex++;
                        continue;
                    }
                    // Build the selection for the current span
                    const range = ranges[selectionIndex];
                    const selection = {
                        from: offset + Math.max(span.from, range.from) - span.from,
                        to: offset + Math.min(span.to, range.to) - span.from,
                        extends: range.to > span.to,
                    };
                    const lastSelection = selections.slice(-1)[0];
                    if (lastSelection && lastSelection.to === selection.from) {
                        // The selection in this span may just be a continuation of the
                        // selection in the previous span
                        // Adjust `to` depending on if we're in a folded span
                        let { to } = selection;
                        if (span.folded && selection.extends) {
                            to = selection.from + 1;
                        }
                        else if (span.folded && !selection.extends) {
                            to = lastSelection.to;
                        }
                        selections[selections.length - 1] = Object.assign(Object.assign({}, lastSelection), { to, extends: selection.extends });
                    }
                    else if (!span.folded) {
                        // It's a new selection; if we're not in a folded span we
                        // should push it onto the stack
                        selections.push(selection);
                    }
                    // If the selection doesn't end in this span, break out of the loop
                    if (selection.extends) {
                        break;
                    }
                    // Otherwise, move to the next selection
                    selectionIndex++;
                } while (selectionIndex < ranges.length &&
                    span.to >= ranges[selectionIndex].from);
                offset += span.folded ? 1 : span.to - span.from;
            }
            // If we don't have any selections on this line, we don't need to store anything
            if (selections.length === 0) {
                continue;
            }
            // Lines are indexed beginning at 1 instead of 0
            const lineNumber = index + 1;
            this.map.set(lineNumber, selections);
        }
    }
    drawLine(ctx, lineNumber) {
        let { context, lineHeight, charWidth, offsetX: startOffsetX, offsetY, } = ctx;
        const selections = this.get(lineNumber);
        if (!selections) {
            return;
        }
        for (const selection of selections) {
            const offsetX = startOffsetX + selection.from * charWidth;
            const textWidth = (selection.to - selection.from) * charWidth;
            const fullWidth = context.canvas.width - offsetX;
            if (selection.extends) {
                // Draw the full width rectangle in the background
                context.globalAlpha = 0.65;
                context.beginPath();
                context.rect(offsetX, offsetY, fullWidth, lineHeight);
                context.fillStyle = this.getDrawInfo().backgroundColor;
                context.fill();
            }
            // Draw text selection rectangle in the foreground
            context.globalAlpha = 1;
            context.beginPath();
            context.rect(offsetX, offsetY, textWidth, lineHeight);
            context.fillStyle = this.getDrawInfo().backgroundColor;
            context.fill();
        }
    }
    getDrawInfo() {
        if (this._drawInfo) {
            return this._drawInfo;
        }
        // Create a mock selection
        const mockToken = document.createElement("span");
        mockToken.setAttribute("class", "cm-selectionBackground");
        this.view.dom.appendChild(mockToken);
        // Get style information
        const style = window.getComputedStyle(mockToken);
        const result = { backgroundColor: style.backgroundColor };
        // Store the result for the next update
        this._drawInfo = result;
        this.view.dom.removeChild(mockToken);
        return result;
    }
}
function selections(view) {
    return new SelectionState(view);
}

class TextState extends LineBasedState {
    constructor(view) {
        super(view);
        this._fontInfoMap = new Map();
        this._themeClasses = new Set(view.dom.classList.values());
        if (view.state.facet(Config).enabled) {
            this.updateImpl(view.state);
        }
    }
    shouldUpdate(update) {
        // If the doc changed
        if (update.docChanged) {
            return true;
        }
        // If configuration settings changed
        if (update.state.facet(Config) !== update.startState.facet(Config)) {
            return true;
        }
        // If the theme changed
        if (this.themeChanged()) {
            return true;
        }
        // If the folds changed
        if (foldsChanged(update.transactions)) {
            return true;
        }
        return false;
    }
    update(update) {
        if (!this.shouldUpdate(update)) {
            return;
        }
        if (this._highlightingCallbackId) {
            typeof window.requestIdleCallback !== "undefined"
                ? cancelIdleCallback(this._highlightingCallbackId)
                : clearTimeout(this._highlightingCallbackId);
        }
        this.updateImpl(update.state, update.changes);
    }
    updateImpl(state, changes) {
        var _a;
        this.map.clear();
        /* Store display text setting for rendering */
        this._displayText = state.facet(Config).displayText;
        /* If class list has changed, clear and recalculate the font info map */
        if (this.themeChanged()) {
            this._fontInfoMap.clear();
        }
        /* Incrementally parse the tree based on previous tree + changes */
        let treeFragments = undefined;
        if (this._previousTree && changes) {
            const previousFragments = TreeFragment.addTree(this._previousTree);
            const changedRanges = [];
            changes.iterChangedRanges((fromA, toA, fromB, toB) => changedRanges.push({ fromA, toA, fromB, toB }));
            treeFragments = TreeFragment.applyChanges(previousFragments, changedRanges);
        }
        /* Parse the document into a lezer tree */
        const docToString = state.doc.toString();
        const parser = (_a = state.facet(language)) === null || _a === void 0 ? void 0 : _a.parser;
        const tree = parser ? parser.parse(docToString, treeFragments) : undefined;
        this._previousTree = tree;
        /* Highlight the document, and store the text and tags for each line */
        const highlighter = {
            style: (tags) => highlightingFor(state, tags),
        };
        let highlights = [];
        if (tree) {
            /**
             * The viewport renders a few extra lines above and below the editor view. To approximate
             * the lines visible in the minimap, we multiply the lines in the viewport by the scale multipliers.
             *
             * Based on the current scroll position, the minimap may show a larger portion of lines above or
             * below the lines currently in the editor view. On a long document, when the scroll position is
             * near the top of the document, the minimap will show a small number of lines above the lines
             * in the editor view, and a large number of lines below the lines in the editor view.
             *
             * To approximate this ratio, we can use the viewport scroll percentage
             *
             * ┌─────────────────────┐
             * │                     │
             * │   Extra viewport    │
             * │   buffer            │
             * ├─────────────────────┼───────┐
             * │                     │Minimap│
             * │                     │Gutter │
             * │                     ├───────┤
             * │    Editor View      │Scaled │
             * │                     │View   │
             * │                     │Overlay│
             * │                     ├───────┤
             * │                     │       │
             * │                     │       │
             * ├─────────────────────┼───────┘
             * │                     │
             * │    Extra viewport   │
             * │    buffer           │
             * └─────────────────────┘
             *
             **/
            const vpLineTop = state.doc.lineAt(this.view.viewport.from).number;
            const vpLineBottom = state.doc.lineAt(this.view.viewport.to).number;
            const vpLineCount = vpLineBottom - vpLineTop;
            const vpScroll = vpLineTop / (state.doc.lines - vpLineCount);
            const { SizeRatio, PixelMultiplier } = Scale;
            const mmLineCount = vpLineCount * SizeRatio * PixelMultiplier;
            const mmLineRatio = vpScroll * mmLineCount;
            const mmLineTop = Math.max(1, Math.floor(vpLineTop - mmLineRatio));
            const mmLineBottom = Math.min(vpLineBottom + Math.floor(mmLineCount - mmLineRatio), state.doc.lines);
            // Highlight the in-view lines synchronously
            highlightTree(tree, highlighter, (from, to, tags) => {
                highlights.push({ from, to, tags });
            }, state.doc.line(mmLineTop).from, state.doc.line(mmLineBottom).to);
        }
        // Update the map
        this.updateMapImpl(state, highlights);
        // Highlight the entire tree in an idle callback
        highlights = [];
        const highlightingCallback = () => {
            if (tree) {
                highlightTree(tree, highlighter, (from, to, tags) => {
                    highlights.push({ from, to, tags });
                });
                this.updateMapImpl(state, highlights);
                this._highlightingCallbackId = undefined;
                // [dongminal] 스크롤로 다시 그리지 않으므로 강조가 끝나면 그린다 (FR-ELS-54).
                if (this.onHighlighted) this.onHighlighted();
            }
        };
        this._highlightingCallbackId =
            typeof window.requestIdleCallback !== "undefined"
                ? requestIdleCallback(highlightingCallback)
                : setTimeout(highlightingCallback);
    }
    updateMapImpl(state, highlights) {
        this.map.clear();
        const docToString = state.doc.toString();
        const highlightsIterator = highlights.values();
        let highlightPtr = highlightsIterator.next();
        for (const [index, line] of state.field(LinesState).entries()) {
            const spans = [];
            for (const span of line) {
                // Skip if it's a 0-length span
                if (span.from === span.to) {
                    continue;
                }
                // Append a placeholder for a folded span
                if (span.folded) {
                    spans.push({ text: "…", tags: "" });
                    continue;
                }
                let position = span.from;
                while (!highlightPtr.done && highlightPtr.value.from < span.to) {
                    const { from, to, tags } = highlightPtr.value;
                    // Iterate until our highlight is over the current span
                    if (to < position) {
                        highlightPtr = highlightsIterator.next();
                        continue;
                    }
                    // Append unstyled text before the highlight begins
                    if (from > position) {
                        spans.push({ text: docToString.slice(position, from), tags: "" });
                    }
                    // A highlight may start before and extend beyond the current span
                    const start = Math.max(from, span.from);
                    const end = Math.min(to, span.to);
                    // Append the highlighted text
                    spans.push({ text: docToString.slice(start, end), tags });
                    position = end;
                    // If the highlight continues beyond this span, break from this loop
                    if (to > end) {
                        break;
                    }
                    // Otherwise, move to the next highlight
                    highlightPtr = highlightsIterator.next();
                }
                // If there are remaining spans that did not get highlighted, append them unstyled
                if (position !== span.to) {
                    spans.push({
                        text: docToString.slice(position, span.to),
                        tags: "",
                    });
                }
            }
            // Lines are indexed beginning at 1 instead of 0
            const lineNumber = index + 1;
            this.map.set(lineNumber, spans);
        }
    }
    measure(context) {
        const { color, font, lineHeight } = this.getFontInfo("");
        context.textBaseline = "ideographic";
        context.fillStyle = color;
        context.font = font;
        return {
            charWidth: context.measureText("_").width,
            lineHeight: lineHeight,
        };
    }
    beforeDraw() {
        this._fontInfoMap.clear(); // TODO: Confirm this worked for theme changes or get rid of it because it's slow
    }
    drawLine(ctx, lineNumber) {
        const line = this.get(lineNumber);
        if (!line) {
            return;
        }
        let { context, charWidth, lineHeight, offsetX, offsetY } = ctx;
        let prevInfo;
        context.textBaseline = "ideographic";
        for (const span of line) {
            const info = this.getFontInfo(span.tags);
            if (!prevInfo || prevInfo.color !== info.color) {
                context.fillStyle = info.color;
            }
            if (!prevInfo || prevInfo.font !== info.font) {
                context.font = info.font;
            }
            prevInfo = info;
            lineHeight = Math.max(lineHeight, info.lineHeight);
            switch (this._displayText) {
                case "characters": {
                    // TODO: `fillText` takes up the majority of profiling time in `render`
                    // Try speeding it up with `drawImage`
                    // https://stackoverflow.com/questions/8237030/html5-canvas-faster-filltext-vs-drawimage/8237081
                    context.fillText(span.text, offsetX, offsetY + lineHeight);
                    offsetX += span.text.length * charWidth;
                    break;
                }
                case "blocks": {
                    const nonWhitespace = /\S+/g;
                    let start;
                    while ((start = nonWhitespace.exec(span.text)) !== null) {
                        const startX = offsetX + start.index * charWidth;
                        let width = (nonWhitespace.lastIndex - start.index) * charWidth;
                        // Reached the edge of the minimap
                        if (startX > context.canvas.width) {
                            break;
                        }
                        // Limit width to edge of minimap
                        if (startX + width > context.canvas.width) {
                            width = context.canvas.width - startX;
                        }
                        // Scaled 2px buffer between lines
                        const yBuffer = 2 / Scale.SizeRatio;
                        const height = lineHeight - yBuffer;
                        context.fillStyle = info.color;
                        context.globalAlpha = 0.65; // Make the blocks a bit faded
                        context.beginPath();
                        context.rect(startX, offsetY, width, height);
                        context.fill();
                    }
                    offsetX += span.text.length * charWidth;
                    break;
                }
            }
        }
    }
    getFontInfo(tags) {
        const cached = this._fontInfoMap.get(tags);
        if (cached) {
            return cached;
        }
        // Create a mock token wrapped in a cm-line
        const mockToken = crelt("span", { class: tags });
        const mockLine = crelt("div", { class: "cm-line", style: "display: none" }, mockToken);
        this.view.contentDOM.appendChild(mockLine);
        // Get style information and store it
        const style = window.getComputedStyle(mockToken);
        const lineHeight = parseFloat(style.lineHeight) / Scale.SizeRatio;
        const result = {
            color: style.color,
            font: `${style.fontStyle} ${style.fontWeight} ${lineHeight}px ${style.fontFamily}`,
            lineHeight,
        };
        this._fontInfoMap.set(tags, result);
        // Clean up and return
        this.view.contentDOM.removeChild(mockLine);
        return result;
    }
    themeChanged() {
        const previous = this._themeClasses;
        const now = new Set(this.view.dom.classList.values());
        this._themeClasses = now;
        if (!previous) {
            return true;
        }
        // Ignore certain classes being added/removed
        previous.delete("cm-focused");
        now.delete("cm-focused");
        if (previous.size !== now.size) {
            return true;
        }
        let containsAll = true;
        previous.forEach((theme) => {
            if (!now.has(theme)) {
                containsAll = false;
            }
        });
        return !containsAll;
    }
}
function text(view) {
    return new TextState(view);
}

const GUTTER_WIDTH = 4;
// [dongminal] EDITOR_LINK_LSP_SRS FR-ELS-60: 동아시아 넓은 글자 — 2칸으로 센다.
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
/** [dongminal] FR-ELS-60: 줄마다의 칸 수 — 넓은 글자 2칸, 탭은 다음 멈춤까지, 접힌 구간 1칸. */
function lineColumns(state, lines) {
    const tab = state.tabSize;
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
        let col = 0;
        for (const span of lines[i]) {
            if (span.folded) {
                col += 1;
                continue;
            }
            for (const ch of state.doc.sliceString(span.from, span.to)) {
                if (ch === "\t") col += tab - (col % tab);
                else col += WIDE_CHAR.test(ch) ? 2 : 1;
            }
        }
        out[i] = col;
    }
    return out;
}
/** [dongminal] FR-ELS-60: 화면 줄 수의 누적 — `acc[i]` 는 줄 i 앞까지의 화면 줄 수다. */
function visualAccum(cols, wrapCols) {
    const acc = new Float64Array(cols.length + 1);
    for (let i = 0; i < cols.length; i++) {
        acc[i + 1] = acc[i] + (wrapCols ? Math.max(1, Math.ceil(cols[i] / wrapCols)) : 1);
    }
    return acc;
}
/** [dongminal] 누적에서 화면 줄 `v` 를 품은 줄 번호 (0 부터). */
function accLineAt(acc, v) {
    let lo = 0, hi = acc.length - 2;
    if (hi < 0) return 0;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (acc[mid] <= v) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/** [dongminal] `pos` 를 품은 줄(LinesState)의 번호 — 첫 span 의 from 이 `pos` 이하인 마지막 줄. */
function lineIndexAt(lines, pos) {
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid][0].from <= pos) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}
/**
 * Draws a gutter to the canvas context for the given line number
 */
function drawLineGutter(gutter, ctx, lineNumber) {
    const color = gutter[lineNumber];
    if (!color) {
        return;
    }
    ctx.context.fillStyle = color;
    ctx.context.globalAlpha = 1;
    ctx.context.beginPath();
    ctx.context.rect(ctx.offsetX, ctx.offsetY, GUTTER_WIDTH, ctx.lineHeight);
    ctx.context.fill();
}

const Theme = /*@__PURE__*/EditorView.theme({
    "&": {
        height: "100%",
        overflowY: "auto",
    },
    "& .cm-minimap-gutter": {
        borderRight: 0,
        flexShrink: 0,
        left: "unset",
        position: "sticky",
        right: 0,
        top: 0,
    },
    "& .cm-minimap-inner": {
        height: "100%",
        position: "absolute",
        right: 0,
        top: 0,
        overflowY: "hidden",
        "& canvas": {
            display: "block",
        },
    },
    "& .cm-minimap-box-shadow": {
        boxShadow: "12px 0px 20px 5px #6c6c6c",
    },
});
const WIDTH_RATIO = 6;
const minimapClass = /*@__PURE__*/ViewPlugin.fromClass(class {
    constructor(view) {
        this.view = view;
        this.text = text(view);
        // 강조가 끝나면 줄 위치가 같아도 색이 바뀌었다 — 지문을 건너뛰고 그린다.
        this.text.onHighlighted = () => { this._forceRender = true; this.scheduleRender(); };
        this.renderMeasure = { key: this, read: () => this.layout(), write: (m) => this.render(m) };
        this.selection = selections(view);
        this.diagnostic = diagnostics(view);
        if (view.state.facet(showMinimap)) {
            this.create(view);
        }
    }
    create(view) {
        const config = view.state.facet(showMinimap);
        if (!config) {
            throw Error("Expected nonnull");
        }
        this.inner = crelt("div", { class: "cm-minimap-inner" });
        this.canvas = crelt("canvas");
        this.dom = config.create(view).dom;
        this.dom.classList.add("cm-gutters");
        this.dom.classList.add("cm-minimap-gutter");
        this.inner.appendChild(this.canvas);
        this.dom.appendChild(this.inner);
        // For now let's keep this same behavior. We might want to change
        // this in the future and have the extension figure out how to mount.
        // Or expose some more generic right gutter api and use that
        this.view.scrollDOM.insertBefore(this.dom, this.view.contentDOM.nextSibling);
        for (const key in this.view.state.facet(Config).eventHandlers) {
            const handler = this.view.state.facet(Config).eventHandlers[key];
            if (handler) {
                this.dom.addEventListener(key, (e) => handler(e, this.view));
            }
        }
        // [dongminal] FR-ELS-58: 처음 설 때 곧바로 그린다 — 스크롤 같은 다음 갱신을 기다리지 않는다.
        this.scheduleRender();
    }
    remove() {
        if (this.dom) {
            this.dom.remove();
        }
    }
    update(update) {
        const prev = update.startState.facet(showMinimap);
        const now = update.state.facet(showMinimap);
        if (prev && !now) {
            this.remove();
            return;
        }
        if (!prev && now) {
            this.create(update.view);
        }
        if (now) {
            this.text.update(update);
            this.selection.update(update);
            this.diagnostic.update(update);
            // [dongminal] FR-ELS-54: 스크롤만 한 갱신은 내용을 다시 그리지 않는다. 그리기는 줄 블록의 자리를
            // 읽으므로 갱신 안이 아니라 측정 단계에서 한다.
            if (!prev || update.docChanged || update.selectionSet || update.geometryChanged || update.heightChanged
                || update.transactions.length) {
                this.scheduleRender();
            }
        }
    }
    scheduleRender() {
        this.view.requestMeasure(this.renderMeasure);
    }
    getWidth() {
        const editorWidth = this.view.dom.clientWidth;
        if (editorWidth <= Scale.MaxWidth * WIDTH_RATIO) {
            const ratio = editorWidth / (Scale.MaxWidth * WIDTH_RATIO);
            return Scale.MaxWidth * ratio;
        }
        return Scale.MaxWidth;
    }
    /**
     * [dongminal] EDITOR_LINK_LSP_SRS FR-ELS-60·65: 미니맵 자체 배치 — 문서 내용과 편집기 폭으로만 정한다. 칸 수는 문서(LinesState)가
     * 바뀔 때만, 누적은 칸 수 · 한 줄 칸 수가 바뀔 때만 다시 센다. 레이아웃을 읽으므로 측정의 read 단계에서 부른다.
     */
    ownLayout() {
        const view = this.view;
        const lines = view.state.field(LinesState);
        const c = this._ownCache || (this._ownCache = {});
        if (c.lines !== lines || c.tab !== view.state.tabSize) {
            c.lines = lines;
            c.tab = view.state.tabSize;
            c.cols = lineColumns(view.state, lines);
            c.acc = null;
        }
        let wrapCols = 0;
        if (view.lineWrapping) {
            const line = view.contentDOM.querySelector(".cm-line");
            const st = line ? getComputedStyle(line) : null;
            const pad = st ? (parseFloat(st.paddingLeft) || 0) + (parseFloat(st.paddingRight) || 0) : 0;
            wrapCols = Math.max(1, Math.floor((view.contentDOM.clientWidth - pad) / Math.max(1, view.defaultCharacterWidth)));
        }
        if (!c.acc || c.wrapCols !== wrapCols) {
            c.wrapCols = wrapCols;
            c.acc = visualAccum(c.cols, wrapCols);
        }
        const acc = c.acc;
        const lh = view.defaultLineHeight;
        const { top: pTop, bottom: pBottom } = view.documentPadding;
        const total = pTop + acc[acc.length - 1] * lh + pBottom;
        return {
            lines, acc, lh, pTop, total,
            denom: Math.max(total, view.scrollDOM.clientHeight),
            top: (i) => pTop + acc[i] * lh,
            height: (i) => (acc[i + 1] - acc[i]) * lh,
        };
    }
    /**
     * [dongminal] FR-ELS-62: 슬라이더 — 보이는 첫 줄 · 끝 줄(CM 이 실측했다)을 자체 배치의 같은 줄 · 같은 비율 자리에 놓는다.
     * CSS px `{top, height}`. 자체 배치가 아직 없으면 null 이다. 업데이트 안에서 부르지 않는다.
     */
    ownSlider(min) {
        const own = this._own;
        const view = this.view;
        if (!own || !own.lines.length) return null;
        const { scrollTop, clientHeight } = view.scrollDOM;
        const kcss = clientHeight / Math.max(1, own.denom);
        const at = (y) => {
            const d = y - own.pTop;
            if (d <= 0) return Math.max(0, y);
            const b = view.lineBlockAtHeight(d);
            const i = lineIndexAt(own.lines, b.from);
            if (d >= b.bottom && b.to >= view.state.doc.length) return own.top(i) + own.height(i) + Math.min(view.documentPadding.bottom, d - b.bottom);
            const f = b.height > 0 ? Math.min(1, Math.max(0, (d - b.top) / b.height)) : 0;
            return own.top(i) + f * own.height(i);
        };
        let top = at(scrollTop) * kcss;
        let height = Math.max(0, at(scrollTop + clientHeight) * kcss - top);
        if (height < min) {
            top = Math.max(0, Math.min(clientHeight - min, top - (min - height) / 2));
            height = min;
        }
        return { top, height };
    }
    /** [dongminal] FR-ELS-63: 슬라이더 top(CSS px) → scrollTop. FR-ELS-62 의 역이다. */
    ownFromSlider(topCss) {
        const own = this._own;
        const view = this.view;
        if (!own || !own.lines.length) return null;
        const y = topCss / (view.scrollDOM.clientHeight / Math.max(1, own.denom));
        if (y <= own.pTop) return Math.max(0, y);
        const i = accLineAt(own.acc, (y - own.pTop) / own.lh);
        const f = own.height(i) > 0 ? Math.min(1, Math.max(0, (y - own.top(i)) / own.height(i))) : 0;
        const b = view.lineBlockAt(own.lines[i][0].from);
        return own.pTop + b.top + f * b.height;
    }
    /**
     * [dongminal] EDITOR_LINK_LSP_SRS FR-ELS-50~53: 그릴 줄의 자리(장치 px). 문서 전체를 스크롤 높이 비율로 놓는다 —
     * 스크롤바 thumb 와 같은 비율이므로 슬라이더의 양 끝이 곧 보이는 영역이다. 한 픽셀 행에는 그 행의 첫 줄만 둔다.
     * 줄 블록을 읽으므로 측정의 read 단계에서 부른다.
     */
    layout() {
        const view = this.view;
        const lines = view.state.field(LinesState);
        const own = this.ownLayout();
        const height = view.scrollDOM.clientHeight * Scale.PixelMultiplier;
        const k = height / Math.max(1, own.denom);
        const boxOf = (i) => ({ y: own.top(i) * k, h: own.height(i) * k });
        // FR-ELS-60·53: 줄 위치는 자체 배치에서 얻는다 — CM 의 높이표(줄바꿈이 켜지면 추정이 섞인다)를 쓰지 않으므로 스크롤로
        // 바뀌지 않는다. 다음 줄은 이 줄과 다른 픽셀 행에서 시작하는 첫 줄이다 — 그리는 줄 수는 캔버스 행 수를 넘지 않는다.
        const rows = [];
        let i = 0;
        while (i < lines.length) {
            const box = boxOf(i);
            if (box.y >= height) {
                break;
            }
            rows.push({ i, y: box.y, h: box.h });
            const next = Math.floor(box.y) + 1;
            const j = accLineAt(own.acc, (next / k - own.pTop) / own.lh);
            i = Math.max(i + 1, own.top(j) * k >= next ? j : j + 1);
        }
        const cfg = view.state.facet(Config);
        const marks = cfg.marks ? cfg.marks(view.state) : [];
        const gutter = cfg.gutter ? cfg.gutter(view.state) : [];
        const boxes = new Map();
        for (const m of [...marks, ...gutter]) {
            if (m.line >= 1 && m.line <= lines.length && !boxes.has(m.line)) boxes.set(m.line, boxOf(m.line - 1));
        }
        this._own = own;
        // [dongminal] FR-ELS-54: 그릴 결과의 지문. 지난번과 같으면 그리지 않는다 — 스크롤로 새 줄이 들어오면 CM 이
        // 높이가 그대로여도 geometry·height 신호를 내므로, 신호가 아니라 결과로 판정한다.
        const sig = JSON.stringify([
            rows.map((r) => [r.i, Math.round(r.y * 8), Math.round(r.h * 8)]),
            marks, gutter, view.state.selection.toJSON(), view.dom.className, view.dom.clientWidth,
            [...this.diagnostic.map],
        ]);
        const skip = !this._forceRender && view.state.doc === this._drawnDoc && sig === this._drawnSig;
        return { rows, marks, gutter, boxes, sig, skip };
    }
    render(m) {
        // If we don't have elements to draw to exit early
        if (!this.dom || !this.canvas || !this.inner || m.skip) {
            return;
        }
        this._forceRender = false;
        this._drawnSig = m.sig;
        const ov = this.view.plugin(OverlayView);
        if (ov) ov.schedulePlace();
        this._drawnDoc = this.view.state.doc;
        this.text.beforeDraw();
        this.updateBoxShadow();
        this.dom.style.width = this.getWidth() + "px";
        this.canvas.style.maxWidth = this.getWidth() + "px";
        this.canvas.width = this.getWidth() * Scale.PixelMultiplier;
        // [dongminal] 높이는 스크롤 영역의 것이다. 편집기 상자(소수 높이)를 쓰면 문서 끝에서 sticky 가 덜 붙어
        // 뷰포트 표시가 스크롤바 thumb 보다 반 픽셀 위에 선다.
        const domHeight = this.view.scrollDOM.clientHeight;
        this.inner.style.minHeight = domHeight + "px";
        this.canvas.height = domHeight * Scale.PixelMultiplier;
        this.canvas.style.height = domHeight + "px";
        const context = this.canvas.getContext("2d");
        if (!context) {
            return;
        }
        context.clearRect(0, 0, this.canvas.width, this.canvas.height);
        /* We need to get the correct font dimensions before this to measure characters */
        const { charWidth, lineHeight } = this.text.measure(context);
        // [dongminal] 줄 표식 층. 받은 것 전부를 남긴다 — 화면 밖 줄도 스크롤하면 그려진다.
        const cfg = this.view.state.facet(Config);
        const css = getComputedStyle(this.view.dom);
        const color = (c) => (c && c.startsWith("--") ? css.getPropertyValue(c).trim() : c);
        this.drawnMarks = m.marks;
        this.drawnGutter = m.gutter;
        const dynGutter = {};
        for (const g of this.drawnGutter) dynGutter[g.line] = color(g.color);
        const gutterX = cfg.gutters.length || this.drawnGutter.length ? 2 + (cfg.gutters.length + (this.drawnGutter.length ? 1 : 0)) * GUTTER_WIDTH + 2 : 0;
        this.drawnRows = [];
        for (const { i, y, h } of m.rows) {
            const dc = { offsetX: 0, offsetY: y, context, lineHeight: h, charWidth };
            if (cfg.gutters.length) {
                dc.offsetX += 2;
                for (const gutter of cfg.gutters) {
                    drawLineGutter(gutter, dc, i + 1);
                    dc.offsetX += GUTTER_WIDTH;
                }
            }
            dc.offsetX = gutterX;
            // FR-ELS-52: 글자는 늘이지 않는다. 줄이 기본보다 낮으면 그 높이로 줄인다.
            context.save();
            context.translate(0, y);
            context.scale(1, Math.min(1, h / lineHeight));
            this.text.drawLine(Object.assign(Object.assign({}, dc), { offsetY: 0, lineHeight }), i + 1);
            context.restore();
            this.selection.drawLine(dc, i + 1);
            this.diagnostic.drawLine(dc, i + 1);
            this.drawnRows.push({ line: i + 1, y: y / Scale.PixelMultiplier, h: h / Scale.PixelMultiplier });
        }
        // 표식은 행에 겹쳐 빠진 줄도 그 줄의 자리에 그린다.
        const markAt = new Map();
        for (const mk of this.drawnMarks) markAt.set(mk.line, color(mk.color));
        for (const [line, c] of markAt) {
            const box = m.boxes.get(line);
            if (!box) continue;
            context.save();
            context.globalAlpha = 0.6;
            context.fillStyle = c;
            context.fillRect(gutterX, box.y, this.canvas.width - gutterX, Math.max(1, box.h));
            context.restore();
        }
        const gx = 2 + cfg.gutters.length * GUTTER_WIDTH;
        for (const g of this.drawnGutter) {
            const box = m.boxes.get(g.line);
            if (!box) continue;
            drawLineGutter(dynGutter, { offsetX: gx, offsetY: box.y, context, lineHeight: Math.max(1, box.h), charWidth }, g.line);
        }
        context.restore();
    }
    updateBoxShadow() {
        if (!this.canvas) {
            return;
        }
        const { clientWidth, scrollWidth, scrollLeft } = this.view.scrollDOM;
        if (clientWidth + scrollLeft < scrollWidth) {
            this.canvas.classList.add("cm-minimap-box-shadow");
        }
        else {
            this.canvas.classList.remove("cm-minimap-box-shadow");
        }
    }
    destroy() {
        this.remove();
    }
}, {
    eventHandlers: {
        // [dongminal] FR-ELS-54: 미니맵 내용은 스크롤되지 않는다 — 가로 그림자만 고친다.
        scroll() {
            requestAnimationFrame(() => this.updateBoxShadow());
        },
    },
    provide: (plugin) => {
        return EditorView.scrollMargins.of((view) => {
            var _a;
            const width = (_a = view.plugin(plugin)) === null || _a === void 0 ? void 0 : _a.getWidth();
            if (!width) {
                return null;
            }
            return { right: width };
        });
    },
});
/**
 * Facet used to show a minimap in the right gutter of the editor using the
 * provided configuration.
 *
 * If you return `null`, a minimap will not be shown.
 */
const showMinimap = /*@__PURE__*/Facet.define({
    combine: (c) => { var _a; return (_a = c.find((o) => o !== null)) !== null && _a !== void 0 ? _a : null; },
    enables: (f) => {
        return [
            [
                Config.compute([f], (s) => s.facet(f)),
                Theme,
                LinesState,
                minimapClass,
                Overlay,
            ],
        ];
    },
});

/**
 * [dongminal] 미니맵이 받은 줄 표식과 그린 줄의 자리 — `{marks, gutter, rows}` (rows 는 CSS px, FR-ELS-56).
 * 미니맵이 없으면 `null` 이다.
 */
function minimapDrawn(view) {
    const p = view.plugin(minimapClass);
    if (!p || !p.dom) {
        return null;
    }
    return { marks: p.drawnMarks || [], gutter: p.drawnGutter || [], rows: p.drawnRows || [] };
}

/**
 * [dongminal] EDITOR_LINK_LSP_SRS FR-ELS-64: 미니맵 배치(FR-ELS-60)의 좌표 — 편집기 스크롤바가 같은 좌표를 쓴다.
 * 미니맵이 없거나 꺼져 있거나 줄이 없으면 `null` 이다. 레이아웃을 읽으므로 측정의 read 단계나 이벤트 처리에서 부른다.
 *
 *   slider()        FR-ELS-62 의 슬라이더 `{top, height}` (CSS px, 스크롤 영역 기준)
 *   fromSlider(top) FR-ELS-63 — 슬라이더 top → scrollTop
 *   posTop(pos)     문서 위치가 든 줄의 top (CSS px)
 *   posBottom(pos)  그 줄의 bottom
 */
function minimapScale(view) {
    const p = view.plugin(minimapClass);
    const cfg = view.state.facet(Config);
    if (!p || !p.dom || !cfg.enabled) {
        return null;
    }
    const own = p.ownLayout();
    if (!own || !own.lines.length) {
        return null;
    }
    p._own = own;
    const k = view.scrollDOM.clientHeight / Math.max(1, own.denom);
    const at = (pos) => lineIndexAt(own.lines, pos);
    return {
        slider: () => p.ownSlider(cfg.minSlider || 0),
        fromSlider: (top) => p.ownFromSlider(top),
        posTop: (pos) => own.top(at(pos)) * k,
        posBottom: (pos) => {
            const i = at(pos);
            return (own.top(i) + own.height(i)) * k;
        },
    };
}

export { showMinimap, minimapDrawn, minimapScale };
