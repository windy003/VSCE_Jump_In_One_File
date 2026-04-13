'use strict';

const vscode = require('vscode');

const MAX_HISTORY = 100;
const MIN_LINE_DISTANCE = 3;
const DEBOUNCE_MS = 600;

class FileHistory {
    constructor() {
        this.stack = [];
        this.pointer = -1;
    }

    get current() {
        return this.pointer >= 0 ? this.stack[this.pointer] : undefined;
    }

    push(pos) {
        if (this.pointer >= 0) {
            const cur = this.stack[this.pointer];
            if (Math.abs(cur.line - pos.line) < MIN_LINE_DISTANCE) {
                this.stack[this.pointer] = pos;
                return;
            }
        }
        this.stack = this.stack.slice(0, this.pointer + 1);
        this.stack.push(pos);
        if (this.stack.length > MAX_HISTORY) {
            this.stack.shift();
        }
        this.pointer = this.stack.length - 1;
    }

    back() {
        if (this.pointer > 0) {
            this.pointer--;
            return this.stack[this.pointer];
        }
        return null;
    }

    forward() {
        if (this.pointer < this.stack.length - 1) {
            this.pointer++;
            return this.stack[this.pointer];
        }
        return null;
    }
}

const histories = new Map();
let isNavigating = false;
const debounceTimers = new Map();

function getHistory(uri) {
    let h = histories.get(uri);
    if (!h) {
        h = new FileHistory();
        histories.set(uri, h);
    }
    return h;
}

function scheduleRecord(editor) {
    const key = editor.document.uri.toString();
    const existing = debounceTimers.get(key);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
        debounceTimers.delete(key);
        if (isNavigating) return;
        const active = vscode.window.activeTextEditor;
        if (!active || active.document.uri.toString() !== key) return;
        getHistory(key).push({
            line: active.selection.active.line,
            character: active.selection.active.character,
        });
    }, DEBOUNCE_MS);

    debounceTimers.set(key, timer);
}

function moveTo(editor, pos) {
    const position = new vscode.Position(pos.line, pos.character);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
}

function activate(context) {
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(event => {
            if (isNavigating) return;
            scheduleRecord(event.textEditor);
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (!editor || isNavigating) return;
            const h = getHistory(editor.document.uri.toString());
            if (!h.current) {
                h.push({
                    line: editor.selection.active.line,
                    character: editor.selection.active.character,
                });
            }
        })
    );

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

    context.subscriptions.push(
        vscode.commands.registerCommand('cursorFileNav.back', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const key = editor.document.uri.toString();
            // 先把当前位置刷入历史，再后退
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
                vscode.window.setStatusBarMessage('$(arrow-left) 当前文件没有更早的位置', 2000);
                return;
            }
            isNavigating = true;
            moveTo(editor, target);
            setImmediate(() => { isNavigating = false; });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('cursorFileNav.forward', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const target = getHistory(editor.document.uri.toString()).forward();
            if (!target) {
                vscode.window.setStatusBarMessage('$(arrow-right) 当前文件没有更晚的位置', 2000);
                return;
            }
            isNavigating = true;
            moveTo(editor, target);
            setImmediate(() => { isNavigating = false; });
        })
    );

    // 激活时记录当前位置
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        getHistory(editor.document.uri.toString()).push({
            line: editor.selection.active.line,
            character: editor.selection.active.character,
        });
    }
}

function deactivate() {
    debounceTimers.forEach(t => clearTimeout(t));
    debounceTimers.clear();
    histories.clear();
}

module.exports = { activate, deactivate };
