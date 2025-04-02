import * as vscode from 'vscode'
import * as phar from './phar/Phar'
import path from 'path'

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('phar', new PharProvider()),

        vscode.workspace.registerFileSystemProvider('phar', new PharFsProvider(), {
            isCaseSensitive: true,
            isReadonly: true,
        })
    )

    context.subscriptions.push(
        vscode.commands.registerCommand('vscode-phar.open-phar', async (uri: vscode.Uri | undefined) => {
            if (!uri) {
                let url = await vscode.window.showInputBox({
                    title: 'Open PHAR URL',
                    prompt: 'Enter PHAR URL with file',
                })
                if (!url) {
                    return
                }
                uri = vscode.Uri.parse(url)
            }
            const [basePharUri, internalPath] = pharSplitUri(uri)
            if (internalPath === '') {
                vscode.workspace.updateWorkspaceFolders(0, 0, {
                    uri: uri.with({ scheme: 'phar' }),
                    name: path.basename(uri.path),
                })
            } else {
                let doc = await vscode.workspace.openTextDocument(uri) // calls back into the provider
                await vscode.window.showTextDocument(doc, { preview: false })
            }
        })
    )

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(document => {
            if (document.languageId === 'phar') {
                vscode.commands.executeCommand('workbench.action.closeActiveEditor')
                vscode.workspace.updateWorkspaceFolders(0, 0, {
                    uri: document.uri.with({ scheme: 'phar' }),
                    name: path.basename(document.uri.path),
                })
            }
        })
    )
}

export function deactivate() {}

interface FEntry {
    name: string
    directory: boolean
}

class PharFsProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>()

    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event

    private pharMap: Map<string, Promise<phar.Archive>> = new Map<string, Promise<phar.Archive>>()
    private dirMap: Map<string, Map<string, FEntry[]>> = new Map<string, Map<string, FEntry[]>>()

    // Parses the PHAR file and builds an internal cache
    // Note: Since parsing can take some time, we need to make this method reentrant safe
    async _readPhar(uri: vscode.Uri): Promise<[phar.Archive, string]> {
        const [basePharUri, internalPath] = pharSplitUri(uri)
        let pa = this.pharMap.get(basePharUri.toString())

        if (!pa) {
            pa = new Promise<phar.Archive>(async (resolve, reject) => {
                try {
                    const pharContents = await vscode.workspace.fs.readFile(basePharUri)
                    const pa = new phar.Archive()
                    pa.loadPharData(pharContents)
                    this.dirMap.set(basePharUri.toString(), this._buildTree(pa))
                    resolve(pa)
                } catch (e) {
                    reject(e)
                }
            })
            this.pharMap.set(basePharUri.toString(), pa)
        }
        return [await pa, internalPath]
    }

    _buildTree(pa: phar.Archive): Map<string, FEntry[]> {
        const ret = new Map<string, FEntry[]>()
        pa.getFiles().forEach(f => {
            let parts = f.getName().split('/')
            let isFile = true

            while (parts.length > 0) {
                const n = parts.pop()!
                const d = parts.join('/')

                let fe = ret.get(d) || []
                if (!fe.find(f => f.name === n)) {
                    fe.push({ name: n, directory: !isFile })
                }
                isFile = false
                ret.set(d, fe)
            }
        })

        return ret
    }

    _getDirs(uri: vscode.Uri): Map<string, FEntry[]> {
        const [basePharUri, internalPath] = pharSplitUri(uri)
        let dirs = this.dirMap.get(basePharUri.toString())

        return dirs || new Map<string, FEntry[]>()
    }

    watch(
        uri: vscode.Uri,
        options: { readonly recursive: boolean; readonly excludes: readonly string[] }
    ): vscode.Disposable {
        throw new Error('Method watch not implemented.')
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const [pa, fp] = await this._readPhar(uri)

        const dirs = this._getDirs(uri)

        const f = pa.getFile(fp)
        if (f) {
            return {
                type: vscode.FileType.File,
                ctime: f.getTimestamp(),
                mtime: 0,
                size: f.getSize(),
            }
        }
        if (dirs.has(fp)) {
            return {
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: 0,
                size: 0,
            }
        }
        throw vscode.FileSystemError.FileNotFound(uri)
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const [pa, fp] = await this._readPhar(uri)

        const dirs = this._getDirs(uri)
        const fe = dirs.get(fp) || []
        const d = fe.map<[string, vscode.FileType]>(f => [
            f.name,
            f.directory ? vscode.FileType.Directory : vscode.FileType.File,
        ])

        return d
    }

    createDirectory(uri: vscode.Uri): void | Thenable<void> {
        throw new Error('Method createDir not implemented.')
    }
    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const [pa, fp] = await this._readPhar(uri)
        const pf = pa.getFile(fp)
        if (!pf) {
            throw vscode.FileSystemError.FileNotFound(uri)
        }
        return Buffer.from(pf.getContents())
    }
    writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        options: { readonly create: boolean; readonly overwrite: boolean }
    ): void | Thenable<void> {
        throw new Error('Method writeFile not implemented.')
    }
    delete(uri: vscode.Uri, options: { readonly recursive: boolean }): void | Thenable<void> {
        throw new Error('Method delete not implemented.')
    }
    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean }): void | Thenable<void> {
        throw new Error('Method rename not implemented.')
    }
}

function pharSplitUri(uri: vscode.Uri): [vscode.Uri, string] {
    const parts = uri.toString().split('/')
    const i = parts.findIndex(v => v.match(/\.phar$/))
    if (i === -1) {
        // can't parse
        throw new Error('Cannot parse URI')
    }
    let pharFile = parts.slice(0, i + 1).join('/')
    const packedFile = parts.slice(i + 1).join('/') // force /?

    // php on windows and wrong number of slashes
    if (pharFile.match(/^[pP][hH][aA][rR]:\/\/[a-zA-Z]:\//)) {
        pharFile = pharFile.substring(0, 7) + '/' + pharFile.substring(7)
    }

    const fix = vscode.Uri.parse(pharFile).with({ scheme: 'file' })
    return [fix, packedFile]
}

class PharProvider implements vscode.TextDocumentContentProvider {
    public async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
        const [fix, packedFile] = pharSplitUri(uri)

        const pharContents = await vscode.workspace.fs.readFile(fix)

        const pa = new phar.Archive()
        pa.loadPharData(pharContents)

        const pf = pa.getFile(packedFile)

        if (!pf) {
            throw new Error('File not found in PHAR')
        }

        return pf.getContents()
    }
}
