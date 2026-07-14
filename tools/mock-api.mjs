// A stand-in for api.restful-api.dev, which rations the free tier to 50 requests a
// day — a ceiling the Grand Tour blows through in one phase. Zero dependencies.
//
// It mirrors that API's RESPONSE SHAPE exactly, so the contract already captured on
// step 5 ({id: string, name: string, data: null}) still holds and nothing else in the
// test has to change:
//
//   POST   /objects            {"name":"qa-…"}  → 200 {id, name, data:null}
//   GET    /objects/:id                         → 200 {id, name, data:null} | 404
//   DELETE /objects/:id                         → 200 {message:"…deleted."}  | 404
//   GET    /objects                             → 200 [ … ]
//
// The 404s are deliberate: step 6 accepts 200,204,404 so that a re-run where the
// object is already gone still passes. This has to be able to produce that 404.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

// NOT 3001 — on this machine that port is already held by Windows' http.sys/IIS
// (PID 4), which answers with iisnode HTML error pages and makes node bail with
// EACCES. 4517 is free.
const PORT = 4517
const store = new Map()

const send = (res, status, body) => {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  })
  res.end(text)
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
  })

createServer(async (req, res) => {
  const { method } = req
  const path = (req.url ?? '').split('?')[0]
  const m = /^\/objects\/(.+)$/.exec(path)
  const id = m?.[1]
  const stamp = new Date().toISOString().slice(11, 19)

  // POST /objects — create. id is a STRING of hex, like the real API (so `id is-string`
  // passes and `id gt 0` correctly reports "not a number").
  if (method === 'POST' && path === '/objects') {
    const body = await readBody(req)
    const newId = randomUUID().replace(/-/g, '')
    const obj = { id: newId, name: body.name ?? null, data: null }
    store.set(newId, obj)
    console.log(`${stamp}  POST   /objects            → 200  created ${newId}  name=${obj.name}`)
    return send(res, 200, obj)
  }

  if (method === 'GET' && path === '/objects') {
    console.log(`${stamp}  GET    /objects            → 200  ${store.size} object(s)`)
    return send(res, 200, [...store.values()])
  }

  if (method === 'GET' && id) {
    const obj = store.get(id)
    console.log(`${stamp}  GET    /objects/${id.slice(0, 8)}…  → ${obj ? 200 : 404}`)
    if (!obj) return send(res, 404, { error: `Object with id = ${id} doesn't exist.` })
    return send(res, 200, obj)
  }

  if (method === 'DELETE' && id) {
    const existed = store.delete(id)
    console.log(`${stamp}  DELETE /objects/${id.slice(0, 8)}…  → ${existed ? 200 : 404}`)
    if (!existed) return send(res, 404, { error: `Object with id = ${id} doesn't exist.` })
    return send(res, 200, { message: `Object with id = ${id} has been deleted.` })
  }

  console.log(`${stamp}  ${method} ${path} → 404 (no route)`)
  send(res, 404, { error: 'no such route' })
}).listen(PORT, () => {
  console.log(`mock API listening on http://localhost:${PORT}`)
  console.log('  POST   /objects            create')
  console.log('  GET    /objects/:id        read back')
  console.log('  DELETE /objects/:id        clean up (404 when already gone)')
  console.log('')
})
