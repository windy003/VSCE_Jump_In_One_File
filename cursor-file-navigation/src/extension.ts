import * as vscode from 'vscode';

// ── constants ────────────────────────────────────────────────────────────────

/** Maximum positions kept per file. */
const MAX_HISTORY = 100;

/**
 * Minimum line distance between two recorded positions.
 * Moves smaller than this update the current entry instead of adding a new one,
 * so that slow typing/arrow-key movement doesn't flood the history.
 */
const MIN_LINE_DISTANCE = 3;

/**
 * After the cursor stops moving for this many ms the current position is
 * "committed" to the history stack.
 */
const DEBOUNCE_MS = 600;

// ── history data structure ───────────────────────────────────────────────────

interface CursorPos {
    line: number;
    character: number;
}

class FileHistory {
    private stack: CursorPos[] = [];
    /** Points at the position the user is currently "at" in the history. */
    private pointer = -1;

    get current(): CursorPos | undefined {
        return this.pointer >= 0 ? this.stack[this.pointer] : undefined;
    }

    /**
     * Record a new position.
     * - If the new position is close to the current one, just update in-place.
     * - Otherwise truncate forward history and append.
     */
    push(pos: CursorPos): void {
        if (this.pointer >= 0) {
            const cur = this.stack[this.pointer];
            if (Math.abs(cur.line - pos.line) < MIN_LINE_DISTANCE) {
                // Too close — update in-place so tiny edits don't pile up.
                this.stack[this.pointer] = pos;
                return;
            }
        }

        // Drop any forward history that existed beyond the current pointer.
        this.stack = this.stack.slice(0, this.pointer + 1);
        this.stack.push(pos);

        if (this.stack.length > MAX_HISTORY) {
            this.stack.shift();
        }
        this.pointer = this.stack.length - 1;
    }

    back(): CursorPos | null {
        if (this.pointer > 0) {
            this.pointer--;
            return this.stack[this.pointer];
        }
        return null;
    }

    forward(): CursorPos | null {
        if (this.pointer < this.stack.length - 1) {
            this.pointer++;
            return this.stack[this.pointer];
        }
        return null;
    }

    canGoBack(): boolean  { return this.pointer > 0; }
    canGoForward(): boolean { return this.pointer < this.stack.length - 1; }
}

// ── extension state ──────────────────────────────────────────────────────────

/** One history per document URI. */
const histories = new Map<string, FileHistory>();

/**
 * Set to `true` while we are programmatically moving the cursor so that the
 * selection-change listener does not record the navigation jump itself.
 */
let isNavigating = false;

/** Per-document debounce timer handles. */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── helpers ──────────────────────────────────────────────────────────────────

function getHistory(uri: string): FileHistory {
    let h = histories.get(uri);
    if (!h) {
        h = new FileHistory();
        histories.set(uri, h);
    }
    return h;
}

function scheduleRecord(editor: vscode.TextEditor): void {
    const key = editor.document.uri.toString();

    const existing = debounceTimers.get(key);
    if (existing !== undefined) {
        clearTimeout(existing);
    }

    const timer = setTimeout(() => {
        debounceTimers.delete(key);
        if (isNavigating) { return; }

        const active = vscode.window.activeTextEditor;
        if (!active || active.document.uri.toString() !== key) { return; }

        const pos: CursorPos = {
            line: active.selection.active.line,
            character: active.selection.active.character,
        };
        getHistory(key).push(pos);
    }, DEBOUNCE_MS);

    debounceTimers.set(key, timer);
}

function moveTo(editor: vscode.TextEditor, pos: CursorPos): void {
    const position = new vscode.Position(pos.line, pos.character);
    const selection = new vscode.Selection(position, position);
    editor.selection = selection;
    editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
}

// ── activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {

    // Record cursor position whenever it changes (debounced).
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (isNavigating) { return; }
            // Only track cursor moves, not drag-selections.
            if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse ||
                event.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
                event.kind === vscode.TextEditorSelectionChangeKind.Command ||
                event.kind === undefined) {
                scheduleRecord(event.textEditor);
            }
        })
    );

    // Seed history when a new editor becomes active.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor || isNavigating) { return; }
            const key = editor.document.uri.toString();
            const h = getHistory(key);
            // If we've never seen this file, record the initial position.
            if (!h.current) {
                h.push({
                    line: editor.selection.active.line,
                    character: editor.selection.active.character,
                });
            }
        })
    );

    // Clean up history for closed documents to avoid memory leaks.
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();
            histories.delete(key);
            const t = debounceTimers.get(key);
            if (t !== undefined) {
                clearTimeout(t);
                debounceTimers.delete(key);
            }
        })
    );

    // ── commands ─────────────────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('cursorFileNav.back', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }

            const key = editor.document.uri.toString();

            // Flush any pending debounced record first so the current position
            // is in the stack before we navigate away from it.
            const timer = debounceTimers.get(key);
            if (timer !== undefined) {
                clearTimeout(timer);
                debounceTimers.delete(key);
                getHistory(key).push({
                    line: editor.selection.active.line,
                    character: editor.selection.active.character,
                });
            }

            const target = getHistory(key).back();
            if (!target) {
                vscode.window.setStatusBarMessage('$(arrow-left) No earlier position in this file', 2000);
                return;
            }

            isNavigating = true;
            moveTo(editor, target);
            // Use setImmediate so the selection-change event fires before we
            // reset the flag.
            setImmediate(() => { isNavigating = false; });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cursorFileNav.forward', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }

            const target = getHistory(editor.document.uri.toString()).forward();
            if (!target) {
                vscode.window.setStatusBarMessage('$(arrow-right) No later position in this file', 2000);
                return;
            }

            isNavigating = true;
            moveTo(editor, target);
            setImmediate(() => { isNavigating = false; });
        })
    );

    // Seed history for the editor that is already open at activation time.
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        getHistory(editor.document.uri.toString()).push({
            line: editor.selection.active.line,
            character: editor.selection.active.character,
        });
    }
}

export function deactivate(): void {
    debounceTimers.forEach(t => clearTimeout(t));
    debounceTimers.clear();
    histories.clear();
}
