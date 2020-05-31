import * as vscode from 'vscode';
import * as rpc from 'vscode-jsonrpc';
import * as path from 'path';
import * as net from 'net';
import * as vslc from 'vscode-languageclient';
import { ISettings } from '../settings';
import * as juliaexepath from '../juliaexepath';
import { generatePipeName, inferJuliaNumThreads } from '../utils';
import * as telemetry from '../telemetry';
import * as jlpkgenv from '../jlpkgenv';
import * as fs from 'async-file';
import { Subject } from 'await-notify';

import * as plots from './plots'
import * as workspace from './workspace'
import { onDidChangeConfig, onSetLanguageClient } from '../extension';

let g_context: vscode.ExtensionContext = null;
let g_settings: ISettings = null;
let g_languageClient: vslc.LanguageClient = null;

let g_terminal: vscode.Terminal = null

let g_connection: rpc.MessageConnection = undefined;

function startREPLCommand() {
    telemetry.traceEvent('command-startrepl');

    startREPL(false);
}

function is_remote_env(): boolean {
    return typeof vscode.env.remoteName !== 'undefined'
}

function get_editor(): string {
    if (is_remote_env() || process.platform === 'darwin') {
        const cmd = vscode.env.appName.includes('Insiders') ? 'code-insiders' : 'code'
        return `"${path.join(vscode.env.appRoot, 'bin', cmd)}"`
    }
    else {
        return `"${process.execPath}"`
    }
}

async function startREPL(preserveFocus: boolean) {
    if (g_terminal === null) {
        const pipename = generatePipeName(process.pid.toString(), 'vsc-julia-repl');

        const juliaIsConnectedPromise = startREPLMsgServer(pipename);

        const args = path.join(g_context.extensionPath, 'scripts', 'terminalserver', 'terminalserver.jl')
        const exepath = await juliaexepath.getJuliaExePath();
        const pkgenvpath = await jlpkgenv.getEnvPath();
        if (pkgenvpath === null) {
            const jlarg1 = ['-i', '--banner=no'].concat(vscode.workspace.getConfiguration('julia').get('additionalArgs'))
            const jlarg2 = [
                args,
                pipename,
                vscode.workspace.getConfiguration('julia').get('useRevise').toString(),
                vscode.workspace.getConfiguration('julia').get('usePlotPane').toString(),
                telemetry.getCrashReportingPipename()
            ]
            g_terminal = vscode.window.createTerminal(
                {
                    name: 'julia',
                    shellPath: exepath,
                    shellArgs: jlarg1.concat(jlarg2),
                    env: {
                        JULIA_EDITOR: get_editor(),
                        JULIA_NUM_THREADS: inferJuliaNumThreads()
                    }
                });
        }
        else {
            const env_file_paths = await jlpkgenv.getProjectFilePaths(pkgenvpath);

            let sysImageArgs = [];
            if (vscode.workspace.getConfiguration('julia').get('useCustomSysimage') && env_file_paths.sysimage_path && env_file_paths.project_toml_path && env_file_paths.manifest_toml_path) {
                const date_sysimage = await fs.stat(env_file_paths.sysimage_path);
                const date_manifest = await fs.stat(env_file_paths.manifest_toml_path);

                if (date_sysimage.mtime > date_manifest.mtime) {
                    sysImageArgs = ['-J', env_file_paths.sysimage_path]
                }
                else {
                    vscode.window.showWarningMessage('Julia sysimage for this environment is out-of-date and not used for REPL.')
                }
            }
            const jlarg1 = ['-i', '--banner=no', `--project=${pkgenvpath}`].concat(sysImageArgs).concat(vscode.workspace.getConfiguration('julia').get('additionalArgs'))
            const jlarg2 = [
                args,
                pipename,
                vscode.workspace.getConfiguration('julia').get('useRevise').toString(),
                vscode.workspace.getConfiguration('julia').get('usePlotPane').toString(),
                telemetry.getCrashReportingPipename()
            ]
            g_terminal = vscode.window.createTerminal(
                {
                    name: 'julia',
                    shellPath: exepath,
                    shellArgs: jlarg1.concat(jlarg2),
                    env: {
                        JULIA_EDITOR: get_editor(),
                        JULIA_NUM_THREADS: inferJuliaNumThreads()
                    }
                });
        }
        g_terminal.show(preserveFocus);
        await juliaIsConnectedPromise.wait();
    }
    else {
        g_terminal.show(preserveFocus);
    }
    workspace.setTerminal(g_terminal)
}

function debuggerRun(code: string) {
    const x = {
        type: 'julia',
        request: 'attach',
        name: 'Julia REPL',
        code: code,
        stopOnEntry: false
    }
    vscode.debug.startDebugging(undefined, x);
}

function debuggerEnter(code: string) {
    const x = {
        type: 'julia',
        request: 'attach',
        name: 'Julia REPL',
        code: code,
        stopOnEntry: true
    }
    vscode.debug.startDebugging(undefined, x);
}

const notifyTypeDisplay = new rpc.NotificationType<{ kind: string, data: any }, void>('display');
const notifyTypeDebuggerEnter = new rpc.NotificationType<string, void>('debugger/enter');
const notifyTypeDebuggerRun = new rpc.NotificationType<string, void>('debugger/run');
const notifyTypeReplRunCode = new rpc.NotificationType<{ filename: string, line: number, column: number, code: string }, void>('repl/runcode');
const notifyTypeReplStartDebugger = new rpc.NotificationType<string, void>('repl/startdebugger');

function startREPLMsgServer(pipename: string) {
    const connected = new Subject();

    const server = net.createServer((socket: net.Socket) => {
        socket.on('close', hadError => { server.close() });

        g_connection = rpc.createMessageConnection(
            new rpc.StreamMessageReader(socket),
            new rpc.StreamMessageWriter(socket)
        );

        g_connection.onNotification(notifyTypeDisplay, plots.displayPlot);
        g_connection.onNotification(notifyTypeDebuggerRun, debuggerRun);
        g_connection.onNotification(notifyTypeDebuggerEnter, debuggerEnter);

        g_connection.listen();

        connected.notify();
    });

    server.listen(pipename);

    return connected;
}

async function executeCode(text, individualLine) {
    if (!text.endsWith('\n')) {
        text = text + '\n';
    }

    await startREPL(true);
    g_terminal.show(true);
    let lines = text.split(/\r?\n/);
    lines = lines.filter(line => line !== '');
    text = lines.join('\n');
    if (individualLine || process.platform === 'win32') {
        g_terminal.sendText(text + '\n', false);
    }
    else {
        g_terminal.sendText('\u001B[200~' + text + '\n' + '\u001B[201~', false);
    }
}

function executeSelection() {
    telemetry.traceEvent('command-executejuliacodeinrepl');

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const selection = editor.selection;

    const text = selection.isEmpty ? editor.document.lineAt(selection.start.line).text : editor.document.getText(selection);

    // If no text was selected, try to move the cursor to the end of the next line
    if (selection.isEmpty) {
        for (let line = selection.start.line + 1; line < editor.document.lineCount; line++) {
            if (!editor.document.lineAt(line).isEmptyOrWhitespace) {
                const newPos = selection.active.with(line, editor.document.lineAt(line).range.end.character);
                const newSel = new vscode.Selection(newPos, newPos);
                editor.selection = newSel;
                break;
            }
        }
    }
    executeCode(text, selection.isEmpty)
}

async function executeInRepl(code: string, filename: string, start: vscode.Position) {
    await startREPL(true);

    g_connection.sendNotification(
        notifyTypeReplRunCode,
        {
            filename: filename,
            line: start.line,
            column: start.character,
            code: code
        }
    );
}

async function executeFile(uri?: vscode.Uri) {
    telemetry.traceEvent('command-executejuliafileinrepl');

    let path = '';
    let code = '';
    if (uri) {
        path = uri.fsPath;
        const readBytes = await vscode.workspace.fs.readFile(uri);
        code = Buffer.from(readBytes).toString('utf8');
    }
    else {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        path = editor.document.fileName;
        code = editor.document.getText();
    }
    executeInRepl(code, path, new vscode.Position(0, 0));
}

async function selectJuliaBlock() {
    if (g_languageClient === null) {
        vscode.window.showErrorMessage('Error: Language server is not running.');
    }
    else {
        const editor = vscode.window.activeTextEditor;
        const params: TextDocumentPositionParams = { textDocument: vslc.TextDocumentIdentifier.create(editor.document.uri.toString()), position: new vscode.Position(editor.selection.start.line, editor.selection.start.character) }

        try {
            const ret_val: vscode.Position[] = await g_languageClient.sendRequest('julia/getCurrentBlockRange', params);

            const start_pos = new vscode.Position(ret_val[0].line, ret_val[0].character)
            const end_pos = new vscode.Position(ret_val[1].line, ret_val[1].character)
            vscode.window.activeTextEditor.selection = new vscode.Selection(start_pos, end_pos)
            vscode.window.activeTextEditor.revealRange(new vscode.Range(start_pos, end_pos))
        }
        catch (ex) {
            if (ex.message === 'Language client is not ready yet') {
                vscode.window.showErrorMessage('Select code block only works once the Julia Language Server is ready.');
            }
            else {
                throw ex;
            }
        }
    }
}

const g_cellDelimiter = new RegExp('^##(?!#)')

async function executeJuliaCellInRepl() {
    telemetry.traceEvent('command-executejuliacellinrepl');

    const ed = vscode.window.activeTextEditor;
    const doc = ed.document;
    const curr = doc.validatePosition(ed.selection.active).line;
    let start = curr;
    while (start >= 0) {
        if (g_cellDelimiter.test(doc.lineAt(start).text)) {
            break;
        } else {
            start -= 1;
        }
    }
    start += 1;
    let end = start;
    while (end < doc.lineCount) {
        if (g_cellDelimiter.test(doc.lineAt(end).text)) {
            break;
        } else {
            end += 1;
        }
    }
    end -= 1;
    const startpos = new vscode.Position(start, 0);
    const endpos = new vscode.Position(end, doc.lineAt(end).text.length);
    const nextpos = new vscode.Position(end + 1, 0);
    const code = doc.getText(new vscode.Range(startpos, endpos));
    executeInRepl(code, doc.fileName, startpos)
    vscode.window.activeTextEditor.selection = new vscode.Selection(nextpos, nextpos)
    vscode.window.activeTextEditor.revealRange(new vscode.Range(nextpos, nextpos))
}

async function executeJuliaBlockInRepl() {
    telemetry.traceEvent('command-executejuliablockinrepl');

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const selection = editor.selection;

    if (selection.isEmpty && g_languageClient === null) {
        vscode.window.showErrorMessage('Error: Language server is not running.');
    }
    else if (!selection.isEmpty) {
        const code_to_run = editor.document.getText(selection);

        executeInRepl(code_to_run, editor.document.fileName, selection.start);
    }
    else {
        const params: TextDocumentPositionParams = { textDocument: vslc.TextDocumentIdentifier.create(editor.document.uri.toString()), position: new vscode.Position(editor.selection.start.line, editor.selection.start.character) }

        try {
            const ret_val: vscode.Position[] = await g_languageClient.sendRequest('julia/getCurrentBlockRange', params);

            const start_pos = new vscode.Position(ret_val[0].line, ret_val[0].character)
            const end_pos = new vscode.Position(ret_val[1].line, ret_val[1].character)
            const next_pos = new vscode.Position(ret_val[2].line, ret_val[2].character)

            const code_to_run = vscode.window.activeTextEditor.document.getText(new vscode.Range(start_pos, end_pos))
            executeInRepl(code_to_run, vscode.window.activeTextEditor.document.fileName, start_pos)

            vscode.window.activeTextEditor.selection = new vscode.Selection(next_pos, next_pos)
            vscode.window.activeTextEditor.revealRange(new vscode.Range(next_pos, next_pos))
        }
        catch (ex) {
            if (ex.message === 'Language client is not ready yet') {
                vscode.window.showErrorMessage('Execute code block only works once the Julia Language Server is ready.');
            }
            else {
                throw ex;
            }
        }
    }
}

export async function replStartDebugger(pipename: string) {
    await startREPL(true)

    g_connection.sendNotification(notifyTypeReplStartDebugger, pipename);
}

export interface TextDocumentPositionParams {
    textDocument: vslc.TextDocumentIdentifier
    position: vscode.Position
}

export function activate(context: vscode.ExtensionContext, settings: ISettings) {
    g_context = context;
    g_settings = settings;

    context.subscriptions.push(onSetLanguageClient(languageClient => {
        g_languageClient = languageClient
    }))
    context.subscriptions.push(onDidChangeConfig(newSettings => {
        g_settings = newSettings
    }))

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.startREPL', startREPLCommand));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCodeInREPL', executeSelection));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaFileInREPL', executeFile));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaCellInREPL', executeJuliaCellInRepl));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.executeJuliaBlockInREPL', executeJuliaBlockInRepl));

    context.subscriptions.push(vscode.commands.registerCommand('language-julia.selectBlock', selectJuliaBlock));

    vscode.window.onDidCloseTerminal(terminal => {
        if (terminal === g_terminal) {
            g_terminal = null;
            workspace.setTerminal(null)
        }
    })

    plots.activate(context);
    workspace.activate(context);
}
