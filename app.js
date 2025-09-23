const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// CORS 허용 도메인 목록 (환경변수 FRONTEND_URL 포함)
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  null, // 로컬 파일 접근 허용용
  'https://heartfelt-cannoli-903df2.netlify.app',
];

// Socket.IO 서버 설정 및 CORS
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (!allowedOrigins.includes(origin))
        return callback(new Error('CORS 차단된 도메인'), false);
      callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
});

// 기본 환경변수 및 설정값
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_USERNAMES = process.env.ADMIN_USERNAMES ? process.env.ADMIN_USERNAMES.split(',') : [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.includes(origin))
      return callback(new Error('CORS 차단된 도메인'), false);
    callback(null, true);
  },
  credentials: true,
}));
app.use(express.json());

// trust proxy 설정으로 Render 등 프록시 환경 대응 (express-rate-limit 오류 방지)
app.set('trust proxy', 1);

// 요청 제한 설정 (1분당 20회, 다만 /api/reservations/all은 제외)
const limiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: '너무 많은 요청입니다. 잠시 후 시도해주세요.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.path === '/api/reservations/all',
});

// MongoDB 연결
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 15000,
})
  .then(() => console.log('MongoDB 연결 성공'))
  .catch(err => console.error('MongoDB 연결 실패:', err));

// 예약 스키마 및 모델 정의
const reservationSchema = new mongoose.Schema({
  roomNo: { type: String, required: true },
  name: { type: String, required: true },
  dormitory: { type: String, required: true },
  floor: { type: String, required: true },
  seat: { type: Number, required: true },
  password: { type: String, required: true },
  plainPassword: { type: String, required: true }, // 평문 비밀번호(관리자 확인용)
  createdAt: { type: Date, default: Date.now },
});
reservationSchema.index({ roomNo: 1, name: 1 }, { unique: true });
reservationSchema.index({ dormitory: 1, floor: 1, seat: 1 }, { unique: true });
reservationSchema.pre('save', async function (next) {
  if (this.isModified('password') && this.password.length < 50) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});
const Reservation = mongoose.model('Reservation', reservationSchema);

// 관리자 예약 가능 시간 설정 스키마 및 모델
const adminSettingSchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true }, // 항상 'reservationTimes'
  reservationStartTime: { type: Date, default: null },
  reservationEndTime: { type: Date, default: null },
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

// 사용자 공지사항 스키마 및 모델
const announcementSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'currentAnnouncement' },
  message: { type: String, default: '' },
  active: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now },
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// 관리자 전용 공지사항 스키마 및 모델
const adminOnlyAnnouncementSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: 'adminOnlyAnnouncement' },
  message: { type: String, default: '' },
  active: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now },
});
const AdminOnlyAnnouncement = mongoose.model('AdminOnlyAnnouncement', adminOnlyAnnouncementSchema);

// 약한 비밀번호 필터 함수
function isWeakPassword(password) {
  const p = password.toLowerCase();
  const len = p.length;
  const simplePatterns = [
    /^(.)\1{3,}$/, // 동일문자 4회 이상 반복
    /^abcd(e?f?g?h?i?j?k?l?m?n?o?p?q?r?s?t?u?v?w?x?y?z?)?$/, // 알파벳 순차
    /^qwer(t?y?u?i?o?p?)?$/, // qwerty 순차
    /^asdf(g?h?j?k?l?)?$/, // asdf 순차
    /^zxcv(b?n?m?)?$/, // zxcv 순차
  ];
  if (simplePatterns.some(pattern => pattern.test(p))) return true;

  if (len >= 4) {
    for (let i = 0; i <= len - 4; i++) {
      const sub = p.substring(i, i + 4);
      if (/^\d{4}$/.test(sub)) {
        const digits = sub.split('').map(d => parseInt(d));
        if ((digits[1] === digits[0] + 1 && digits[2] === digits[1] + 1 && digits[3] === digits[2] + 1) ||
            (digits[1] === digits[0] - 1 && digits[2] === digits[1] - 1 && digits[3] === digits[2] - 1))
          return true;
      }
      if (/^[a-z]{4}$/.test(sub)) {
        const codes = sub.split('').map(c => c.charCodeAt(0));
        if ((codes[1] === codes[0] + 1 && codes[2] === codes[1] + 1 && codes[3] === codes[2] + 1) ||
            (codes[1] === codes[0] - 1 && codes[2] === codes[1] - 1 && codes[3] === codes[2] - 1))
          return true;
      }
    }
  }
  return false;
}

// 관리자 로그인: 이름과 비밀번호 모두 필요
app.post('/api/admin-login', (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip;
  if (!username || !password) {
    console.log(`[관리자 로그인 실패] 필수 정보 누락 IP:${ip} 시간:${new Date().toISOString()}`);
    return res.status(400).json({ success: false, message: '이름과 비밀번호를 모두 입력하세요.' });
  }
  if (!ADMIN_PASSWORD) {
    console.error(`[관리자 로그인 실패] 관리자 비밀번호 미설정 IP:${ip} 시간:${new Date().toISOString()}`);
    return res.status(500).json({ success: false, message: '서버 관리자 비밀번호 미설정' });
  }
  if (!ADMIN_USERNAMES.includes(username)) {
    console.log(`[관리자 로그인 실패] 허용되지 않은 이름(${username}) IP:${ip} 시간:${new Date().toISOString()}`);
    return res.status(401).json({ success: false, message: '허용되지 않은 관리자 이름입니다.' });
  }
  if (password !== ADMIN_PASSWORD) {
    console.log(`[관리자 로그인 실패] 비밀번호 오류(${username}) IP:${ip} 시간:${new Date().toISOString()}`);
    return res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
  }
  console.log(`[관리자 로그인 성공] ID:${username} IP:${ip} 시간:${new Date().toISOString()}`);
  res.json({ success: true, message: '관리자 로그인 성공' });
});

// 예약 전체 조회
app.get('/api/reservations', async (req, res) => {
  try {
    const reservations = await Reservation.find({});
    res.json(reservations);
  } catch (e) {
    console.error('예약 조회 실패:', e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 예약 생성/변경
app.post('/api/reservations', limiter, async (req, res) => {
  if (req.body.honeypot_field) return res.status(400).json({ message: '비정상적 요청' });
  const { roomNo, name, dormitory, floor, seat, password } = req.body;
  if (!roomNo || !name || !dormitory || !floor || seat == null || !password)
    return res.status(400).json({ message: '모든 정보를 입력하세요.' });
  if (isWeakPassword(password))
    return res.status(400).json({ message: '매우 단순한 비밀번호는 사용할 수 없습니다. 다른 비밀번호를 사용해주세요.' });

  const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
  if (!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime)
    return res.status(403).json({ message: '예약 가능 시간이 설정되지 않았습니다.' });
  const now = new Date();
  if (now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime)
    return res.status(403).json({ message: '현재 예약 가능 시간이 아닙니다.' });

  try {
    const conflictSeat = await Reservation.findOne({ dormitory, floor, seat });
    const existingUser = await Reservation.findOne({ roomNo, name });
    if (conflictSeat && (!existingUser || existingUser._id.toString() !== conflictSeat._id.toString()))
      return res.status(409).json({ message: '선택한 좌석은 이미 예약되었습니다.' });

    let reservation;
    if (existingUser) {
      const isPasswordCorrect = await bcrypt.compare(password, existingUser.password);
      if (!isPasswordCorrect)
        return res.status(401).json({ success: false, message: '예약 비밀번호가 일치하지 않습니다.' });
      reservation = await Reservation.findByIdAndUpdate(existingUser._id, { dormitory, floor, seat }, { new: true });
      console.log(`[예약 변경 성공] ${reservation.name} (${reservation.roomNo}) 좌석 변경됨.`);
    } else {
      reservation = new Reservation({ roomNo, name, dormitory, floor, seat, password, plainPassword: password });
      await reservation.save();
      console.log(`[예약 생성 성공] ${reservation.name} (${reservation.roomNo}) 예약됨.`);
    }

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({ success: true, message: '예약 성공', newReservation: reservation });
  } catch (e) {
    console.error('예약 처리 중 오류:', e);
    if (e.code === 11000)
      return res.status(409).json({ message: '중복된 예약 정보가 있습니다.' });
    res.status(500).json({ message: '서버 오류' });
  }
});

// 모든 예약 취소 (비밀번호 없이 관리자 이름만 검사)
app.delete('/api/reservations/all', async (req, res) => {
  const { adminUsername } = req.body;
  const ip = req.ip;
  if (!adminUsername)
    return res.status(400).json({ message: '관리자 이름이 필요합니다.' });
  if (!ADMIN_USERNAMES.includes(adminUsername))
    return res.status(403).json({ message: '허용되지 않은 관리자입니다.' });
  try {
    await Reservation.deleteMany({});
    console.log(`관리자(${adminUsername})가 모든 예약을 취소했습니다. IP:${ip} 시간:${new Date().toISOString()}`);
    io.emit('reservationsUpdated', []);
    res.json({ success: true, message: '모든 예약이 취소되었습니다.' });
  } catch (e) {
    console.error(`관리자(${adminUsername}) 전체 예약 취소 실패:`, e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 서버 시작
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});