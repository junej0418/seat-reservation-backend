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
  process.env.FRONTEND_URL, // .env 파일에서 불러온 프론트엔드 주소 (가장 중요)
   'http://localhost:5500',   // VS Code Live Server의 일반적인 localhost 주소
  'http://127.0.0.1:5500',   // VS Code Live Server의 일반적인 127.0.0.1 주소
  'http://localhost:3000',   // 백엔드 자체도 origin으로 요청할 수 있음
  'http://127.0.0.1:3000',   // 백엔드 자체도 origin으로 요청할 수 있음
  null,                      // HTML 파일을 로컬 시스템(file://)에서 직접 열 때 origin이 'null'로 인식될 수 있음

  // *** 여기를 수정합니다! 오류 메시지에 나온 주소를 그대로 추가하세요. ***
  'http://172.20.10.6:5501', // <-- 이 줄을 추가합니다.
  'https://heartfelt-cannoli-903df2.netlify.app/'


  // *** 중요: 만약 여러분의 PC가 특정 로컬 네트워크 IP 주소로 할당되어 있고,
  //      다른 기기(스마트폰 등)에서 그 IP를 통해 프론트엔드에 접속할 경우,
  //      그 IP 주소와 Live Server 포트 조합을 여기에 추가해야 합니다.
  //      예시: 'http://192.168.0.10:5500' (여러분 PC의 실제 IP로 변경)

  // *** 중요: Netlify로 프론트엔드를 배포할 경우, Netlify가 할당하는 도메인 주소를 여기에 추가해야 합니다.
  //      예시: 'https://your-netlify-app-name.netlify.app'
  //      만약 Netlify에서 사용자 지정 도메인(예: www.my-domain.com)을 사용한다면 그 주소도 추가해야 합니다.
  //      예시: 'https://www.your-custom-domain.com'
];

// 4. Socket.IO 서버 인스턴스 생성 및 CORS 설정 (Socket.IO 통신을 위한 CORS)
const io = new Server(server, {
  cors: {
    origin: function(origin, callback) { // 요청 origin을 허용 목록에서 확인
      if (!origin) return callback(null, true); // origin이 없는 경우 (예: Postman) 허용
      if (!allowedOrigins.includes(origin)) { // allowedOrigins 배열에 origin이 포함되어 있는지 확인
        const msg = `CORS 허용되지 않은 출처입니다: ${origin}`;
        return callback(new Error(msg), false);
      }
      return callback(null, true); // 허용된 출처이면 통과
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'], // Socket.IO 통신에 필요한 메서드
    credentials: true // 크리덴셜 (쿠키, 인증 헤더 등) 전송 허용
  }
});

// 5. 서버 포트와 MongoDB 연결 URI를 .env 파일에서 로드
const PORT = process.env.PORT || 3000; // 환경 변수에 PORT가 없으면 3000번 포트 사용
const MONGO_URI = process.env.MONGO_URI; // .env 파일에 MONGO_URI가 설정되어 있어야 함

// 6. 미들웨어 설정
// CORS 미들웨어 적용 (HTTP 요청, 즉 REST API 통신을 위한 CORS)
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // origin이 없는 경우 허용
    if (!allowedOrigins.includes(origin)) {
      const msg = `CORS 허용되지 않은 출처입니다: ${origin}`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true // 크리덴셜 전송 허용
}));
// JSON 본문 파싱 미들웨어: 클라이언트에서 JSON 형식으로 보낸 요청 본문을 JavaScript 객체로 파싱합니다.
app.use(express.json());

// 7. MongoDB 데이터베이스 연결
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB에 성공적으로 연결되었습니다.')) // 연결 성공 시 로그
  .catch(err => console.error('❌ MongoDB 연결 오류:', err)); // 연결 실패 시 오류 로그

// --- MongoDB 스키마 및 모델 정의 ---
// 8. 예약 정보 스키마 (데이터베이스에 저장될 예약 데이터의 구조 정의)
const reservationSchema = new mongoose.Schema({
  roomNo: { type: String, required: true },
  name: { type: String, required: true },
  dormitory: { type: String, required: true },
  floor: { type: String, required: true },
  seat: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now } // 예약된 시간 기록
});
// 8-1. 중복 예약 방지를 위한 고유 인덱스 설정 (DB 레벨에서의 최종 방어막)
// 한 사용자는 하나의 예약만 가능 (roomNo, name 조합이 고유해야 함)
reservationSchema.index({ roomNo: 1, name: 1 }, { unique: true });
// 한 좌석은 하나의 예약만 가능 (dormitory, floor, seat 조합이 고유해야 함)
reservationSchema.index({ dormitory: 1, floor: 1, seat: 1 }, { unique: true });
const Reservation = mongoose.model('Reservation', reservationSchema); // 'Reservation' 모델 생성

// 8-2. 관리자 설정 스키마 (예약 가능 시간 등 시스템 설정을 위한 구조)
const adminSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // 설정 종류를 구분하는 고유 키 (예: 'reservationTimes')
  reservationStartTime: { type: Date, default: null }, // 예약 시작 시간
  reservationEndTime: { type: Date, default: null }    // 예약 종료 시간
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema); // 'AdminSetting' 모델 생성

// --- API 엔드포인트 정의 ---
// 클라이언트(프론트엔드)의 요청을 받아 처리하고 데이터를 주고받는 부분

// 9-1. 모든 예약 정보 조회 API (GET 요청)
// 클라이언트에서 현재 예약 현황을 요청할 때 사용
app.get('/api/reservations', async (req, res) => {
  try {
    const reservations = await Reservation.find({}); // 모든 예약 문서를 찾아 응답
    res.status(200).json(reservations);
  } catch (error) {
    console.error('API 에러: 예약 조회 실패:', error);
    res.status(500).json({ message: '예약 정보를 불러오는 데 실패했습니다.', error: error.message });
  }
});

// 9-2. 새로운 예약 생성 API (POST 요청)
// 클라이언트에서 좌석 예약 요청을 보낼 때 사용
app.post('/api/reservations', async (req, res) => {
  const { roomNo, name, dormitory, floor, seat } = req.body; // 요청 본문(JSON)에서 예약 데이터 추출
  try {
    // 1차 중복 방지 (사용자): 이미 해당 사용자(룸 번호, 이름)의 예약이 있는지 확인
    const existUser = await Reservation.findOne({ roomNo, name });
    if (existUser) {
      return res.status(409).json({ message: '이미 예약된 사용자입니다. 한 사람당 1자리만 예약 가능합니다.' });
    }
    // 2차 중복 방지 (좌석): 이미 해당 좌석(기숙사, 층, 좌석 번호)이 예약되었는지 확인
    const existSeat = await Reservation.findOne({ dormitory, floor, seat });
    if (existSeat) {
      return res.status(409).json({ message: '선택한 좌석은 이미 예약되었습니다. 다른 좌석을 선택해주세요.' });
    }

    const newReservation = new Reservation({ roomNo, name, dormitory, floor, seat });
    await newReservation.save(); // 데이터베이스에 새 예약 저장

    // 데이터 변경 후 모든 연결된 클라이언트(프론트엔드)에 실시간 알림
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations); // 최신 예약 목록을 Socket.IO로 전송

    res.status(201).json(newReservation); // 생성 성공 응답 (201 Created)
  } catch (error) {
    console.error('API 에러: 예약 생성 실패:', error);
    res.status(500).json({ message: '예약 생성에 실패했습니다.', error: error.message });
  }
});

// 9-3. 예약 삭제 API (DELETE 요청 - 관리자용, 예약 고유 _id 기준)
// 관리자 페이지에서 특정 예약을 취소할 때 사용
app.delete('/api/reservations/:id', async (req, res) => {
  try {
    const { id } = req.params; // URL 파라미터에서 예약 _id 추출
    const deleted = await Reservation.findByIdAndDelete(id); // _id에 해당하는 예약 삭제

    if (!deleted) { // 해당 ID의 예약이 없는 경우 (404 Not Found)
      return res.status(404).json({ message: '삭제할 예약을 찾을 수 없습니다.' });
    }

    // 데이터 변경 후 모든 연결된 클라이언트(프론트엔드)에 실시간 알림
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations); // 최신 예약 목록을 Socket.IO로 전송

    res.status(200).json({ message: '예약이 성공적으로 취소되었습니다.', deletedReservation: deleted });
  } catch (error) {
    console.error('API 에러: 예약 삭제 실패:', error);
    res.status(500).json({ message: '예약 삭제에 실패했습니다.', error: error.message });
  }
});

// 9-4. 사용자 기존 예약 삭제 API (DELETE 요청 - 자리 변경용, 룸번호/이름 기준)
// 사용자가 자신의 예약 자리를 변경할 때 프론트엔드에서 자동으로 호출
app.delete('/api/reservations/user/:roomNo/:name', async (req, res) => {
  try {
    const { roomNo, name } = req.params; // URL 파라미터에서 룸 번호와 이름 추출
    // 해당 룸 번호와 이름에 해당하는 예약 문서 하나를 삭제 (deleteOne)
    const resDel = await Reservation.deleteOne({ roomNo, name });

    // 데이터 변경 후 모든 연결된 클라이언트(프론트엔드)에 실시간 알림
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations); // 최신 예약 목록을 Socket.IO로 전송

    // 삭제된 문서가 없어도 성공 응답 반환 (프론트엔드에서 자리 변경 시 유연한 처리 위함)
    res.status(200).json({ message: '사용자 기존 예약 삭제 처리 완료.', deletedCount: resDel.deletedCount });
  } catch (error) {
    console.error('API 에러: 사용자 예약 삭제 실패:', error);
    res.status(500).json({ message: '사용자 예약 삭제 실패.', error: error.message });
  }
});

// 9-5. 관리자 예약 시간 설정 조회 API (GET 요청)
// 관리자 페이지 진입 시 현재 설정된 예약 시간을 불러올 때 사용
app.get('/api/admin-settings', async (req, res) => {
  try {
    let settings = await AdminSetting.findOne({ key: 'reservationTimes' }); // 'reservationTimes' 키를 가진 설정 문서를 찾음
    if (!settings) { // 설정 문서가 없으면 기본값으로 새로 생성하여 저장
      settings = new AdminSetting({ key: 'reservationTimes' });
      await settings.save();
    }
    res.status(200).json(settings); // 설정 정보 응답
  } catch (error) {
    console.error('API 에러: 관리자 설정 조회 실패:', error);
    res.status(500).json({ message: '관리자 설정 조회 실패.', error: error.message });
  }
});

// 9-6. 관리자 예약 시간 설정 업데이트 API (PUT 요청)
// 관리자가 예약 가능 시간을 설정하고 저장할 때 사용
app.put('/api/admin-settings', async (req, res) => {
  const { reservationStartTime, reservationEndTime } = req.body; // 요청 본문에서 시간 데이터 추출
  try {
    // 'reservationTimes' 키를 찾아 업데이트하거나, 없으면 새로 생성 (upsert: true)
    const settings = await AdminSetting.findOneAndUpdate(
      { key: 'reservationTimes' },
      { reservationStartTime, reservationEndTime },
      { new: true, upsert: true } // new: 업데이트된 문서 반환, upsert: 없으면 생성
    );

    // 데이터 변경 후 모든 연결된 클라이언트(프론트엔드)에 실시간 알림
    io.emit('settingsUpdated', settings); // 최신 설정 정보 (Socket.IO로) 전송

    res.status(200).json(settings); // 업데이트된 설정 정보 응답
  } catch (error) {
    console.error('API 에러: 관리자 설정 저장 실패:', error);
    res.status(500).json({ message: '관리자 설정 저장 실패.', error: error.message });
  }
});

// --- Socket.IO 연결 이벤트 핸들링 ---
// 10. 클라이언트와 서버 간의 Socket.IO 연결 및 해제 이벤트 처리
io.on('connection', (socket) => {
  console.log('🔗 클라이언트 접속됨:', socket.id); // 클라이언트가 연결될 때 콘솔에 로그
  socket.on('disconnect', () => {
    console.log('💔 클라이언트 연결 끊김:', socket.id); // 클라이언트 연결이 끊어질 때 콘솔에 로그
  });
});

// --- 서버 시작 ---
// 11. 지정된 PORT에서 서버를 시작하고 연결을 수신 대기
server.listen(PORT, () => {
  console.log(`🚀 서버 실행 중: http://localhost:${PORT}`); // 서버 실행 시 콘솔에 로그
});