/**
 * Imports the transport child entry as a library.
 *
 * The child's frame loop may only start when its own file is the process entry, so an
 * import must return without reading stdin or writing a frame. The marker reaches stdout
 * after the import resolves; an import that started the loop would hold this script at the
 * `await` while it consumed the frames the caller writes, and the child's own frame would
 * share this stdout.
 *
 * The entry path arrives as the first argument. Nothing in this file is compiled: the
 * runtime that runs it also transpiles a TypeScript entry.
 */

import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (entry === undefined) throw new Error('the child entry path is required')

await import(pathToFileURL(entry).href)
process.stdout.write('transport-startup:imported\n')
