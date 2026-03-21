import type { Address } from 'viem'
import { zeroAddress } from 'viem'

export const VERATO_ADDRESS = '0x1dfA413DBc7Df4dDb5480C91546C2DDC1646183c' as Address
export const FORWARDER_ADDRESS = '0x5B0aE3955cFD1fF296affcF1A196750Df9a7420d' as Address

export const VERATO_ADDRESSES: Record<string, Address> = {
  '42220': VERATO_ADDRESS,
}

export const POOL_ADDRESSES: Record<string, Address> = {
  '42220': '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402', // Celo Aave V3
  '1':     '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  '10':    '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  '137':   '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  '42161': '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  '8453':  '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  '43114': '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  '56':    '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
}

export const ORDER_BACKEND_URL = import.meta.env.VITE_ORDER_BACKEND_URL ?? 'http://localhost:8787'
export const PORTAL_PROXY_URL = import.meta.env.VITE_PORTAL_PROXY_URL ?? 'http://localhost:8788'

export function getVeratoAddress(chainId: string): Address {
  return VERATO_ADDRESSES[chainId] ?? zeroAddress
}

export function getPoolAddress(chainId: string): Address {
  return POOL_ADDRESSES[chainId] ?? zeroAddress
}
