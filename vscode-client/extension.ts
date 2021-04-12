/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions
} from 'vscode-languageclient/node';
import * as vscodelc from 'vscode-languageclient';

namespace ExtraRequest {
	export const ShowAllFiles =
		new vscodelc.RequestType0<any, void>('workspace/xShowAllFiles')
	export const GetAllEntities =
		new vscodelc.RequestType0<{name: string, library: string}[], void>('workspace/xGetAllEntities')
	export const GetEntityInterface =
		new vscodelc.RequestType<{name: string, library: string}, any, void>('workspace/xGetEntityInterface')
}

let client: LanguageClient;

class EntityItem implements vscode.QuickPickItem {
	label: string
	description: string
	library: string

	constructor(name : string, library: string) {
		this.label = name
		this.description = library + '.' + name
		this.library = library
	}
}

// As of 04/07/2021:
// Stopping / disposing the client (and server) seems to work, but leads to the following error:
// "rejected promise not handled within 1 second: Error [ERR_STREAM_WRITE_AFTER_END]: write after end"
// See: https://github.com/microsoft/vscode-languageserver-node/issues/723
async function restart_client() {
	if (client) {
		if (client.needsStop()) {
			await client.stop();
		}
		if (client.needsStart()) {
			client.start();
		}
	}
}

// Creates an empty project in the current workspace or guides the user through
// project creation when more workspaces are open and/or the selected workspace
// conatins *.vhd files
async function create_project() {
	// Get open workspaces
	const workspace_folders = vscode.workspace.workspaceFolders
	let selected_workspace_folder: vscode.WorkspaceFolder = undefined

	if (!workspace_folders) {
		vscode.window.showWarningMessage('No folder opened to create project in!')
		return
	} else if (workspace_folders.length == 1) {
		selected_workspace_folder = workspace_folders[0]
	} else {
		// Ask user in which workspace the project should be created
		const workspace_index = await vscode.window.showQuickPick(
			workspace_folders.map((workspaceFolder, index) => { return { label: workspaceFolder.name, detail: workspaceFolder.uri.path, index } }),
			{ placeHolder: 'Choose a folder in which the project should be created in:', canPickMany: false }
		).then(result => result.index)
		selected_workspace_folder = workspace_folders[workspace_index]
	}

	// Check if project file already exists in the root directory of the chosen workspace
	const prj_already_exists = (await vscode.workspace.findFiles(new vscode.RelativePattern(selected_workspace_folder, 'hdl-prj.json'))).length != 0

	if (prj_already_exists) {
		vscode.window.showErrorMessage('A project already exists in folder ' + selected_workspace_folder.name + '!')
		return
	}

	// Check for existing *.vhd files in current workspace
	const vhdl_uris = await vscode.workspace.findFiles(new vscode.RelativePattern(selected_workspace_folder, '**/*.vhd'))
	let add_all_existing_vhdl_files = false

	// Ask user if existing *.vhd files should be added to new project
	if (vhdl_uris.length > 0) {
		add_all_existing_vhdl_files = await vscode.window.showQuickPick(
			[{ label: 'Yes', bool_value: true }, { label: 'No', bool_value: false }],
			{ placeHolder: 'Add' + (vhdl_uris.length == 1 ? ' existing VHDL file' : ' all existing VHDL files') + ' to project?' }
		).then(result => result.bool_value)
	}

	let hdl_prj_json = {
		"options": {
			"ghdl_analysis": [
				"--workdir=work",
				"--ieee=synopsys",
				"-fexplicit"
			]
		},
		"files": []
	}

	const selected_workspace_folder_with_sep = selected_workspace_folder.uri.path + path.sep

	// Add all VHDL files to project file if user chose so
	if (add_all_existing_vhdl_files) {
		hdl_prj_json.files = vhdl_uris.map(uri => { return { "file": uri.path.replace(selected_workspace_folder_with_sep, ''), "language": "vhdl" } })
	}

	// Create project file
	const project_file = vscode.Uri.file(selected_workspace_folder_with_sep + 'hdl-prj.json')
	try {
		fs.writeFileSync(project_file.fsPath, JSON.stringify(hdl_prj_json, undefined, 4))
	} catch {
		vscode.window.showErrorMessage('Could not create project file!')
		return
	}

	// Open project file to signal sucess
	vscode.workspace.openTextDocument(project_file)
		.then(document => vscode.window.showTextDocument(document))

	// Restart client (which also restarts server) to reload new project file
	restart_client()
}

async function instantiate_entity() {
	await client.sendRequest(ExtraRequest.GetAllEntities)
	.then(ent => {
		if (!ent) {
			return;
		}
		let res = ent.map(e => new EntityItem(e.name, e.library))
		return vscode.window.showQuickPick(res)
	})
	.then(res => {
		return client.sendRequest(ExtraRequest.GetEntityInterface, {name: res.label, library: res.library})
	})
	.then(res => {
		let textEditor = vscode.window.activeTextEditor
		if (!textEditor)
			return
		let snippet = '${1:my_inst}: ' + `entity ${res.library}.${res.entity}`
		let placeholder_pos = 2
		function gen_interfaces(name: string, inters: [{name: string}]): string {
			if (!inters.length)
				return ''
			let isfirst = true
			let r = `\n  ${name} map (`
			for (let g of inters) {
				if (isfirst)
					isfirst = false
				else
					r += ','
				r += `\n    ${g.name} => \${${placeholder_pos}:${g.name}}`
				
				placeholder_pos += 1;
			}
			return r + '\n  )'
		}
		snippet += gen_interfaces('generic', res.generics)
		snippet += gen_interfaces('port', res.ports)
		snippet += ';'
		return textEditor.insertSnippet(new vscode.SnippetString(snippet))
		 //textEditor.edit((edit) => { edit.insert(textEditor.selection.active, res.description) })
	})
}

export function activate(context: vscode.ExtensionContext) {
	let serverPath = "ghdl-ls";

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: {
			command: serverPath,
			args: ['-v']
		},
		debug: {
			command: serverPath,
			args: ['-vvv', '--trace-file=vhdl-ls.trace']
		}
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for vhdl documents
		documentSelector: [{ scheme: 'file', language: 'vhdl' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	//  Force debugging
	let debug: boolean = vscode.workspace.getConfiguration().get('vhdl.debugLSP');

	// Create the language client and start the client.
	client = new LanguageClient(
		'vhdlLanguageServer',
		'VHDL Language Server',
		serverOptions,
		clientOptions,
		debug
	);

	// Start the client. This will also launch the server
	context.subscriptions.push(client.start());

	context.subscriptions.push(vscode.commands.registerCommand(
		'ghdl-ls.showallfiles', async () => {
			let oc = vscode.window.createOutputChannel('all-files');
			oc.clear();
			const files = await client.sendRequest(ExtraRequest.ShowAllFiles);
			if (!files) {
				return;
			}
			for (let f of files) {
				oc.append(`${f.fe}: name:${f.name}\n`);
				oc.append(`      dir:${f.dir}\n`);
				if (f.uri) {
					oc.append(`    uri: ${f.uri}\n`)
				}
			}
			oc.show();
		}
	))
	
	context.subscriptions.push(vscode.commands.registerCommand(
		'ghdl-ls.instantiate-entity', instantiate_entity))

	context.subscriptions.push(vscode.commands.registerCommand(
		'ghdl-ls.createproject', create_project))
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
