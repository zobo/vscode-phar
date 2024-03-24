import * as vscode from 'vscode';
import * as phar from './phar/Phar'
import path from 'path';

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider("phar", new PharProvider()),
	);
}


export function deactivate() {

}

function pharSplitUri(uri: vscode.Uri) : [vscode.Uri, string] {
	const parts = uri.toString().split('/')
	const i = parts.findIndex((v) => v.match(/\.phar$/))
	if (i === -1) {
		// cant parse
		throw new Error("Cannot parse URI")
	}
	const pharFile = parts.slice(0, i+1).join('/')
	const packedFile = parts.slice(i+1).join('/') // force /?

	const fix = vscode.Uri.parse(pharFile).with({scheme: 'file'})
	return [fix, packedFile]
}

class PharProvider implements vscode.TextDocumentContentProvider
{
	public async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
		const [fix, packedFile] = pharSplitUri(uri)

		const pharContents = await vscode.workspace.fs.readFile(fix);

		const pa = new phar.Archive()
		pa.loadPharData(pharContents)

		const pf = pa.getFile(packedFile)

		if (!pf) {
			throw new Error("File not found in PHAR")
		}

		return pf.getContents()
	}
}









