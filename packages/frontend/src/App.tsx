import Configurator from './components/Configurator'

function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="border-b border-gray-800 px-6 py-4">
        <h1 className="text-2xl font-bold">Delta Synthesis</h1>
        <p className="text-sm text-gray-500">Lending Permission Configurator</p>
      </header>

      <main className="px-6 py-8">
        <Configurator />
      </main>
    </div>
  )
}

export default App
