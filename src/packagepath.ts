import * as vscode from 'vscode';
import * as settings from './settings';
import * as juliaexepath from './juliaexepath';
import { join } from 'path';
import { exec } from 'child-process-promise';
import { onDidChangeConfig } from './extension';

let g_settings: settings.ISettings = null;

let juliaPackagePath: string = null;

let juliaDepotPath: string[] = null;

export async function getPkgPath() {
    if (juliaPackagePath === null) {
        const jlexepath = await juliaexepath.getJuliaExePath();
        // TODO: there's got to be a better way to do this.
        const res = await exec(`"${jlexepath}" --startup-file=no --history-file=no -e "using Pkg;println(Pkg.depots()[1])"`);
        juliaPackagePath = join(res.stdout.trim(), 'dev');
    }
    return juliaPackagePath;
}

export async function getPkgDepotPath() {
    if (juliaDepotPath === null) {
        const jlexepath = await juliaexepath.getJuliaExePath();
        const res = await exec(`"${jlexepath}" --startup-file=no --history-file=no -e "using Pkg; println.(Pkg.depots())"`);
        juliaDepotPath = res.stdout.trim().split('\n');
    }
    return juliaDepotPath;
}

export function activate(context: vscode.ExtensionContext, settings: settings.ISettings) {
    g_settings = settings;

    context.subscriptions.push(onDidChangeConfig(newSettings => {
        if (g_settings.juliaExePath !== newSettings.juliaExePath) {
            juliaPackagePath = null;
        }
    }))
}
