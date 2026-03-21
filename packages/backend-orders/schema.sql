CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  signer TEXT NOT NULL,
  signature TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  deadline INTEGER NOT NULL,
  chain_id INTEGER NOT NULL,
  max_fee_bps INTEGER NOT NULL,
  solver TEXT NOT NULL,
  min_solver_reputation INTEGER NOT NULL,
  settlement_data TEXT NOT NULL,
  order_data TEXT NOT NULL,
  execution_data TEXT NOT NULL,
  filler_calldata TEXT NOT NULL,
  leaves TEXT NOT NULL,          -- JSON array of MerkleLeaf
  permits TEXT NOT NULL DEFAULT '[]',  -- JSON array of user permit/delegation signatures
  status TEXT NOT NULL DEFAULT 'open',  -- open | filled | cancelled | expired
  tx_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_signer ON orders(signer);
CREATE INDEX IF NOT EXISTS idx_orders_solver ON orders(solver);
CREATE INDEX IF NOT EXISTS idx_orders_deadline ON orders(deadline);
CREATE INDEX IF NOT EXISTS idx_orders_chain_id ON orders(chain_id);
