// app.js

// 1. 필요한 도구(라이브러리)들을 불러옵니다.
const express = require('express'); // 웹 서버를 쉽게 만드는 도구 (Express.js)
const mongoose = require('mongoose'); // MongoDB 데이터베이스와 대화하는 도구 (Mongoose ODM)
const cors = require('cors'); // 프론트엔드와 백엔드 간 통신을 허용하는 도구 (CORS 미들웨어)
const http = require('http'); // Node.js 내장 HTTP 모듈 (웹 서버 생성)
const { Server } = require('socket.io'); // 실시간 알림 (WebSocket 기반 Socket.IO 서버)
require('dotenv').config(); // .env 파일에서 환경 변수를 로드하는 도구 (dotenv)

// 2. Express 애플리케이션 생성 및 HTTP 서버 연결
const app = express();
const server = http.createServer(app);

// --- 3. CORS (Cross-Origin Resource Sharing) 허용 출처 설정 ---
// 프론트엔드가 실행될 수 있는 모든 주소를 여기에 명시해야 합니다.
// 로컬 개발 환경에서 사용될 수 있는 모든 예상 주소들을 포함합니다.
const allowedOrigins = [
  process.env.FRONTEND_URL, // .env 파일에서 불러온 프론트엔드 주소 (로컬 개발용)
  'http://localhost:5500',   // VS Code Live Server의 일반적인 localhost 주소
  'http://127.0.0.1:5500',   // VS Code Live Server의 일반적인 127.0.0.1 주소
  'http://localhost:3000',   // 백엔드 자체도 origin으로 요청할 수 있음 (선택적이지만 안전상 포함)
  'http://127.0.0.1:3000',   // 백엔드 자체도 origin으로 요청할 수 있음 (선택적이지만 안전상 포함)
  null,                      // HTML 파일을 로컬 시스템(file://)에서 직접 열 때 origin이 'null'로 인식될 수 있음

  // ⭐⭐⭐ 이 부분이 가장 중요합니다! ⭐⭐⭐
  // 여러분의 Netlify 프론트엔드 주소 (로그에 나타났던)를 여기에 정확히 넣어주세요!
  'https://heartfelt-cannoli-903df2.netlify.app', 
  // (만약 여러분의 Netlify 주소가 바뀌었다면, 바뀐 주소로 다시 바꿔야 합니다!)

  // 추가적인 로컬 IP나 커스텀 도메인이 있다면 여기에 추가합니다.
  // 예시: 'http://172.20.10.6:5501' (이전에 사용했던 IP)
  // 예시: 'https://www.your-custom-domain.com'
];

// 4. Socket.IO 서버 인스턴스 생성 및 CORS 설정 (Socket.IO 통신을 위한 CORS)
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) { // 요청 origin을 허용 목록에서 확인
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
  if (!ADMIN_PASSWORD_SERVER) { // 환경 변수가 설정 안 되어 있을 때
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

// 9-2. 새로운 예약 생성 API (POST 요청)
app.post('/api/reservations', async (req, res) => {
  const { roomNo, name, dormitory, floor, seat } = req.body;
  try {
    const existUser = await Reservation.findOne({ roomNo, name });
    if (existUser) {
      return res.status(409).json({ message: '이미 예약된 사용자입니다. 한 사람당 1자리만 예약 가능합니다.' });
    }
    const existSeat = await Reservation.findOne({ dormitory, floor, seat });
    if (existSeat) {
      return res.status(409).json({ message: '선택한 좌석은 이미 예약되었습니다. 다른 좌석을 선택해주세요.' });
    }

    const newReservation = new Reservation({ roomNo, name, dormitory, floor, seat });
    await newReservation.save(); 

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.status(201).json(newReservation); 
  } catch (error) {
    console.error('API 에러: 예약 생성 실패:', error);
    res.status(500).json({ message: '예약 생성에 실패했습니다.', error: error.message });
  }
});

// 9-3. 모든 예약 삭제 API (DELETE 요청 - 관리자용)
// 경로: /api/reservations/all   <--- 이 라우트가 ID 삭제 라우트보다 먼저 와야 합니다.
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
// 경로: /api/reservations/:id  <--- 이 라우트가 '/all' 라우트 뒤에 와야 합니다.
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

// 9-5. 사용자 기존 예약 삭제 API (DELETE 요청 - 자리 변경용, 룸번호/이름 기준)
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