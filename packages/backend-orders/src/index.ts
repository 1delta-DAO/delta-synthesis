/**
 * Verato Orders API
 *
 * Simple queryable order book backed by Cloudflare D1.
 * Frontend submits signed orders, agent worker queries open ones.
 */

export interface Env {
  DB: D1Database
}

interface PermitBody {
  kind: string  // ERC2612_PERMIT | AAVE_DELEGATION | MORPHO_AUTHORIZATION | AAVE_DELEGATION_TX
  targetAddress: string
  signature: { v: number; r: string; s: string }
  deadline: string
  nonce: string
}

interface SignedOrderBody {
  signer: string
  signature: string
  order: {
    merkleRoot: string
    deadline: number
    settlementData: string
    orderData: string
    executionData: string
    fillerCalldata: string
    chainId: number
    maxFeeBps: number
    solver: string
    minSolverReputation: number
    leaves: Array<{
      op: number
      lenderId: number
      data: string
      leaf: string
      proof: string[]
    }>
  }
  permits?: PermitBody[]
}

function generateId(): string {
  return crypto.randomUUID()
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders() })
}

// ── Routes ──────────────────────────────────────────────────────────────

async function handleCreateOrder(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as SignedOrderBody

  if (!body.signer || !body.signature || !body.order) {
    return json({ error: 'Missing required fields: signer, signature, order' }, 400)
  }

  const id = generateId()
  const o = body.order

  await env.DB.prepare(
    `INSERT INTO orders (id, signer, signature, merkle_root, deadline, chain_id, max_fee_bps, solver, min_solver_reputation, settlement_data, order_data, execution_data, filler_calldata, leaves, permits, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
  )
    .bind(
      id,
      body.signer,
      body.signature,
      o.merkleRoot,
      o.deadline,
      o.chainId,
      o.maxFeeBps,
      o.solver,
      o.minSolverReputation,
      o.settlementData,
      o.orderData,
      o.executionData,
      o.fillerCalldata,
      JSON.stringify(o.leaves),
      JSON.stringify(body.permits ?? [])
    )
    .run()

  return json({ id, status: 'open' }, 201)
}

async function handleGetOrders(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const signer = url.searchParams.get('signer')
  const solver = url.searchParams.get('solver')
  const chainId = url.searchParams.get('chainId')
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 100)
  const offset = parseInt(url.searchParams.get('offset') ?? '0')

  const conditions: string[] = []
  const params: unknown[] = []

  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }
  if (signer) {
    conditions.push('LOWER(signer) = LOWER(?)')
    params.push(signer)
  }
  if (solver) {
    conditions.push('LOWER(solver) = LOWER(?)')
    params.push(solver)
  }
  if (chainId) {
    conditions.push('chain_id = ?')
    params.push(parseInt(chainId))
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const query = `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const result = await env.DB.prepare(query)
    .bind(...params)
    .all()

  // Map DB rows back to the SignedOrder shape
  const orders = result.results.map((row: Record<string, unknown>) => ({
    id: row.id,
    signer: row.signer,
    signature: row.signature,
    status: row.status,
    txHash: row.tx_hash,
    createdAt: row.created_at,
    order: {
      merkleRoot: row.merkle_root,
      deadline: row.deadline,
      settlementData: row.settlement_data,
      orderData: row.order_data,
      executionData: row.execution_data,
      fillerCalldata: row.filler_calldata,
      chainId: row.chain_id,
      maxFeeBps: row.max_fee_bps,
      solver: row.solver,
      minSolverReputation: row.min_solver_reputation,
      leaves: JSON.parse(row.leaves as string),
    },
    permits: JSON.parse((row.permits as string) || '[]'),
  }))

  return json(orders)
}

async function handleGetOrder(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first()

  if (!row) return json({ error: 'Order not found' }, 404)

  return json({
    id: row.id,
    signer: row.signer,
    signature: row.signature,
    status: row.status,
    txHash: row.tx_hash,
    createdAt: row.created_at,
    order: {
      merkleRoot: row.merkle_root,
      deadline: row.deadline,
      settlementData: row.settlement_data,
      orderData: row.order_data,
      executionData: row.execution_data,
      fillerCalldata: row.filler_calldata,
      chainId: row.chain_id,
      maxFeeBps: row.max_fee_bps,
      solver: row.solver,
      minSolverReputation: row.min_solver_reputation,
      leaves: JSON.parse(row.leaves as string),
    },
    permits: JSON.parse((row.permits as string) || '[]'),
  })
}

async function handleUpdateStatus(
  id: string,
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as { status: string; txHash?: string }

  if (!['open', 'filled', 'cancelled', 'expired'].includes(body.status)) {
    return json({ error: 'Invalid status. Must be: open, filled, cancelled, expired' }, 400)
  }

  const result = await env.DB.prepare(
    `UPDATE orders SET status = ?, tx_hash = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(body.status, body.txHash ?? null, id)
    .run()

  if (result.meta.changes === 0) {
    return json({ error: 'Order not found' }, 404)
  }

  return json({ id, status: body.status })
}

// ── Worker entry ────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/health') {
      return json({ status: 'ok', service: 'verato-orders' })
    }

    // POST /orders — create a new signed order
    if (path === '/orders' && request.method === 'POST') {
      return handleCreateOrder(request, env)
    }

    // GET /orders — query orders
    if (path === '/orders' && request.method === 'GET') {
      return handleGetOrders(request, env)
    }

    // GET /orders/:id — get a single order
    const orderMatch = path.match(/^\/orders\/([a-f0-9-]+)$/)
    if (orderMatch && request.method === 'GET') {
      return handleGetOrder(orderMatch[1], env)
    }

    // PUT /orders/:id/status — update order status (filled, cancelled, etc.)
    const statusMatch = path.match(/^\/orders\/([a-f0-9-]+)\/status$/)
    if (statusMatch && request.method === 'PUT') {
      return handleUpdateStatus(statusMatch[1], request, env)
    }

    return json({ error: 'Not found' }, 404)
  },
} satisfies ExportedHandler<Env>
