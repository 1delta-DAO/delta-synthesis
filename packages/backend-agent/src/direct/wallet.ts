/**
 * Direct wallet using viem + private key from Cloudflare Worker secrets.
 *
 * Replaces the WDK wallet. The private key is injected via `init()` from the
 * Worker's Env, then all downstream code uses getWalletAddress / sendTransaction.
 */

import { createWalletClient, http, type Hex, type Address } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { RPC_URL_BY_CHAIN } from './config.js'

let _account: PrivateKeyAccount | null = null
let _rpcUrl: string | null = null

/**
 * Initialize the wallet from the Worker's PRIVATE_KEY secret.
 * Must be called once before getWalletAddress / sendTransaction.
 */
export function initWallet(privateKey: string, chainId: number) {
  _account = privateKeyToAccount(privateKey as Hex)
  _rpcUrl = RPC_URL_BY_CHAIN[chainId]
  if (!_rpcUrl) throw new Error(`No RPC URL configured for chainId ${chainId}`)
}

function requireAccount(): PrivateKeyAccount {
  if (!_account) throw new Error('Wallet not initialized — call initWallet() first')
  return _account
}

function requireRpcUrl(): string {
  if (!_rpcUrl) throw new Error('Wallet not initialized — call initWallet() first')
  return _rpcUrl
}

/** Get the agent's EVM wallet address. */
export async function getWalletAddress(_chainId: number): Promise<Address> {
  return requireAccount().address
}

/** Send a raw transaction and return the tx hash. */
export async function sendTransaction(
  chainId: number,
  tx: { to: Address; data: Hex; value?: bigint },
): Promise<string> {
  const account = requireAccount()
  const rpcUrl = requireRpcUrl()

  const walletClient = createWalletClient({
    account,
    chain: celo,
    transport: http(rpcUrl),
  })

  const hash = await walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  })

  return hash
}
