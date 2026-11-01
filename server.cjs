
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')

const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost:5173',
      'http://localhost:5174'
    ]
  }
})

const utenti = new Map()
const occupati = new Map()

io.on('connection', socket => {
  socket.on('register', numero => {
    const n = String(numero)

    if (!/^\d{6}$/.test(n)) return

    // Se lo stesso numero era già collegato, sostituisce la vecchia connessione.
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
    }

    occupati.delete(socket.id)
    if (destinatario) occupati.delete(destinatario)
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

server.listen(3001, () => {
  console.log('ER:LC Phone server attivo sulla porta 3001')
})
