
import { useState, useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import './App.css'

const socket = io('http://localhost:3001', {
  autoConnect: false
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
  const [chiamante, setChiamante] = useState('')
  const [connesso, setConnesso] = useState(false)

  const peerRef = useRef(null)
  const streamRef = useRef(null)
  const numeroChiamataRef = useRef('')
  const offertaRef = useRef(null)

  const tasti = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

  function chiudiChiamata(messaggio = 'Chiamata terminata') {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }

    if (peerRef.current) {
      peerRef.current.close()
      peerRef.current = null
    }

    numeroChiamataRef.current = ''
    offertaRef.current = null
    setChiamataEntrante(null)
    setChiamante('')
    setStato(messaggio)
  }

  function creaPeer() {
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
      ]
    })

    peer.onicecandidate = event => {
      if (event.candidate && numeroChiamataRef.current) {
        socket.emit('ice-candidate', {
          to: numeroChiamataRef.current,
          candidate: event.candidate
        })
      }
    }

    peer.ontrack = event => {
      let audio = document.getElementById('audio-remoto')
      if (audio) {
        audio.srcObject = event.streams[0]
        audio.play().catch(() => {})
      }
    }

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        setStato('Chiamata connessa')
      }

      if (
        peer.connectionState === 'failed' ||
        peer.connectionState === 'disconnected' ||
        peer.connectionState === 'closed'
      ) {
        if (peerRef.current === peer) {
          chiudiChiamata('Connessione terminata')
        }
      }
    }

    peerRef.current = peer
    return peer
  }

  async function prendiMicrofono() {
    return await navigator.mediaDevices.getUserMedia({ audio: true })
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

      const peer = creaPeer()
      stream.getTracks().forEach(track => peer.addTrack(track, stream))

      numeroChiamataRef.current = numero

      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)

      socket.emit('call-user', {
        to: numero,
        offer
      })
    } catch (errore) {
      chiudiChiamata('Impossibile avviare la chiamata. Controlla il microfono.')
    }
  }

  async function rispondi() {
    if (!chiamataEntrante) return

    try {
      const stream = await prendiMicrofono()
      streamRef.current = stream

      const peer = creaPeer()
      stream.getTracks().forEach(track => peer.addTrack(track, stream))

      numeroChiamataRef.current = chiamataEntrante.from

      await peer.setRemoteDescription(
        new RTCSessionDescription(chiamataEntrante.offer)
      )

      const answer = await peer.createAnswer()
      await peer.setLocalDescription(answer)

      socket.emit('answer-call', {
        to: chiamataEntrante.from,
        answer
      })

      setChiamante(chiamataEntrante.from)
      setChiamataEntrante(null)
      setStato('Connessione in corso...')
    } catch (errore) {
      socket.emit('reject-call', { to: chiamataEntrante.from })
      chiudiChiamata('Microfono non disponibile')
    }
  }

  function rifiuta() {
    if (chiamataEntrante) {
      socket.emit('reject-call', { to: chiamataEntrante.from })
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
      offertaRef.current = dati.offer
      setChiamataEntrante(dati)
      setStato('Chiamata in arrivo!')
    }

    async function chiamataAccettata({ answer }) {
      if (peerRef.current) {
        await peerRef.current.setRemoteDescription(
          new RTCSessionDescription(answer)
        )
        setStato('Connessione in corso...')
      }
    }

    async function candidatoRicevuto({ candidate }) {
      if (peerRef.current && candidate) {
        try {
          await peerRef.current.addIceCandidate(
            new RTCIceCandidate(candidate)
          )
        } catch (errore) {
          console.error('Errore ICE:', errore)
        }
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
                        onClick={() => setNumero(n => n + tasto)}
                      >
                        {tasto}
                      </button>
                    ))}
                  </div>

                  <button className="call" onClick={chiama}>
                    ☎ &nbsp; CHIAMA
                  </button>

                  <button className="clear" onClick={() => setNumero(n => n.slice(0, -1))}>
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

                  {(stato === 'Chiamata connessa' ||
                    stato === 'Connessione in corso...' ||
                    stato === 'Chiamata in corso...') && (
                    <button className="clear" onClick={termina}>
                      TERMINA CHIAMATA
                    </button>
                  )}

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

          <audio id="audio-remoto" autoPlay />

          <p className="footnote">
            Le chiamate vocali funzionano tra utenti collegati al server.
          </p>
        </section>
      </section>
    </main>
  )
}
