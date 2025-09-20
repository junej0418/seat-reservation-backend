// 필요한 모듈 import 및 서버 환경 설정
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  null,
  'https://heartfelt-cannoli-903df2.netlify.app',
];

// Socket.IO CORS 설정
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (!allowedOrigins.includes(origin)) return callback(new Error("CORS 차단된 도메인"), false);
      return callback(null, true);
    },
    methods: ['GET','POST','PUT','DELETE'],
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// 미들웨어 설정
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null,true);
    if (!allowedOrigins.includes(origin)) return callback(new Error("CORS 차단된 도메인"), false);
    callback(null,true);
  },
  credentials: true
}));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60000,
  max: 20,
  message: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.path.startsWith('/api/admin-settings') || req.path.startsWith('/api/announcement')
});
app.use(limiter);

// MongoDB 연결
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB 연결 성공'))
  .catch(err => console.error('MongoDB 연결 실패:', err));

// 예약 스키마 및 모델 정의
const reservationSchema = new mongoose.Schema({
  roomNo: {type:String, required:true},
  name: {type:String, required:true},
  dormitory: {type:String, required:true},
  floor: {type:String, required:true},
  seat: {type:Number, required:true},
  createdAt: {type:Date, default:Date.now},
  deviceIdentifier: {type:String}
});
reservationSchema.index({roomNo:1,name:1}, {unique:true});
reservationSchema.index({dormitory:1,floor:1,seat:1}, {unique:true});
const Reservation = mongoose.model('Reservation', reservationSchema);

// 관리자 설정 스키마 및 모델 정의
const adminSettingSchema = new mongoose.Schema({
  key: {type:String, unique:true, required:true},
  reservationStartTime: {type:Date, default:null},
  reservationEndTime: {type:Date, default:null}
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

// 공지사항 스키마 및 모델
const announcementSchema = new mongoose.Schema({
  key: {type:String, unique:true, default:'currentAnnouncement'},
  message: {type:String, default:''},
  active: {type:Boolean, default:false},
  updatedAt: {type:Date, default:Date.now}
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// 관리자 인증 미들웨어
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success:false, message:'인증 헤더가 필요합니다.' });
  }
  const password = authHeader.split(' ')[1];
  if (!ADMIN_PASSWORD) return res.status(500).json({ success:false, message:'서버 관리자 비밀번호 미설정' });
  if (password !== ADMIN_PASSWORD) return res.status(403).json({ success:false, message:'관리자 권한이 없습니다.' });
  next();
};

// 관리자 예약 시간 조회
app.get('/api/admin-settings', authenticateAdmin, async (req, res) => {
  try {
    let settings = await AdminSetting.findOne({key:'reservationTimes'});
    if (!settings) {
      settings = new AdminSetting({ key:'reservationTimes' });
      await settings.save();
    }
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message:'서버 오류' });
  }
});

// 관리자 예약 시간 저장
app.put('/api/admin-settings', authenticateAdmin, async (req, res) => {
  try {
    const { reservationStartTime, reservationEndTime } = req.body;
    const settings = await AdminSetting.findOneAndUpdate(
      {key:'reservationTimes'},
      { reservationStartTime, reservationEndTime },
      { new:true, upsert:true }
    );
    io.emit('settingsUpdated', settings);
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message:'서버 오류' });
  }
});

// ... (예약 생성, 변경, 취소, 공지사항 관련 API 등은 기존과 동일하게 구현) ...

// Socket.IO 연결
io.on('connection', socket => {
  console.log(`클라이언트 접속: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`클라이언트 연결 종료: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`서버 시작: http://localhost:${PORT}`);
});