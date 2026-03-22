import { useState, useRef, useEffect } from 'react'
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { celo } from 'wagmi/chains'
import Configurator from './components/Configurator'

const APP_CHAIN = celo

// ── Logo ─────────────────────────────────────────────────────────────────

function VeratoLogo({ className = 'h-8' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        {/* Outer hex — cyan to violet diagonal sweep */}
        <linearGradient id="vg1" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="0.4" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
        {/* Inner glow — teal to purple */}
        <linearGradient id="vg2" x1="13" y1="12" x2="35" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#67e8f9" />
          <stop offset="0.5" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#f472b6" />
        </linearGradient>
        {/* V strokes — bright white-cyan to electric violet */}
        <linearGradient id="vg3" x1="15" y1="16" x2="33" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#e0f2fe" />
          <stop offset="0.35" stopColor="#67e8f9" />
          <stop offset="0.7" stopColor="#c084fc" />
          <stop offset="1" stopColor="#f472b6" />
        </linearGradient>
        {/* Ambient glow filter */}
        <filter id="vglow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {/* Outer hexagon — cyan→violet→pink gradient */}
      <polygon
        points="24,2 44,14 44,34 24,46 4,34 4,14"
        fill="url(#vg1)"
      />
      {/* Mid hexagon ring — dark cutout */}
      <polygon
        points="24,7 39,16.5 39,31.5 24,41 9,31.5 9,16.5"
        fill="#07080f"
      />
      {/* Inner hexagon — subtle gradient fill */}
      <polygon
        points="24,11 35,18 35,30 24,37 13,30 13,18"
        fill="url(#vg2)"
        opacity="0.08"
      />
      {/* Outer V — bold, glowing */}
      <path
        d="M15,18 L24,34 L33,18"
        stroke="url(#vg3)"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        filter="url(#vglow)"
      />
      {/* Inner V — ghosted depth layer */}
      <path
        d="M19,21 L24,30 L29,21"
        stroke="url(#vg2)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        opacity="0.45"
      />
      {/* Crown diamond */}
      <polygon
        points="24,9 26,12 24,15 22,12"
        fill="url(#vg3)"
        opacity="0.8"
        filter="url(#vglow)"
      />
    </svg>
  )
}

// ── SVG Icons ───────────────────────────────────────────────────────────

function WalletIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a1 1 0 1 0 2 0 1 1 0 0 0-2 0z" fill="currentColor" />
    </svg>
  )
}

function MetaMaskIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M21.3 2L13.1 8.2l1.5-3.6L21.3 2z" fill="#E2761B" stroke="#E2761B" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2.7 2l8.1 6.3-1.4-3.7L2.7 2zM18.4 17.2l-2.2 3.3 4.6 1.3 1.3-4.5-3.7-.1zM1.9 17.3l1.3 4.5 4.6-1.3-2.2-3.3-3.7.1z" fill="#E4761B" stroke="#E4761B" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 10.7l-1.3 2 4.6.2-.2-5-3.1 2.8zM16.5 10.7l-3.2-2.9-.1 5.1 4.6-.2-1.3-2zM7.8 20.5l2.8-1.4-2.4-1.9-.4 3.3zM13.4 19.1l2.8 1.4-.4-3.3-2.4 1.9z" fill="#E4761B" stroke="#E4761B" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.2 20.5l-2.8-1.4.2 1.8v.8l2.6-1.2zM7.8 20.5l2.6 1.2v-.8l.2-1.8-2.8 1.4z" fill="#D7C1B3" stroke="#D7C1B3" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 16l-2.3-.7 1.6-.7.7 1.4zM13.5 16l.7-1.4 1.6.7-2.3.7z" fill="#233447" stroke="#233447" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.8 20.5l.4-3.3-2.6.1 2.2 3.2zM15.8 17.2l.4 3.3 2.2-3.2-2.6-.1zM17.8 12.7l-4.6.2.4 2.1.7-1.4 1.6.7 1.9-1.6zM8.2 14.3l1.6-.7.7 1.4.4-2.1-4.6-.2 1.9 1.6z" fill="#CD6116" stroke="#CD6116" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.2 12.7l2 3.9-.1-1.6-1.9-2.3zM15.9 14.3l-.1 1.6 2-3.9-1.9 2.3zM10.9 12.9l-.4 2.1.5 2.6.1-3.4-0.2-1.3zM13.2 12.9l-.2 1.2.1 3.5.5-2.6-.4-2.1z" fill="#E4751F" stroke="#E4751F" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.6 15l-.5 2.6.4.3 2.4-1.9.1-1.6-2.4.6zM8.2 14.3l.1 1.6 2.4 1.9.4-.3-.5-2.6-2.4-.6z" fill="#F6851B" stroke="#F6851B" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.6 21.7v-.8l-.2-.2H10.6l-.2.2v.8L7.8 20.5l.9.8 1.9 1.3h2.8l1.9-1.3.9-.8-2.6 1.2z" fill="#C0AD9E" stroke="#C0AD9E" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.4 19.1l-.4-.3h-2l-.4.3-.2 1.8.2-.2h2.8l.2.2-.2-1.8z" fill="#161616" stroke="#161616" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21.7 8.6l.7-3.3L21.3 2l-7.9 5.9 3.1 2.6 4.3 1.3.9-1.1-.4-.3.7-.6-.5-.4.7-.5-.4-.3zM1.6 5.3l.7 3.3-.5.3.7.5-.5.4.7.6-.4.3.9 1.1 4.3-1.3 3.1-2.6L2.7 2 1.6 5.3z" fill="#763D16" stroke="#763D16" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20.8 11.8l-4.3-1.3 1.3 2-2 3.9 2.6-.1h3.8l-1.4-4.5zM7.5 10.5l-4.3 1.3-1.4 4.5h3.8l2.6.1-2-3.9 1.3-2zM13.2 12.9l.3-4.8 1.2-3.4H9.4l1.1 3.4.3 4.8.1 1.3v3.4h2l.1-3.4.2-1.3z" fill="#F6851B" stroke="#F6851B" strokeWidth="0.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronDownIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

function PowerIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  )
}

function SwitchIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
    </svg>
  )
}

function CopyIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

// ── Wallet Popover ──────────────────────────────────────────────────────

function WalletButton() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const wrongChain = isConnected && chainId !== APP_CHAIN.id

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const copyAddress = () => {
    if (address) {
      navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  // Connected state — pill button that opens popover
  if (isConnected) {
    return (
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen(!open)}
          className={`flex items-center gap-2 px-3 py-2 rounded-xl border transition-all ${
            wrongChain
              ? 'border-amber-500/50 bg-amber-900/20 hover:bg-amber-900/30'
              : 'border-gray-700 bg-gray-900 hover:bg-gray-800'
          }`}
        >
          <div className={`w-2 h-2 rounded-full ${wrongChain ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
          <span className="text-sm font-mono text-gray-200">
            {address?.slice(0, 6)}...{address?.slice(-4)}
          </span>
          <ChevronDownIcon className={`w-3.5 h-3.5 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div className="absolute right-0 top-full mt-2 w-72 bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden z-50">
            {/* Address header */}
            <div className="px-4 pt-4 pb-3 border-b border-gray-800">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-linear-to-br from-indigo-500 to-emerald-500 flex items-center justify-center">
                    <WalletIcon className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <div className="text-sm font-mono text-white">
                      {address?.slice(0, 6)}...{address?.slice(-4)}
                    </div>
                    <div className={`text-xs ${wrongChain ? 'text-amber-400' : 'text-gray-500'}`}>
                      {wrongChain ? 'Wrong network' : APP_CHAIN.name}
                    </div>
                  </div>
                </div>
                <button
                  onClick={copyAddress}
                  className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
                  title="Copy address"
                >
                  {copied ? <CheckIcon className="w-3.5 h-3.5 text-emerald-400" /> : <CopyIcon />}
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="p-2">
              {wrongChain && (
                <button
                  onClick={() => {
                    switchChain({ chainId: APP_CHAIN.id })
                    setOpen(false)
                  }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-amber-300 hover:bg-amber-900/20 transition-colors"
                >
                  <SwitchIcon className="w-4 h-4" />
                  Switch to {APP_CHAIN.name}
                </button>
              )}
              <button
                onClick={() => {
                  disconnect()
                  setOpen(false)
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-red-400 hover:bg-red-900/20 transition-colors"
              >
                <PowerIcon className="w-4 h-4" />
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Disconnected state — connect button opens popover with connector list
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl transition-colors"
      >
        <WalletIcon className="w-4 h-4" />
        Connect Wallet
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl shadow-black/50 overflow-hidden z-50">
          <div className="px-4 pt-4 pb-2">
            <h3 className="text-sm font-medium text-white">Connect a Wallet</h3>
            <p className="text-xs text-gray-500 mt-0.5">Choose how you want to connect</p>
          </div>
          <div className="p-2 space-y-1">
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                onClick={() => {
                  connect({ connector, chainId: APP_CHAIN.id })
                  setOpen(false)
                }}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-xl hover:bg-gray-800 transition-colors group"
              >
                <div className="w-9 h-9 rounded-xl bg-gray-800 group-hover:bg-gray-700 flex items-center justify-center transition-colors">
                  {connector.name.toLowerCase().includes('metamask') ? (
                    <MetaMaskIcon className="w-5 h-5" />
                  ) : (
                    <WalletIcon className="w-4 h-4 text-gray-400" />
                  )}
                </div>
                <div className="text-left">
                  <div className="text-sm font-medium text-white">{connector.name}</div>
                  <div className="text-xs text-gray-500">
                    {connector.name.toLowerCase().includes('metamask')
                      ? 'Browser extension'
                      : connector.name.toLowerCase().includes('injected')
                      ? 'Browser wallet'
                      : 'Connect'}
                  </div>
                </div>
              </button>
            ))}
          </div>
          <div className="px-4 py-3 border-t border-gray-800">
            <p className="text-xs text-gray-600 text-center">
              Connecting to {APP_CHAIN.name}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Chain Banner ────────────────────────────────────────────────────────

function ChainBanner() {
  const { isConnected, chainId } = useAccount()
  const { switchChain } = useSwitchChain()

  if (!isConnected || chainId === APP_CHAIN.id) return null

  return (
    <div className="bg-amber-900/40 border-b border-amber-700/50 px-6 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <SwitchIcon className="w-4 h-4 text-amber-400" />
        <span className="text-sm text-amber-300">
          Verato operates on {APP_CHAIN.name}. Please switch your wallet.
        </span>
      </div>
      <button
        onClick={() => switchChain({ chainId: APP_CHAIN.id })}
        className="text-xs bg-amber-600 hover:bg-amber-500 text-white px-3 py-1 rounded-lg transition-colors"
      >
        Switch Network
      </button>
    </div>
  )
}

// ── App ─────────────────────────────────────────────────────────────────

function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-white relative overflow-hidden">
      {/* Background gradient */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[600px] h-[600px] bg-amber-500/[0.03] rounded-full blur-[120px]" />
        <div className="absolute top-1/3 right-0 w-[500px] h-[500px] bg-emerald-500/[0.03] rounded-full blur-[100px]" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-indigo-500/[0.02] rounded-full blur-[100px]" />
      </div>
      <header className="relative border-b border-gray-800/80 backdrop-blur-sm px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <VeratoLogo className="h-12 w-12" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Verato</h1>
            <p className="text-sm text-gray-500">Agent Settlement Gateway on {APP_CHAIN.name}</p>
          </div>
        </div>
        <WalletButton />
      </header>

      <ChainBanner />

      <main className="px-6 py-8">
        <Configurator />
      </main>
    </div>
  )
}

export default App
