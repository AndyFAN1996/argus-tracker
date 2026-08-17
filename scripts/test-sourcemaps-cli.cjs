'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { main } = require('../bin/argus-sourcemaps.cjs')

async function testUploadAndDelete() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-sourcemaps-'))
  const mapPath = path.join(directory, 'app.js.map')
  fs.writeFileSync(
    mapPath,
    JSON.stringify({
      version: 3,
      file: 'assets/app.js',
      sources: ['src/app.ts'],
      sourcesContent: ['const repeated = true;\n'.repeat(500)],
      names: [],
      mappings: '',
    }),
  )

  let requestBody = Buffer.alloc(0)
  const server = http.createServer((request, response) => {
    assert.strictEqual(request.url, '/v1/web/sourcemaps')
    assert.strictEqual(request.headers['x-argus-sourcemap-token'], 'argus_sm_test')
    assert.strictEqual(request.headers.authorization, undefined)
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      requestBody = Buffer.concat(chunks)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{}')
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    await main([
      'upload',
      '--url',
      `http://127.0.0.1:${address.port}`,
      '--token',
      'argus_sm_test',
      '--release',
      'release-123',
      '--dir',
      directory,
      '--delete-after-upload',
    ])
    const requestText = requestBody.toString('latin1')
    assert(requestText.includes('release-123'))
    assert(requestText.includes('assets/app.js'))
    assert(requestText.includes('Content-Encoding: gzip'))
    const fileHeaderEnd = requestBody.indexOf(Buffer.from('Content-Encoding: gzip\r\n\r\n'))
    assert(fileHeaderEnd >= 0)
    const compressedStart = fileHeaderEnd + Buffer.byteLength('Content-Encoding: gzip\r\n\r\n')
    const compressedEnd = requestBody.indexOf(Buffer.from('\r\n------argus-'), compressedStart)
    assert(compressedEnd > compressedStart)
    const uploadedMap = zlib.gunzipSync(requestBody.subarray(compressedStart, compressedEnd))
    assert.strictEqual(JSON.parse(uploadedMap.toString('utf8')).file, 'assets/app.js')
    assert.strictEqual(fs.existsSync(mapPath), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmdirSync(directory)
  }
}

testUploadAndDelete().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
