// Test-only resolver: maps the host-provided peer packages onto the monorepo
// checkout so the plugin can be exercised without installing a profile.
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolvePath(here, '..', '..', '..')
const map = {
  '@deepseek-ai/cordis': resolvePath(repo, 'vendor/cordis/lib/index.js'),
  '@deepseek-ai/dsh-llm': resolvePath(repo, 'packages/llm/llm/lib/index.js'),
  '@deepseek-ai/dsh-host-webserver': resolvePath(repo, 'packages/host/webserver/lib/index.js'),
  '@deepseek-ai/schemastery': resolvePath(repo, 'packages/llm/llm/node_modules/@deepseek-ai/schemastery/lib/index.mjs'),
}

export async function resolve(specifier, context, next) {
  const target = map[specifier]
  if (target !== undefined) return next(pathToFileURL(target).href, context)
  return next(specifier, context)
}
