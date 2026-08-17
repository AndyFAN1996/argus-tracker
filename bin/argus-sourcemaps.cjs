#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const zlib = require('zlib')

function printHelp() {
  process.stdout.write(`Argus SourceMap uploader

Usage:
  argus-sourcemaps upload [options]

Options:
  --url <url>                  Argus server origin (or ARGUS_URL)
  --token <token>              Project upload token (or ARGUS_SOURCEMAP_TOKEN)
  --release <release>          Release ID matching Tracker revID (or ARGUS_RELEASE)
  --dir <directory>            Build output directory (default: dist)
  --delete-after-upload        Remove each .map after a successful upload
  --help                       Show this help
`)
}

function parseArgs(argv) {
  const values = {}
  const args = argv.slice()
  if (args[0] === 'upload') args.shift()
  while (args.length > 0) {
    const key = args.shift()
    if (key === '--help' || key === '-h') {
      values.help = true
      continue
    }
    if (key === '--delete-after-upload') {
      values.deleteAfterUpload = true
      continue
    }
    if (!['--url', '--token', '--release', '--dir'].includes(key)) {
      throw new Error(`Unknown option: ${key}`)
    }
    const value = args.shift()
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    values[key.slice(2)] = value
  }
  return values
}

function findSourceMaps(directory) {
  const files = []
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.isFile() && entry.name.endsWith('.map')) files.push(target)
    }
  }
  walk(directory)
  return files.sort()
}

function generatedFileFor(mapPath, root, data) {
  try {
    const parsed = JSON.parse(data.toString('utf8'))
    if (typeof parsed.file === 'string' && parsed.file.trim()) return parsed.file.trim()
  } catch (error) {
    throw new Error(`${mapPath} is not valid SourceMap JSON: ${error.message}`)
  }
  return `/${path
    .relative(root, mapPath)
    .split(path.sep)
    .join('/')
    .replace(/\.map$/, '')}`
}

function multipartBody(fields, filename, fileData, contentEncoding) {
  const boundary = `----argus-${crypto.randomBytes(16).toString('hex')}`
  const chunks = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    )
  }
  const safeFilename = path.basename(filename).replace(/["\r\n]/g, '_')
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: application/json\r\n${contentEncoding ? `Content-Encoding: ${contentEncoding}\r\n` : ''}\r\n`,
    ),
  )
  chunks.push(fileData)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  return { boundary, body: Buffer.concat(chunks) }
}

function uploadFile(endpoint, token, release, root, mapPath) {
  const fileData = fs.readFileSync(mapPath)
  const generatedFile = generatedFileFor(mapPath, root, fileData)
  const compressedData = zlib.gzipSync(fileData, { level: zlib.constants.Z_BEST_COMPRESSION })
  const shouldCompress = compressedData.length < fileData.length
  const uploadData = shouldCompress ? compressedData : fileData
  const { boundary, body } = multipartBody(
    { revision: release, generatedFile },
    mapPath,
    uploadData,
    shouldCompress ? 'gzip' : '',
  )
  const transport = endpoint.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const request = transport.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          'X-Argus-Sourcemap-Token': token,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 60000,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve({ rawSize: fileData.length, uploadSize: uploadData.length })
            return
          }
          const relativePath = path.relative(root, mapPath)
          reject(
            new Error(
              `upload failed for ${relativePath} (${fileData.length} B raw, ${uploadData.length} B uploaded; HTTP ${response.statusCode}): ${responseBody.slice(0, 500)}`,
            ),
          )
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error('upload timed out after 60 seconds')))
    request.on('error', reject)
    request.end(body)
  })
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return
  }

  const serverURL = args.url || env.ARGUS_URL
  const token = args.token || env.ARGUS_SOURCEMAP_TOKEN
  const release = args.release || env.ARGUS_RELEASE
  const directory = path.resolve(args.dir || env.ARGUS_SOURCEMAP_DIR || 'dist')
  if (!serverURL) throw new Error('Argus URL is required (--url or ARGUS_URL)')
  if (!token)
    throw new Error('SourceMap upload token is required (--token or ARGUS_SOURCEMAP_TOKEN)')
  if (!release) throw new Error('Release is required (--release or ARGUS_RELEASE)')
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())
    throw new Error(`Build directory does not exist: ${directory}`)

  const endpoint = new URL(`${serverURL.replace(/\/$/, '')}/v1/web/sourcemaps`)
  const maps = findSourceMaps(directory)
  if (maps.length === 0) throw new Error(`No .map files found in ${directory}`)

  process.stdout.write(`Uploading ${maps.length} SourceMap(s) for release ${release}\n`)
  for (const mapPath of maps) {
    const result = await uploadFile(endpoint, token, release, directory, mapPath)
    process.stdout.write(
      `✓ ${path.relative(directory, mapPath)} (${result.rawSize} B → ${result.uploadSize} B)\n`,
    )
    if (args.deleteAfterUpload) fs.unlinkSync(mapPath)
  }
  process.stdout.write(`Uploaded ${maps.length} SourceMap(s) successfully\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Argus SourceMap upload failed: ${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = { findSourceMaps, generatedFileFor, main, parseArgs }
