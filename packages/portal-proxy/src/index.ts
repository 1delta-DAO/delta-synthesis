const UPSTREAM = 'https://portal.1delta.io'

interface Env {
  PORTAL_API_KEY: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      })
    }

    const url = new URL(request.url)

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ status: 'ok', service: 'portal-proxy' })
    }

    // Forward the request to the upstream API
    const upstream = new URL(url.pathname + url.search, UPSTREAM)

    const headers = new Headers(request.headers)
    headers.set('x-api-key', env.PORTAL_API_KEY)
    // Remove host header so upstream gets the correct one
    headers.delete('host')

    const res = await fetch(upstream.toString(), {
      method: request.method,
      headers,
      body: request.body,
    })

    // Clone response and add CORS headers
    const responseHeaders = new Headers(res.headers)
    for (const [k, v] of Object.entries(corsHeaders())) {
      responseHeaders.set(k, v)
    }

    return new Response(res.body, {
      status: res.status,
      headers: responseHeaders,
    })
  },
} satisfies ExportedHandler<Env>

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
