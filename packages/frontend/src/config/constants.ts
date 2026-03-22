import type { Address } from 'viem'
import { zeroAddress } from 'viem'

export const VERATO_ADDRESS = '0x8bDed3d811501273Fe60da50fbA91FD0bC25B9F1' as Address
export const FORWARDER_ADDRESS = '0x54b3c0aeB93b3A00675cb7bcC88ee9B0a25a4223' as Address
export const ORACLE_ADAPTER_ADDRESS = '0x8E41Fc8EB1e241aC5BFcE280FEC1A0b180a60343' as Address

export const ORACLE_ADDRESSES: Record<string, Address> = {
  '42220': ORACLE_ADAPTER_ADDRESS,
}

export function getOracleAddress(chainId: string): Address {
  return ORACLE_ADDRESSES[chainId] ?? zeroAddress
}

export const VERATO_ADDRESSES: Record<string, Address> = {
  '42220': VERATO_ADDRESS,  // Celo mainnet
}

/** Pool addresses by lenderKey → chainId → pool address */
export const POOL_BY_LENDER: Record<string, Record<string, Address>> = {
  AAVE_V3: {
    '42220': '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402',
    '1':     '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    '10':    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    '137':   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    '42161': '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    '8453':  '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    '43114': '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    '56':    '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  },
  MOOLA: {
    '42220': '0x970b12522CA9b4054807a2c5B736149a5BE6f670',
  },
  AAVE_V2: {
    '1':     '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
    '137':   '0x8dff5e27ea6b7ac08ebfdf9eb090f32ee9a30fcf',
    '43114': '0x4F01AeD16D97E3aB5ab2B501154DC9bb0F1A5A2C',
  },
}

/** Legacy: default pool per chain (Aave V3) */
export const POOL_ADDRESSES: Record<string, Address> = POOL_BY_LENDER.AAVE_V3

export const ORDER_BACKEND_URL = import.meta.env.VITE_ORDER_BACKEND_URL ?? 'http://localhost:8787'
export const PORTAL_PROXY_URL = import.meta.env.VITE_PORTAL_PROXY_URL ?? 'http://localhost:8788'

export function getVeratoAddress(chainId: string): Address {
  return VERATO_ADDRESSES[chainId] ?? zeroAddress
}

export function getPoolAddress(chainId: string, lenderKey?: string): Address {
  if (lenderKey && POOL_BY_LENDER[lenderKey]?.[chainId]) {
    return POOL_BY_LENDER[lenderKey][chainId]
  }
  return POOL_ADDRESSES[chainId] ?? zeroAddress
}
