import { http, createConfig } from 'wagmi'
import { celo, mainnet, optimism, polygon, arbitrum, base, avalanche, bsc } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

export const config = createConfig({
  chains: [celo, mainnet, optimism, polygon, arbitrum, base, avalanche, bsc],
  connectors: [
    injected(),
  ],
  transports: {
    [celo.id]: http(),
    [mainnet.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [arbitrum.id]: http(),
    [base.id]: http(),
    [avalanche.id]: http(),
    [bsc.id]: http(),
  },
})
