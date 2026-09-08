import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { policy, validatePackageCompatibility } from './compatibility.mjs'

// Keep every prerelease and fork build away from npm's default channel.
export function releaseMetadata(pkg, support = policy) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc|dsh012rc1|dsh013alpha2)\.(0|[1-9]\d*))?$/.exec(pkg.version)
  if (!match || match[0] !== pkg.version) throw new Error(`Unsupported release version: ${pkg.version}`)
  validatePackageCompatibility(pkg, support)
  const channel = match[4]
  const distTag = channel === undefined
    ? 'latest'
    : channel.startsWith('dsh')
      ? channel
      : support.previewTag
  if (pkg.publishConfig?.tag !== distTag) {
    throw new Error(`publishConfig.tag must be "${distTag}" for ${pkg.version}`)
  }
  if (channel === undefined && pkg.devDependencies['@deepseek-ai/dsh'] !== support.recommendedHost) {
    throw new Error('latest must use the recommended host as its development baseline')
  }
  return { value: pkg.version, dist_tag: distTag, prerelease: channel !== undefined }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [key, value] of Object.entries(releaseMetadata(pkg))) {
    console.log(`${key}=${value}`)
  }
}
