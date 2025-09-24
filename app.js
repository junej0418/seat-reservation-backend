// app.js: Node.js + Express + MongoDB + Socket.IO 서버 전체 코드

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
  null, // Local file access for development
  'https://heartfelt-cannoli-903df2.netlify.app',
];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (!allowedOrigins.includes(origin)) {
        return callback(new Error('CORS 차단된 도메인'), false);
      }
      callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
});

// 서버 포트 설정 및 환경변수
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_USERNAMES = process.env.ADMIN_USERNAMES ? process.env.ADMIN_USERNAMES.split(',') : [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.includes(origin)) {
      return callback(new Error('CORS 차단된 도메인'), false);
    }
    callback(null, true);
  },
  credentials: true,
}));

// JSON 요청 본문 파싱 미들웨어
app.use(express.json());

// 프록시 환경 대응 (Render, Heroku 등)
app.set('trust proxy', 1);

// 요청 속도 제한 - 1분 최대 20회, 단 /api/reservations/all 제외
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: '너무 많은 요청입니다. 잠시 후 다시 시도해 주세요.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/api/reservations/all', 
});

// MongoDB 연결
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  serverSelectionTimeoutMS: 15000,
})
.then(() => console.log('MongoDB 연결 성공'))
.catch((err) => console.error('MongoDB 연결 실패:', err));

// 예약 스키마 및 모델
const reservationSchema = new mongoose.Schema({
  roomNo: { type: String, required: true },
  name: { type: String, required: true },
  dormitory: { type: String, required: true },
  floor: { type: String, required: true },
  seat: { type: Number, required: true },
  password: { type: String, required: true }, // 해싱 저장
  plainPassword: { type: String, required: true }, // 관리자 확인용 평문 비밀번호
  createdAt: { type: Date, default: Date.now },
});

// 인덱스 설정 - 룸번호+이름, 시설+층+좌석 중복 방지용
reservationSchema.index({ roomNo: 1, name: 1 }, { unique: true });
reservationSchema.index({ dormitory: 1, floor: 1, seat: 1 }, { unique: true });

// 비밀번호 저장 전 해싱
reservationSchema.pre('save', async function(next) {
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

// 일반 공지사항 스키마 및 모델
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

// 약한 비밀번호 체크 함수
function isWeakPassword(password) {
  const p = password.toLowerCase();
  const len = p.length;
  const simplePatterns = [
    /^(.)\1{3,}$/,
    /^abcd(e?f?g?h?i?j?k?l?m?n?o?p?q?r?s?t?u?v?w?x?y?z?)?$/,
    /^qwer(t?y?u?i?o?p?)?$/,
    /^asdf(g?h?j?k?l?)?$/,
    /^zxcv(b?n?m?)?$/
  ];
  if(simplePatterns.some(pat => pat.test(p))) return true;
  if(len >= 4){
    for(let i=0; i<=len-4; i++){
      const sub = p.substr(i,4);
      if(/^\d{4}$/.test(sub)){
        const d=sub.split('').map(x => parseInt(x));
        if ((d[1]===d[0]+1 && d[2]===d[1]+1 && d[3]===d[2]+1) ||
            (d[1]===d[0]-1 && d[2]===d[1]-1 && d[3]===d[2]-1)) return true;
      }
      if(/^[a-z]{4}$/.test(sub)){
        const c=sub.split('').map(x=>x.charCodeAt(0));
        if((c[1]===c[0]+1 && c[2]===c[1]+1 && c[3]===c[2]+1) ||
           (c[1]===c[0]-1 && c[2]===c[1]-1 && c[3]===c[2]-1)) return true;
      }
    }
  }
  return false;
}

// 관리자 로그인 (이름+비밀번호 검증)
app.post('/api/admin-login', (req, res) => {
  const { password, username } = req.body;
  const ip = req.ip;
  if (!username || !password) {
    console.log(`[관리자 로그인 실패] 필수 입력 누락 IP:${ip} 시간:${new Date().toISOString()}`);
    return res.status(400).json({ success:false, message:'이름과 비밀번호를 모두 입력하세요.' });
  }
  if (!ADMIN_PASSWORD) {
    console.error(`[관리자 로그인 실패] 미설정된 관리자 비밀번호 IP:${ip} 시간:${new Date().toISOString()}`);
    return res.status(500).json({ success:false, message:'서버 관리자 비밀번호 미설정' });
  }
  if (!ADMIN_USERNAMES.includes(username)) {
    console.log(`[관리자 로그인 실패] 허용되지 않은 이름(${username}) IP:${ip} 시간:${new Date().toISOString()}`);
    return res.status(401).json({ success:false, message:'허용되지 않은 관리자 이름입니다.' });
  }
  if (password === ADMIN_PASSWORD) {
    console.log(`[관리자 로그인 성공] 이름:${username} IP:${ip} 시간:${new Date().toISOString()}`);
    return res.json({ success:true, message:'관리자 로그인 성공' });
  }
  console.log(`[관리자 로그인 실패] 비밀번호 오류(${username}) IP:${ip} 시간:${new Date().toISOString()}`);
  return res.status(401).json({ success:false, message:'비밀번호가 틀렸습니다.' });
});

// 예약 조회
app.get('/api/reservations', async (req, res) => {
  try {
    const reservations = await Reservation.find({});
    res.json(reservations);
  } catch(e) {
    console.error('예약 조회 실패:', e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 예약 생성 또는 수정(변경)
app.post('/api/reservations', limiter, async (req, res) => {
  if (req.body.honeypot_field) return res.status(400).json({message: '비정상적 요청'});
  
  const { roomNo, name, dormitory, floor, seat, password } = req.body;
  if(!roomNo || !name || !dormitory || !floor || seat == null || !password) 
    return res.status(400).json({message: '모든 정보를 입력하세요.'});
  
  if(isWeakPassword(password)) 
    return res.status(400).json({message:'매우 단순한 비밀번호는 사용할 수 없습니다. 다른 비밀번호를 사용해주세요.'});
  
  const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
  if(!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime)
    return res.status(403).json({message: '예약 가능 시간이 설정되지 않았습니다.'});
  
  const now = new Date();
  if(now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime)
    return res.status(403).json({message: '현재 예약 가능 시간이 아닙니다.'});
  
  try {
    const conflictSeat = await Reservation.findOne({ dormitory, floor, seat });
    const existingUser = await Reservation.findOne({ roomNo, name });
    if(conflictSeat && (!existingUser || existingUser._id.toString() !== conflictSeat._id.toString()))
      return res.status(409).json({ message: '선택한 좌석은 이미 예약되었습니다.' });
    
    let reservation;
    if(existingUser){
      const isPasswordCorrect = await bcrypt.compare(password, existingUser.password);
      if(!isPasswordCorrect)
        return res.status(401).json({ success:false, message:'예약 비밀번호가 일치하지 않습니다.' });
      
      reservation = await Reservation.findByIdAndUpdate(existingUser._id, { dormitory, floor, seat }, { new: true });
      console.log(`[예약 변경 성공] ${reservation.name} (${reservation.roomNo}) 좌석 변경됨. (신규 좌석: ${dormitory} ${floor}층 ${seat}번)`);
    } else { 
      reservation = new Reservation({ roomNo, name, dormitory, floor, seat, password, plainPassword: password });
      await reservation.save();
      console.log(`[예약 생성 성공] ${reservation.name} (${reservation.roomNo}) 예약됨. (좌석: ${dormitory} ${floor}층 ${seat}번)`);
    }
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({ success:true, message:'예약 성공', newReservation: reservation });
  } catch(e){
    console.error('예약 처리 중 오류:', e);
    if(e.code === 11000)
      return res.status(409).json({message:'중복된 예약 정보가 있습니다.'});
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 수정 API (PUT)
app.put('/api/reservations/update/:id', limiter, async (req, res) => {
  if (req.body.honeypot_field) return res.status(400).json({ message: '비정상적 요청' });

  const { id } = req.params;
  const { roomNo, name, dormitory, floor, seat, password } = req.body;
  if (!roomNo || !name || !dormitory || !floor || seat == null || !password)
    return res.status(400).json({ message: '모든 정보를 입력하세요.' });
  
  // 약한 비밀번호 검증
  if (isWeakPassword(password)) {
    return res.status(400).json({ message: '매우 단순한 비밀번호는 사용할 수 없습니다. 다른 비밀번호를 사용해주세요.' });
  }

  const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
  if (!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime)
    return res.status(403).json({ message: '예약 가능 시간이 설정되지 않았습니다.' });

  const now = new Date();
  if (now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime)
    return res.status(403).json({ message: '현재 예약 가능 시간이 아닙니다.' });

  try {
    const existingReservation = await Reservation.findById(id);
    if (!existingReservation)
      return res.status(404).json({ message: '예약을 찾을 수 없습니다.' });

    const isPasswordCorrect = await bcrypt.compare(password, existingReservation.password);
    if (!isPasswordCorrect)
      return res.status(401).json({ success: false, message: '예약 비밀번호가 일치하지 않습니다.' });

    const conflictSeat = await Reservation.findOne({ dormitory, floor, seat, _id: { $ne: id } });
    if (conflictSeat)
      return res.status(409).json({ message: '선택하신 좌석은 이미 다른 사람에게 예약되었습니다.' });

    const updatedReservation = await Reservation.findByIdAndUpdate(
      id,
      { roomNo, name, dormitory, floor, seat },
      { new: true, runValidators: true }
    );
    console.log(`[예약 변경 성공] ${updatedReservation.name} (${updatedReservation.roomNo}) 좌석 변경됨. (기존: ${existingReservation.dormitory} ${existingReservation.floor}층 ${existingReservation.seat}번 -> 신규: ${dormitory} ${floor}층 ${seat}번)`);

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({ success: true, message: '예약이 성공적으로 변경되었습니다.', updatedReservation });
  } catch (e) {
    console.error('예약 변경 처리 중 오류:', e);
    if (e.code === 11000)
      return res.status(409).json({ message: '중복된 예약 정보가 있습니다.' });
    res.status(500).json({ message: '서버 오류' });
  }
});

// 개별 예약 삭제 API (관리자 이름 로그 추가)
app.delete('/api/reservations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { password, adminUsername } = req.body; // 관리자 이름도 받음 (옵션)
    if (!password)
      return res.status(400).json({ message: '비밀번호를 입력해주세요.' });

    const existingReservation = await Reservation.findById(id);
    if (!existingReservation)
      return res.status(404).json({ message: '예약을 찾을 수 없습니다.' });

    const isPasswordCorrect = await bcrypt.compare(password, existingReservation.password);
    if (!isPasswordCorrect)
      return res.status(401).json({ success: false, message: '예약 비밀번호가 일치하지 않습니다.' });

    await Reservation.findByIdAndDelete(id);
    const loggedAdminUser = adminUsername ? `관리자(${adminUsername}) ` : '';
    console.log(`${loggedAdminUser}[예약 취소 성공] ${existingReservation.name} (${existingReservation.roomNo}, ${existingReservation.dormitory} ${existingReservation.floor}층 ${existingReservation.seat}번) 예약 취소.`);

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({ success: true, message: '예약 취소 완료' });
  } catch (e) {
    console.error('예약 취소 중 오류:', e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 모든 예약 삭제 API (관리자 이름만 검증하며 비밀번호 추가 확인 없음)
app.delete('/api/reservations/all', async (req, res) => {
  const { adminUsername } = req.body; // 관리자 이름만 받음
  const clientIp = req.ip;

  // 관리자 이름이 없거나 허용되지 않은 관리자 이름일 경우 거부 (최소한의 인증)
  if (!adminUsername || !ADMIN_USERNAMES.includes(adminUsername)) {
    console.log(`모든 예약 취소 실패 (관리자 인증 실패: ${adminUsername || '미지정'}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(403).json({ message: '모든 예약 취소 권한이 없습니다. 관리자로 로그인했는지 확인해주세요.' });
  }

  try {
    await Reservation.deleteMany({});
    console.warn(`[모든 예약 삭제 완료] 관리자(${adminUsername})에 의해 모든 예약이 삭제되었습니다. IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    io.emit('reservationsUpdated', []); // 프론트엔드에 업데이트된 빈 배열 전송
    res.json({ success: true, message: `관리자(${adminUsername})에 의해 모든 예약이 삭제되었습니다.` });
  } catch (e) {
    console.error(`관리자(${adminUsername})의 모든 예약 삭제 실패:`, e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 관리자 설정 조회 API (예약 가능 시간)
app.get('/api/admin-settings', async (req, res) => {
  try {
    let settings = await AdminSetting.findOne({ key: 'reservationTimes' });
    if (!settings) { // 설정이 없으면 기본값으로 생성
      settings = new AdminSetting({ key: 'reservationTimes' });
      await settings.save();
    }
    res.json(settings);
  } catch (e) {
    console.error('관리자 설정 조회 실패:', e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 관리자 설정 저장 API (예약 가능 시간, 관리자 이름/비밀번호 검증)
app.put('/api/admin-settings', async (req, res) => {
  const { reservationStartTime, reservationEndTime, adminUsername, adminPassword } = req.body;
  const clientIp = req.ip;

  // 관리자 인증 (비밀번호, 이름 모두 검증)
  if (!adminUsername || !adminPassword) {
    console.log(`관리자 설정 저장 실패 (필수 정보 누락) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(400).json({ message: '관리자 이름과 비밀번호를 입력해주세요.' });
  }
  if (!ADMIN_USERNAMES.includes(adminUsername)) {
    console.log(`관리자 설정 저장 실패 (허용되지 않은 관리자 이름: ${adminUsername}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(403).json({ message: '설정 변경 권한이 없습니다. 허용되지 않은 관리자 이름입니다.' });
  }
  if (adminPassword !== ADMIN_PASSWORD) {
    console.log(`관리자 설정 저장 실패 (비밀번호 불일치: ${adminUsername}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(401).json({ message: '관리자 비밀번호가 틀렸습니다.' });
  }
  
  try {
    const settings = await AdminSetting.findOneAndUpdate(
      { key: 'reservationTimes' },
      { reservationStartTime, reservationEndTime },
      { new: true, upsert: true } // 없으면 새로 생성
    );
    console.log(`관리자(${adminUsername})[관리자 설정 저장 성공] 예약 시간 설정됨: ${reservationStartTime} ~ ${reservationEndTime} - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    io.emit('settingsUpdated', settings); // 모든 클라이언트에 설정 업데이트 알림
    res.json({ success: true, message: '예약 가능 시간이 설정되었습니다.', settings });
  } catch (e) {
    console.error(`관리자(${adminUsername}) 관리자 설정 저장 실패:`, e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 일반 사용자용 공지사항 조회 API
app.get('/api/announcement', async (req, res) => {
  try {
    let announcement = await Announcement.findOne({ key: 'currentAnnouncement' });
    if (!announcement) { // 공지사항이 없으면 기본값으로 생성
      announcement = new Announcement({ key: 'currentAnnouncement' });
      await announcement.save();
    }
    res.json(announcement);
  } catch (e) {
    console.error('공지사항 조회 실패:', e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 일반 사용자용 공지사항 저장 API (관리자 이름/비밀번호 검증)
app.put('/api/announcement', async (req, res) => {
  const { message, active, adminUsername, adminPassword } = req.body;
  const clientIp = req.ip;

  // 관리자 인증 (비밀번호, 이름 모두 검증)
  if (!adminUsername || !adminPassword) {
    console.log(`일반 공지사항 저장 실패 (필수 정보 누락) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(400).json({ message: '관리자 이름과 비밀번호를 입력해주세요.' });
  }
  if (!ADMIN_USERNAMES.includes(adminUsername)) {
    console.log(`일반 공지사항 저장 실패 (허용되지 않은 관리자 이름: ${adminUsername}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(403).json({ message: '공지사항 변경 권한이 없습니다. 허용되지 않은 관리자 이름입니다.' });
  }
  if (adminPassword !== ADMIN_PASSWORD) {
    console.log(`일반 공지사항 저장 실패 (비밀번호 불일치: ${adminUsername}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(401).json({ message: '관리자 비밀번호가 틀렸습니다.' });
  }

  try {
    const announcement = await Announcement.findOneAndUpdate(
      { key: 'currentAnnouncement' },
      { message, active, updatedAt: new Date() },
      { new: true, upsert: true } // 없으면 새로 생성
    );
    console.log(`관리자(${adminUsername})[일반 공지사항 업데이트 성공] 활성=${active}, 내용=${message ? message.substring(0, Math.min(message.length, 30)) : ''}... - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    io.emit('announcementUpdated', announcement); // 모든 클라이언트에 공지사항 업데이트 알림
    res.json({ success: true, message: '공지사항이 저장되었습니다.' });
  } catch (e) {
    console.error(`관리자(${adminUsername}) 일반 공지사항 저장 실패:`, e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 관리자 전용 공지사항 조회 API
app.get('/api/admin-announcement', async (req, res) => {
  try {
    let announcement = await AdminOnlyAnnouncement.findOne({ key: 'adminOnlyAnnouncement' });
    if (!announcement) { // 공지사항이 없으면 기본값으로 생성
      announcement = new AdminOnlyAnnouncement({ key: 'adminOnlyAnnouncement' });
      await announcement.save();
    }
    res.json(announcement);
  } catch (e) {
    console.error('관리자 전용 공지사항 조회 실패:', e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 관리자 전용 공지사항 저장 API (관리자 이름/비밀번호 검증)
app.put('/api/admin-announcement', async (req, res) => {
  const { message, active, adminUsername, adminPassword } = req.body;
  const clientIp = req.ip;

  // 관리자 인증 (비밀번호, 이름 모두 검증)
  if (!adminUsername || !adminPassword) {
    console.log(`관리자 전용 공지사항 저장 실패 (필수 정보 누락) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(400).json({ message: '관리자 이름과 비밀번호를 입력해주세요.' });
  }
  if (!ADMIN_USERNAMES.includes(adminUsername)) {
    console.log(`관리자 전용 공지사항 저장 실패 (허용되지 않은 관리자 이름: ${adminUsername}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(403).json({ message: '관리자 전용 공지사항 변경 권한이 없습니다. 허용되지 않은 관리자 이름입니다.' });
  }
  if (adminPassword !== ADMIN_PASSWORD) {
    console.log(`관리자 전용 공지사항 저장 실패 (비밀번호 불일치: ${adminUsername}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(401).json({ message: '관리자 비밀번호가 틀렸습니다.' });
  }
  
  try {
    const announcement = await AdminOnlyAnnouncement.findOneAndUpdate(
      { key: 'adminOnlyAnnouncement' },
      { message, active, updatedAt: new Date() },
      { new: true, upsert: true } // 없으면 새로 생성
    );
    console.log(`관리자(${adminUsername})[관리자 전용 공지사항 업데이트 성공] 활성=${active}, 내용=${message ? message.substring(0, Math.min(message.length, 30)) : ''}... - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    io.emit('adminAnnouncementUpdated', announcement); // 모든 클라이언트에 업데이트 알림
    res.json({ success: true, message: '관리자 전용 공지사항이 저장되었습니다.' });
  } catch (e) {
    console.error(`관리자(${adminUsername}) 관리자 전용 공지사항 저장 실패:`, e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 관리자용 예약 비밀번호 열람 API (관리자 이름/비밀번호 검증)
app.post('/api/admin/reservations/:id/view-plain-password', async (req, res) => {
  const { id } = req.params;
  const { adminPassword, adminUsername } = req.body;
  const clientIp = req.ip;

  // 관리자 인증 (비밀번호, 이름 모두 검증)
  if (!adminPassword || !adminUsername) {
    console.log(`비밀번호 열람 실패 (필수 정보 누락) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(400).json({ success: false, message: '관리자 이름과 비밀번호를 입력해주세요.' });
  }
  if (adminPassword !== ADMIN_PASSWORD) {
    console.log(`비밀번호 열람 실패 (관리자 비번 오류: ${adminUsername}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(401).json({ success: false, message: '관리자 비밀번호가 틀렸습니다.' });
  }
  if (!ADMIN_USERNAMES.includes(adminUsername)) {
    console.log(`예약 비밀번호 열람 실패 (허용되지 않은 관리자 이름: ${adminUsername}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    return res.status(403).json({ message: '비밀번호 열람 권한이 없습니다. 허용되지 않은 관리자 이름입니다.' });
  }

  try {
    const reservation = await Reservation.findById(id).select('plainPassword name roomNo dormitory floor seat');
    if (!reservation) {
      console.log(`비밀번호 열람 실패 (예약 찾을 수 없음: ${id}) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
      return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });
    }
    console.log(`관리자(${adminUsername})[예약 비밀번호 열람 성공] 예약자: ${reservation.name} (${reservation.roomNo}, ${reservation.dormitory} ${reservation.floor}층 ${reservation.seat}번) - IP: ${clientIp} - 시간: ${new Date().toISOString()}`);
    res.json({ success: true, plainPassword: reservation.plainPassword });
  } catch (e) {
    console.error(`비밀번호 열람 실패 (관리자: ${adminUsername}):`, e);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});


// --- Socket.IO 이벤트 처리 ---

io.on('connection', async (socket) => {
  console.log(`클라이언트 연결: ${socket.id}`);
  try {
    // 초기 데이터 전송
    const allReservations = await Reservation.find({});
    socket.emit('reservationsInitial', allReservations); // 모든 예약 정보
    
    const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
    socket.emit('adminSettingsInitial', adminSettings); // 관리자 설정 (예약 시간)
    
    const announcement = await Announcement.findOne({ key: 'currentAnnouncement' });
    socket.emit('announcementInitial', announcement); // 일반 공지사항
    
    const adminAnnouncement = await AdminOnlyAnnouncement.findOne({ key: 'adminOnlyAnnouncement' });
    socket.emit('adminOnlyAnnouncementInitial', adminAnnouncement); // 관리자 전용 공지사항

  } catch (e) {
    console.error('초기 데이터 전송 실패:', e);
  }

  socket.on('disconnect', () => {
    console.log(`클라이언트 연결 종료: ${socket.id}`);
  });
});

// --- 서버 시작 ---

server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});