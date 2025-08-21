// app.js

// 1. 필요한 도구(라이브러리)들을 불러옵니다.
const express = require('express'); 
const mongoose = require('mongoose'); 
const cors = require('cors'); 
const http = require('http'); 
const { Server } = require('socket.io'); 
require('dotenv').config(); 

// --- 새로운 기능: 요청 속도 제한 (Rate Limiting)을 위한 패키지 ---
const rateLimit = require('express-rate-limit'); 

// 2. Express 애플리케이션 생성 및 HTTP 서버 연결
const app = express();
const server = http.createServer(app);

// --- 3. CORS (Cross-Origin Resource Sharing) 허용 출처 설정 ---
const allowedOrigins = [
  process.env.FRONTEND_URL, // .env 파일에서 불러온 프론트엔드 주소 (로컬 개발용)
  'http://localhost:5500',   // VS Code Live Server의 일반적인 localhost 주소
  'http://127.0.0.1:5500',   // VS Code Live Server의 일반적인 127.0.0.1 주소
  'http://localhost:3000',   // 백엔드 자체도 origin으로 요청할 수 있음
  'http://127.0.0.1:3000',   // 백엔드 자체도 origin으로 요청할 수 있음
  null,                      // HTML 파일을 로컬 시스템(file://)에서 직접 열 때

  // ⭐ 여러분의 Netlify 프론트엔드 주소를 여기에 정확히 넣어주세요! ⭐
  'https://heartfelt-cannoli-903df2.netlify.app', 
  // 필요시 추가적인 로컬 IP나 커스텀 도메인
];

// 4. Socket.IO 서버 인스턴스 생성 및 CORS 설정
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) { 
      if (!origin) return callback(null, true); 
      if (!allowedOrigins.includes(origin)) { 
        const msg = `CORS 허용되지 않은 출처입니다: ${origin}`;
        return callback(new Error(msg), false);
      }
      return callback(null, true); 
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'], 
    credentials: true 
  }
});

// 5. 서버 포트와 MongoDB 연결 URI를 .env 파일에서 로드
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
// *** 보안 강화: 관리자 비밀번호를 환경 변수에서 불러옵니다. ***
const ADMIN_PASSWORD_SERVER = process.env.ADMIN_PASSWORD; 

// 6. 미들웨어 설정
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); 
    if (!allowedOrigins.includes(origin)) {
      const msg = `CORS 허용되지 않은 출처입니다: ${origin}`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true 
}));
app.use(express.json());

// --- 새로운 기능: 요청 속도 제한 (Rate Limiting) 설정 ---
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1분 (분:분:초)
  max: 20, // 1분당 최대 요청 20개 (동일 IP 기준)
  message: "잠시 후 다시 시도해주세요. 너무 많은 요청이 감지되었습니다.",
  standardHeaders: true, // `RateLimit-*` 헤더 추가
  legacyHeaders: false, // `X-RateLimit-*` 헤더 비활성화
  skip: (req, res) => req.path === '/api/reservations/all', // 모든 예약 삭제 요청에는 적용 안 함 (관리자 기능)
});

// 7. MongoDB 데이터베이스 연결
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB에 성공적으로 연결되었습니다.')) 
  .catch(err => console.error('❌ MongoDB 연결 오류:', err)); 

// --- MongoDB 스키마 및 모델 정의 ---
const reservationSchema = new mongoose.Schema({
  roomNo: { type: String, required: true },
  name: { type: String, required: true },
  dormitory: { type: String, required: true },
  floor: { type: String, required: true },
  seat: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now } 
});
reservationSchema.index({ roomNo: 1, name: 1 }, { unique: true });
reservationSchema.index({ dormitory: 1, floor: 1, seat: 1 }, { unique: true });
const Reservation = mongoose.model('Reservation', reservationSchema); 

const adminSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, 
  reservationStartTime: { type: Date, default: null }, 
  reservationEndTime: { type: Date, default: null }    
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema); 

// --- API 엔드포인트 정의 ---

// *** 보안 강화: 관리자 로그인 API ***
app.post('/api/admin-login', (req, res) => {
  const { password } = req.body;
  if (!password) { // 비밀번호 필드 자체를 안 보냈을 경우
    return res.status(400).json({ success: false, message: '비밀번호를 입력해주세요.' });
  }
  if (!ADMIN_PASSWORD_SERVER) { // 환경 변수가 서버에 설정 안 되어 있을 때
    console.error('❌ ADMIN_PASSWORD 환경 변수가 설정되지 않았습니다. Render Environment 변수를 확인하세요.');
    return res.status(500).json({ success: false, message: '서버 관리자 비밀번호가 설정되지 않았습니다.' });
  }
  if (password === ADMIN_PASSWORD_SERVER) {
    res.status(200).json({ success: true, message: '관리자 로그인 성공' });
  } else {
    res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
  }
});


// 9-1. 모든 예약 정보 조회 API (GET 요청)
app.get('/api/reservations', async (req, res) => {
  try {
    const reservations = await Reservation.find({});
    res.status(200).json(reservations);
  } catch (error) {
    console.error('API 에러: 예약 조회 실패:', error);
    res.status(500).json({ message: '예약 정보를 불러오는 데 실패했습니다.', error: error.message });
  }
});

// 9-2. 새로운 예약 생성 API (POST 요청) - Rate Limiting & 허니팟 검증 적용
app.post('/api/reservations', limiter, async (req, res) => { // limiter 미들웨어 적용
  // --- 새로운 기능: 허니팟(Honeypot) 필드 검증 ---
  if (req.body.honeypot_field) { // 프론트엔드의 숨겨진 필드에 값이 채워져 있으면 봇으로 간주
      console.warn('🍯 Honeypot field filled. Likely a bot:', req.ip);
      return res.status(400).json({ message: '비정상적인 요청이 감지되었습니다. (Honeypot)' });
  }
  
  const { roomNo, name, dormitory, floor, seat } = req.body;
  
  // --- 새로운 기능: 백엔드 입력 유효성 검증 ---
  if (!roomNo || !name || !dormitory || !floor || seat === undefined || seat === null) {
      return res.status(400).json({ message: '모든 예약 정보를 정확히 입력해주세요.' });
  }
  if (!/^\d{3}호$/.test(roomNo)) {
      return res.status(400).json({ message: '룸 번호 형식이 올바르지 않습니다. (예: 101호)' });
  }
  if (!/^[가-힣]{2,4}$/.test(name)) {
      return res.status(400).json({ message: '이름은 한글 2~4자여야 합니다.' });
  }
  const validDorms = ['꿈동', '미래동']; // 유효한 기숙사 목록
  if (!validDorms.includes(dormitory)) {
      return res.status(400).json({ message: '유효하지 않은 기숙사입니다.' });
  }
  // 유효한 층 확인은 프론트엔드에서 더 자세히 이루어지고 여기서는 타입만 확인
  if (typeof floor !== 'string' || typeof seat !== 'number') {
      return res.status(400).json({ message: '층 또는 좌석 번호가 올바르지 않습니다.' });
  }
  
  // --- 새로운 기능: 백엔드에서 예약 시간 검증 ---
  const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
  if (!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime) {
      return res.status(403).json({ message: '관리자가 예약 가능 시간을 설정하지 않았습니다.' });
  }
  const now = new Date();
  const startTime = new Date(adminSettings.reservationStartTime);
  const endTime = new Date(adminSettings.reservationEndTime);
  if (now < startTime || now > endTime) {
      return res.status(403).json({ message: `현재는 예약 가능 시간이 아닙니다. (${startTime.toLocaleString()} ~ ${endTime.toLocaleString()})` });
  }

  try {
    const existUser = await Reservation.findOne({ roomNo, name });
    if (existUser) {
      // 기존 예약이 있는 사용자가 새로운 좌석을 예약하려 할 때
      // 이 경우, 일단 새 좌석 예약을 시도하고, 성공하면 이전 좌석 삭제 (원자적 작업에 준함)
      const newReservation = new Reservation({ roomNo, name, dormitory, floor, seat });
      await newReservation.save(); // 새 예약 먼저 저장 (unique 인덱스에 의해 중복 좌석이면 여기서 에러 발생)
      await Reservation.deleteOne({ _id: existUser._id }); // 이전 예약 삭제
    } else {
      // 기존 예약이 없는 새로운 사용자
      const newReservation = new Reservation({ roomNo, name, dormitory, floor, seat });
      await newReservation.save(); // 새 예약 저장 (unique 인덱스에 의해 중복 좌석이면 여기서 에러 발생)
    }

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.status(201).json({ message: '예약 성공!', newReservation }); // 응답 메시지 개선
  } catch (error) {
    if (error.code === 11000) { // MongoDB duplicate key error (unique index 위반)
        if (error.message.includes('roomNo_1_name_1')) {
            return res.status(409).json({ message: '이미 이 룸 번호와 이름으로 예약이 존재합니다.' });
        }
        if (error.message.includes('dormitory_1_floor_1_seat_1')) {
            return res.status(409).json({ message: '선택한 좌석은 이미 예약되었습니다. 다른 좌석을 선택해주세요.' });
        }
    }
    console.error('API 에러: 예약 생성 실패:', error);
    res.status(500).json({ message: '예약 처리 중 알 수 없는 오류가 발생했습니다.', error: error.message });
  }
});

// 9-3. 모든 예약 삭제 API (DELETE 요청 - 관리자용)
app.delete('/api/reservations/all', async (req, res) => {
  try {
    await Reservation.deleteMany({}); 
    
    const allReservations = await Reservation.find({}); 
    io.emit('reservationsUpdated', allReservations); 

    res.status(200).json({ message: '모든 예약이 성공적으로 취소되었습니다.' });
  } catch (error) {
    console.error('API 에러: 모든 예약 삭제 실패:', error);
    res.status(500).json({ message: '모든 예약 삭제에 실패했습니다.', error: error.message });
  }
});

// 9-4. 예약 삭제 API (DELETE 요청 - 관리자용, 예약 고유 _id 기준)
app.delete('/api/reservations/:id', async (req, res) => {
  try {
    const { id } = req.params; 
    const deleted = await Reservation.findByIdAndDelete(id); 

    if (!deleted) { 
      return res.status(404).json({ message: '삭제할 예약을 찾을 수 없습니다.' });
    }

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.status(200).json({ message: '예약이 성공적으로 취소되었습니다.', deletedReservation: deleted });
  } catch (error) {
    console.error('API 에러: 예약 삭제 실패:', error);
    res.status(500).json({ message: '예약 삭제에 실패했습니다.', error: error.message });
  }
});

// 9-5. 사용자 기존 예약 삭제 API (DELETE 요청 - 자리 변경용, 룸번호/이름 기준) - 사실상 이 API는 이제 POST에서 처리
app.delete('/api/reservations/user/:roomNo/:name', async (req, res) => {
  try {
    const { roomNo, name } = req.params; 
    const resDel = await Reservation.deleteOne({ roomNo, name });

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.status(200).json({ message: '사용자 기존 예약 삭제 처리 완료.', deletedCount: resDel.deletedCount });
  } catch (error) {
    console.error('API 에러: 사용자 예약 삭제 실패:', error);
    res.status(500).json({ message: '사용자 예약 삭제 실패.', error: error.message });
  }
});


// 9-6. 관리자 예약 시간 설정 조회 API (GET 요청)
app.get('/api/admin-settings', async (req, res) => {
  try {
    let settings = await AdminSetting.findOne({ key: 'reservationTimes' }); 
    if (!settings) { 
      settings = new AdminSetting({ key: 'reservationTimes' });
      await settings.save();
    }
    res.status(200).json(settings);
  } catch (error) {
    console.error('API 에러: 관리자 설정 조회 실패:', error);
    res.status(500).json({ message: '관리자 설정 조회 실패.', error: error.message });
  }
});

// 9-7. 관리자 예약 시간 설정 업데이트 API (PUT 요청)
app.put('/api/admin-settings', async (req, res) => {
  const { reservationStartTime, reservationEndTime } = req.body;
  try {
    const settings = await AdminSetting.findOneAndUpdate(
      { key: 'reservationTimes' },
      { reservationStartTime, reservationEndTime },
      { new: true, upsert: true } 
    );

    io.emit('settingsUpdated', settings);

    res.status(200).json(settings);
  } catch (error) {
    console.error('API 에러: 관리자 설정 저장 실패:', error);
    res.status(500).json({ message: '관리자 설정 저장 실패.', error: error.message });
  }
});

// --- Socket.IO 연결 이벤트 핸들링 ---
io.on('connection', (socket) => {
  console.log('🔗 클라이언트 접속됨:', socket.id);
  socket.on('disconnect', () => {
    console.log('💔 클라이언트 연결 끊김:', socket.id);
  });
});

// --- 서버 시작 ---
server.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${PORT}`);
});