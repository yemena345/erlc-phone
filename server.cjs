const express = require('express')
const http = require('http')
const { Server } = require('socket.io')

const app = express()
const server = http.createServer(app)

const allowedOrigins = [
  'https://erlc-phone.vercel.app',
  'http://localhost:5173',
  'http://localhost:5174'
]

app.use((req, res, next) => {
  const origin = req.headers.origin

  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }

  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

app.get('/ice-config', (req, res) => {
  const username = process.env.TURN_USERNAME
  const credential = process.env.TURN_PASSWORD

  const iceServers = [
    { urls: 'stun:stun.relay.metered.ca:80' }
  ]

  if (username && credential) {
    iceServers.push(
      {
        urls: 'turn:global.relay.metered.ca:80',
        username,
        credential
      },
      {
        urls: 'turn:global.relay.metered.ca:80?transport=tcp',
        username,
        credential
      },
      {
        urls: 'turn:global.relay.metered.ca:443',
        username,
        credential
      },
      {
        urls: 'turns:global.relay.metered.ca:443?transport=tcp',
        username,
        credential
      }
    )
  }

  res.json({ iceServers })
})

const io = new Server(server, {
  cors: { origin: allowedOrigins }
})

const utenti = new Map()
const occupati = new Map()

io.on('connection', socket => {
  socket.on('register', numero => {
    const n = String(numero)

    if (!/^\d{6}$/.test(n)) return

    const precedente = utenti.get(n)

    if (precedente && precedente !== socket.id) {
      io.to(precedente).emit('disconnected')
      occupati.delete(precedente)
    }

    socket.numero = n
    utenti.set(n, socket.id)

    console.log('Utente online:', n)
    socket.emit('registered', n)
  })

  socket.on('call-user', ({ to, offer }) => {
    const destinatario = utenti.get(String(to))

    if (!destinatario) {
      socket.emit('call-failed', 'Numero non online o inesistente.')
      return
    }

    if (destinatario === socket.id) {
      socket.emit('call-failed', 'Non puoi chiamare te stesso.')
      return
    }

    if (occupati.has(socket.id) || occupati.has(destinatario)) {
      socket.emit('call-failed', 'Uno dei due utenti è già impegnato.')
      return
    }

    occupati.set(socket.id, destinatario)
    occupati.set(destinatario, socket.id)

    io.to(destinatario).emit('incoming-call', {
      from: socket.numero,
      offer
    })
  })

  socket.on('answer-call', ({ to, answer }) => {
    const destinatario = utenti.get(String(to))
    if (!destinatario || occupati.get(socket.id) !== destinatario) return

    io.to(destinatario).emit('call-answered', { answer })
  })

  socket.on('ice-candidate', ({ to, candidate }) => {
    const destinatario = utenti.get(String(to))
    if (!destinatario || occupati.get(socket.id) !== destinatario) return

    io.to(destinatario).emit('ice-candidate', { candidate })
  })

  socket.on('reject-call', ({ to }) => {
    const destinatario = utenti.get(String(to))

    if (destinatario) {
      io.to(destinatario).emit('call-rejected')
      occupati.delete(destinatario)
    }

    occupati.delete(socket.id)
  })

  socket.on('end-call', () => {
    const destinatario = occupati.get(socket.id)

    if (destinatario) {
      io.to(destinatario).emit('call-ended')
      occupati.delete(destinatario)
    }

    occupati.delete(socket.id)
  })

  socket.on('disconnect', () => {
    if (socket.numero && utenti.get(socket.numero) === socket.id) {
      utenti.delete(socket.numero)
    }

    const destinatario = occupati.get(socket.id)

    if (destinatario) {
      io.to(destinatario).emit('call-ended')
      occupati.delete(destinatario)
    }

    occupati.delete(socket.id)
    console.log('Utente disconnesso:', socket.numero || socket.id)
  })
})

const PORT = process.env.PORT || 3001

server.listen(PORT, () => {
  console.log(`ER:LC Phone server attivo sulla porta ${PORT}`)
})
