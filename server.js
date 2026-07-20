const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Server } = require('socket.io');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const AVATAR_DIR = path.join(__dirname, 'public', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => {
      cb(null, crypto.randomBytes(8).toString('hex') + IMAGE_TYPES[file.mimetype]);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, !!IMAGE_TYPES[file.mimetype]);
  },
});

app.post('/upload/avatar', upload.single('avatar'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Envie uma imagem PNG, JPG, GIF ou WebP.' });
  }
  res.json({ url: '/uploads/avatars/' + req.file.filename });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Imagem muito grande (máximo 2 MB).' });
  }
  next(err);
});

const users = new Map();

function isNameTaken(name, exceptId) {
  const lower = name.toLowerCase();
  for (const [id, user] of users) {
    if (id !== exceptId && user.name.toLowerCase() === lower) return true;
  }
  return false;
}

function validateProfile(profile) {
  if (!profile || typeof profile.name !== 'string') return 'Perfil inválido.';
  const name = profile.name.trim();
  if (name.length < 2) return 'O nome precisa ter pelo menos 2 caracteres.';
  if (name.length > 20) return 'O nome pode ter no máximo 20 caracteres.';
  if (typeof profile.avatar !== 'string' || profile.avatar.length > 300) return 'Perfil inválido.';
  return '';
}

function userList() {
  return [...users.values()];
}

io.on('connection', (socket) => {
  socket.on('join', (profile, callback) => {
    if (typeof callback !== 'function') return;

    const error = validateProfile(profile);
    if (error) return callback({ error });

    const name = profile.name.trim();
    if (isNameTaken(name, socket.id)) {
      return callback({ error: `O nome "${name}" já está em uso. Escolha outro.` });
    }

    users.set(socket.id, { name, color: profile.color, avatar: profile.avatar });
    callback({ ok: true });

    socket.emit('chat-history', db.getRecentMessages(50));

    socket.broadcast.emit('system-message', `${name} entrou no chat`);
    io.emit('user-list', userList());
  });

  socket.on('update-profile', (profile, callback) => {
    if (typeof callback !== 'function') return;

    const current = users.get(socket.id);
    if (!current) return callback({ error: 'Você não está conectado ao chat.' });

    const error = validateProfile(profile);
    if (error) return callback({ error });

    const name = profile.name.trim();
    if (isNameTaken(name, socket.id)) {
      return callback({ error: `O nome "${name}" já está em uso. Escolha outro.` });
    }

    const oldName = current.name;
    users.set(socket.id, { name, color: profile.color, avatar: profile.avatar });
    callback({ ok: true });

    if (oldName !== name) {
      io.emit('system-message', `${oldName} mudou o nome para ${name}`);
    }
    io.emit('user-list', userList());
  });

  socket.on('chat-message', (text) => {
    const user = users.get(socket.id);
    if (!user || typeof text !== 'string') return;

    const trimmed = text.trim().slice(0, 500);
    if (!trimmed) return;

    const message = {
      author: user.name,
      color: user.color,
      avatar: user.avatar,
      text: trimmed,
      time: Date.now(),
    };
    db.saveMessage(message);
    io.emit('chat-message', message);
  });

  socket.on('private-message', (payload, callback) => {
    const ack = typeof callback === 'function' ? callback : () => {};

    const user = users.get(socket.id);
    if (!user || !payload || typeof payload.to !== 'string' || typeof payload.text !== 'string') {
      return ack({ error: 'Mensagem inválida.' });
    }

    const text = payload.text.trim().slice(0, 500);
    if (!text) return ack({ error: 'Mensagem vazia.' });

    const toLower = payload.to.toLowerCase();
    let targetId = null;
    let targetName = null;
    for (const [id, u] of users) {
      if (u.name.toLowerCase() === toLower) {
        targetId = id;
        targetName = u.name;
        break;
      }
    }

    if (!targetId) return ack({ error: `${payload.to} não está online.` });
    if (targetId === socket.id) return ack({ error: 'Você não pode enviar mensagem para si mesmo.' });

    const message = {
      from: user.name,
      to: targetName,
      color: user.color,
      avatar: user.avatar,
      text,
      time: Date.now(),
    };
    io.to(targetId).emit('private-message', message);
    socket.emit('private-message', message);
    ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (!user) return;

    users.delete(socket.id);
    socket.broadcast.emit('system-message', `${user.name} saiu do chat`);
    socket.broadcast.emit('user-list', userList());
  });
});

server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
