
import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const SERVER = 'https://erlc-phone-1.onrender.com'

const socket = io(SERVER, {
  autoConnect: false,
  transports: ['websocket', 'polling']
})

export default function App() {
  const [numero, setNumero] = useState('')
  const [pagina, setPagina] = useState('Telefono')
  const [stato, setStato] = useState('Inattiva')
  const [numeroPersonale] = useState(() => {
    let salvato = localStorage.getItem('erlc-mio-numero')

    if (!salvato) {
      salvato = String(Math.floor(100000 + Math.random() * 900000))
      localStorage.setItem('erlc-mio-numero', salvato)
    }

    return salvato
  })

  const [chiamataEntrante, setChiamataEntrante] = useState(null)
  const [connesso, setConnesso] = useState(false)

  const peerRef = useRef(null)
  const streamRef = useRef(null)
  const numeroChiamataRef = useRef('')
  const candidatiRef = useRef([])

  const tasti = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

  async function creaPeer() {
    const response = await fetch(`${SERVER}/ice-config`)

    if (!response.ok) {
      throw new Error('Impossibile caricare la configurazione audio')
    }

    const config = await response.json()
    const peer = new RTCPeerConnection(config)

    peer.onicecandidate = event => {
      if (event.candidate && numeroChiamataRef.current) {
        socket.emit('ice-candidate', {
          to: numeroChiamataRef.current,
          candidate: event.candidate
        })
      }
    }

    peer.ontrack = event => {
      const audio = document.getElementById('audio-remoto')

      if (audio) {
        audio.srcObject = event.streams[0]
        audio.play().catch(error => {
          console.log('Avvia manualmente l’audio:', error)
        })
      }
    }

    peer.onconnectionstatechange = () => {
      console.log('Stato audio:', peer.connectionState)

      if (peer.connectionState === 'connected') {
        setStato('Chiamata connessa')
      }

      if (peer.connectionState === 'failed') {
        setStato('Errore nella connessione audio')
      }
    }

    peerRef.current = peer
    return peer
  }

  async function aggiungiCandidatiInAttesa(peer) {
    const candidati = [...candidatiRef.current]
    candidatiRef.current = []

    for (const candidate of candidati) {
      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (error) {
        console.error('Errore ICE:', error)
      }
    }
  }

  async function prendiMicrofono() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
  }

  function chiudiChiamata(messaggio = 'Chiamata terminata') {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }

    if (peerRef.current) {
      peerRef.current.close()
      peerRef.current = null
    }

    const audio = document.getElementById('audio-remoto')
    if (audio) {
      audio.srcObject = null
    }

    numeroChiamataRef.current = ''
    candidatiRef.current = []
    setChiamataEntrante(null)
    setStato(messaggio)
  }

  async function chiama() {
    if (!connesso) {
      setStato('Server non collegato')
      return
    }

    if (!/^\d{6}$/.test(numero)) {
      setStato('Inserisci un numero di 6 cifre')
      return
    }

    if (numero === numeroPersonale) {
      setStato('Non puoi chiamare te stesso')
      return
    }

    try {
      setStato('Chiamata in corso...')

      const stream = await prendiMicrofono()
      streamRef.current = stream

      const peer = await creaPeer()

      stream.getTracks().forEach(track => {
        peer.addTrack(track, stream)
      })

      numeroChiamataRef.current = numero

      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)

      socket.emit('call-user', {
        to: numero,
        offer
      })
    } catch (error) {
      console.error(error)
      chiudiChiamata('Errore microfono o server TURN')
    }
  }

  async function rispondi() {
    if (!chiamataEntrante) return

    try {
      const chiamata = chiamataEntrante

      const stream = await prendiMicrofono()
      streamRef.current = stream

      const peer = await creaPeer()

      stream.getTracks().forEach(track => {
        peer.addTrack(track, stream)
      })

      numeroChiamataRef.current = chiamata.from

      await peer.setRemoteDescription(
        new RTCSessionDescription(chiamata.offer)
      )

      await aggiungiCandidatiInAttesa(peer)

      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)

      socket.emit('answer-call', {
        to: chiamata.from,
        answer
      })

      setChiamataEntrante(null)
      setStato('Connessione in corso...')
    } catch (error) {
      console.error(error)
      socket.emit('reject-call', {
        to: chiamataEntrante.from
      })
      chiudiChiamata('Microfono non disponibile')
    }
  }

  function rifiuta() {
    if (chiamataEntrante) {
      socket.emit('reject-call', {
        to: chiamataEntrante.from
      })
    }

    chiudiChiamata('Chiamata rifiutata')
  }

  function termina() {
    socket.emit('end-call')
    chiudiChiamata()
  }

  useEffect(() => {
    function allaConnessione() {
      setConnesso(true)
      socket.emit('register', numeroPersonale)
    }

    function allaDisconnessione() {
      setConnesso(false)
      chiudiChiamata('Server disconnesso')
    }

    function chiamataRicevuta(dati) {
      setChiamataEntrante(dati)
      setStato('Chiamata in arrivo!')
    }

    async function chiamataAccettata({ answer }) {
      const peer = peerRef.current

      if (!peer) return

      try {
        await peer.setRemoteDescription(
          new RTCSessionDescription(answer)
        )

        await aggiungiCandidatiInAttesa(peer)
        setStato('Connessione in corso...')
      } catch (error) {
        console.error('Errore risposta:', error)
        chiudiChiamata('Errore connessione audio')
      }
    }

    async function candidatoRicevuto({ candidate }) {
      const peer = peerRef.current

      if (!peer || !peer.remoteDescription) {
        candidatiRef.current.push(candidate)
        return
      }

      try {
        await peer.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (error) {
        console.error('Errore ICE:', error)
      }
    }

    socket.on('connect', allaConnessione)
    socket.on('disconnect', allaDisconnessione)
    socket.on('incoming-call', chiamataRicevuta)
    socket.on('call-answered', chiamataAccettata)
    socket.on('ice-candidate', candidatoRicevuto)
    socket.on('call-failed', messaggio => chiudiChiamata(messaggio))
    socket.on('call-rejected', () => chiudiChiamata('Chiamata rifiutata'))
    socket.on('call-ended', () => chiudiChiamata('L’altro utente ha terminato'))

    socket.connect()

    return () => {
      socket.off('connect', allaConnessione)
      socket.off('disconnect', allaDisconnessione)
      socket.off('incoming-call', chiamataRicevuta)
      socket.off('call-answered', chiamataAccettata)
      socket.off('ice-candidate', candidatoRicevuto)
      socket.off('call-failed')
      socket.off('call-rejected')
      socket.off('call-ended')
      socket.disconnect()

      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }

      if (peerRef.current) peerRef.current.close()
    }
  }, [numeroPersonale])

  return (
    <main className="app">
      <header className="topbar">
        <div className="logo">📱 ER:LC <span>PHONE</span></div>
        <div className="status">
          <i /> {connesso ? 'Sistema online' : 'Connessione al server...'}
        </div>
      </header>

      <section className="layout">
        <aside className="sidebar">
          <h2>ER:LC Phone</h2>

          {['Telefono', 'Contatti', 'Chiamate'].map(item => (
            <button
              key={item}
              className={pagina === item ? 'nav active' : 'nav'}
              onClick={() => setPagina(item)}
            >
              {item === 'Telefono' ? '☎' : item === 'Contatti' ? '♙' : '◷'}
              {'  '}{item}
            </button>
          ))}

          <p className="small">ROLEPLAY COMMUNICATION</p>
        </aside>

        <section className="content">
          <div>
            <p className="eyebrow">EMERGENCY RESPONSE: LIBERTY COUNTY</p>
            <h1>{pagina}</h1>
            <p className="muted">Il tuo telefono virtuale per il roleplay.</p>
          </div>

          <div className="phone">
            <div className="speaker" />

            <div className="phone-screen">
              <div className="phone-head">
                <span>ER:LC</span>
                <span>● Wi-Fi</span>
              </div>

              <div className="display">
                <small>Il tuo numero personale</small>
                <strong>{numeroPersonale}</strong>
              </div>

              {pagina === 'Telefono' && (
                <>
                  <div className="display">
                    <small>Numero da chiamare</small>
                    <strong>{numero || 'Inserisci numero'}</strong>
                  </div>

                  <div className="keypad">
                    {tasti.map(tasto => (
                      <button
                        key={tasto}
                        onClick={() => setNumero(n => (n + tasto).slice(0, 6))}
                      >
                        {tasto}
                      </button>
                    ))}
                  </div>

                  <button className="call" onClick={chiama}>
                    ☎ &nbsp; CHIAMA
                  </button>

                  <button
                    className="clear"
                    onClick={() => setNumero(n => n.slice(0, -1))}
                  >
                    Cancella ultima cifra
                  </button>

                  {chiamataEntrante && (
                    <div className="placeholder">
                      <h3>📞 Chiamata in arrivo!</h3>
                      <p>Da: {chiamataEntrante.from}</p>
                      <button className="call" onClick={rispondi}>
                        RISPONDI
                      </button>
                      <button className="clear" onClick={rifiuta}>
                        RIFIUTA
                      </button>
                    </div>
                  )}

                  {stato.includes('Chiamata') ||
                  stato.includes('Connessione') ? (
                    <button className="clear" onClick={termina}>
                      TERMINA CHIAMATA
                    </button>
                  ) : null}

                  <p>{stato}</p>
                </>
              )}

              {pagina === 'Contatti' && (
                <div className="placeholder">
                  <span>♙</span>
                  <h3>I tuoi contatti</h3>
                  <p>Presto potrai aggiungere i tuoi amici.</p>
                </div>
              )}

              {pagina === 'Chiamate' && (
                <div className="placeholder">
                  <span>◷</span>
                  <h3>Chiamate recenti</h3>
                  <p>Presto vedrai qui le chiamate recenti.</p>
                </div>
              )}
            </div>

            <div className="home-button" />
          </div>

          <audio id="audio-remoto" autoPlay playsInline />

          <p className="footnote">
            Le chiamate vocali funzionano tra utenti collegati al server.
          </p>
        </section>
      </section>
    </main>
  )
}
