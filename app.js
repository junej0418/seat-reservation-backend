const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// 허용된 ORIGIN(도메인) 목록
// FRONTEND_URL은 .env 파일에서 설정됩니다 (예: http://localhost:5500 또는 배포된 Netlify 주소)
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',   // VS Code Live Server의 일반적인 로컬호스트 주소
  'http://127.0.0.1:5500',   // VS Code Live Server의 일반적인 127.0.0.1 주소
  'http://localhost:3000',   // 백엔드 자체도 Origin으로 요청할 수 있음
  'http://127.0.0.1:3000',   // 백엔드 자체도 Origin으로 요청할 수 있음
  null,                      // HTML 파일을 로컬 시스템(file://)에서 직접 열 때
  'https://heartfelt-cannoli-903df2.netlify.app', // 배포된 Netlify 프론트엔드 주소 (실제 운영 시에는 이 주소를 정확히 명시)
];

// Socket.IO CORS 설정
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // origin이 없는 경우 (예: Postman, 같은 서버 내 요청, 로컬 파일 직접 열기) 허용
      if (!origin) return callback(null, true);
      // allowedOrigins 목록에 있으면 허용, 없으면 차단
      if (!allowedOrigins.includes(origin)) {
        console.warn(`CORS 차단된 도메인 감지: ${origin}`);
        return callback(new Error("CORS 차단된 도메인"), false);
      }
      return callback(null, true);
    },
    methods: ['GET','POST','PUT','DELETE'], // 허용할 HTTP 메서드
    credentials: true // 자격 증명 (쿠키, HTTP 인증 등) 허용 여부
  }
});

const PORT = process.env.PORT || 3000; // 서버 포트
const MONGO_URI = process.env.MONGO_URI; // MongoDB 연결 URI
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // 관리자 비밀번호 (환경 변수로 설정)

// 일반 Express 앱 CORS 설정
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null,true);
    if (!allowedOrigins.includes(origin)) {
      console.warn(`CORS 차단된 도메인 감지: ${origin}`);
      return callback(new Error("CORS 차단된 도메인"), false);
    }
    callback(null,true);
  },
  credentials: true
}));

app.use(express.json()); // JSON 형식의 요청 본문을 파싱하기 위한 미들웨어

// API 요청 속도 제한 (Rate Limiting) 미들웨어
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1분 (ms)
  max: 20, // 1분당 최대 20개의 요청 허용
  message: '너무 많은 요청입니다. 잠시 후 다시 시도해주세요.',
  standardHeaders: true, // RateLimit 헤더 (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset) 추가
  legacyHeaders: false, // X-RateLimit-* 헤더 비활성화
  // 특정 경로 (관리자 API)는 속도 제한을 건너_입니다.
  skip: req => req.path === '/api/reservations/all' || req.path.startsWith('/api/admin-settings') || req.path.startsWith('/api/announcement')
});
app.use(limiter); // 모든 라우트에 Rate Limiter 적용

// MongoDB 연결
mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB 연결 성공'))
  .catch(err => console.error('MongoDB 연결 실패:', err));

// MongoDB 스키마 및 모델 정의

// 1. 예약 정보 스키마
const reservationSchema = new mongoose.Schema({
  roomNo: {type:String, required:true},      // 룸 번호 (예: 101호)
  name: {type:String, required:true},        // 이름 (예: 홍길동)
  dormitory: {type:String, required:true},   // 기숙사 (예: 꿈동, 미래동)
  floor: {type:String, required:true},       // 층 (예: 2, 4-1)
  seat: {type:Number, required:true},        // 좌석 번호 (예: 5)
  createdAt: {type:Date, default:Date.now},  // 예약 생성/변경 시간 (밀리초 단위 자동 저장)
  deviceIdentifier: {type: String, required: false} // 예약한 기기의 고유 식별자 (필수 아님, 기존 데이터 호환)
});

// 복합 인덱스: 룸번호+이름 조합은 고유해야 함 (한 사람이 여러 예약 불가)
reservationSchema.index({roomNo:1, name:1}, {unique:true});
// 복합 인덱스: 기숙사+층+좌석 번호 조합은 고유해야 함 (한 좌석에 여러 예약 불가)
reservationSchema.index({dormitory:1, floor:1, seat:1},{unique:true});
const Reservation = mongoose.model('Reservation', reservationSchema);

// 2. 관리자 설정 스키마 (예약 가능 시간 등)
const adminSettingSchema = new mongoose.Schema({
  key: {type:String, unique:true, required:true}, // 설정의 고유 키 (예: 'reservationTimes')
  reservationStartTime: {type:Date, default:null}, // 예약 시작 가능 시간
  reservationEndTime: {type:Date, default:null}    // 예약 종료 가능 시간
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

// 3. 공지사항 스키마
const announcementSchema = new mongoose.Schema({
  key: {type:String, unique:true, default:'currentAnnouncement'}, // 공지사항의 고유 키 (고정값)
  message: {type:String, default:''},     // 공지 내용
  active: {type:Boolean, default:false},  // 공지 활성화 여부
  updatedAt: {type:Date, default:Date.now} // 마지막 업데이트 시간
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// 미들웨어: 관리자 권한 인증
// Authorization 헤더에 'Bearer <ADMIN_PASSWORD>' 형식으로 비밀번호를 전달해야 함
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: '인증 헤더가 필요합니다.' });
  }
  const adminPassword = authHeader.split(' ')[1]; // 'Bearer ' 접두사를 제거하고 비밀번호만 추출

  if (!ADMIN_PASSWORD) {
    console.error('[인증 오류] ADMIN_PASSWORD 환경 변수가 설정되지 않았습니다.');
    return res.status(500).json({ success: false, message: '서버 관리자 비밀번호가 설정되지 않았습니다.' });
  }
  if (adminPassword !== ADMIN_PASSWORD) {
    console.warn(`[인증 오류] 관리자 비밀번호 불일치. 시도 IP: ${req.ip}`);
    return res.status(403).json({ success: false, message: '관리자 권한이 없습니다. 비밀번호가 일치하지 않습니다.' });
  }
  next(); // 인증 성공 시 다음 미들웨어 또는 라우트 핸들러로 제어권 넘김
};

// API 라우트 정의

// 1. 관리자 로그인 API
app.post('/api/admin-login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ success: false, message: '비밀번호를 입력해주세요.' });
  if (!ADMIN_PASSWORD) return res.status(500).json({ success: false, message: '서버 관리자 비밀번호가 설정되지 않았습니다.' });

  if (password === ADMIN_PASSWORD) {
    console.log(`[관리자 로그인] 성공: IP ${req.ip}`);
    return res.json({ success: true, message: '관리자 로그인 성공' });
  } else {
    console.warn(`[관리자 로그인] 실패: 비밀번호 오류. IP ${req.ip}`);
    return res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
  }
});

// 2. 모든 예약 조회 API
app.get('/api/reservations', async (req, res) => {
  try {
    const reservations = await Reservation.find({});
    res.json(reservations);
  } catch (e) {
    console.error("예약 조회 실패:", e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 3. 예약 생성 및 변경(자리 이동) API
app.post('/api/reservations', async (req, res) => {
  // Honeypot 필드가 채워졌다면 비정상적인 요청으로 간주하고 차단 (봇 공격 방지)
  if (req.body.honeypot_field) return res.status(400).json({ message: '비정상적 요청' });

  const { roomNo, name, dormitory, floor, seat, deviceIdentifier } = req.body;
  // 필수 정보 누락 확인
  if (!roomNo || !name || !dormitory || !floor || seat == null) {
    console.warn(`[예약 처리] 필수 정보 누락: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ message: '모든 정보를 입력하세요.' });
  }

  // 예약 가능 시간 확인 (관리자 설정)
  const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
  if (!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime) {
    console.warn(`[예약 처리] 예약 가능 시간 미설정`);
    return res.status(403).json({ message: '예약 가능 시간이 설정되지 않았습니다.' });
  }
  const now = new Date();
  if (now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime) {
    console.warn(`[예약 처리] 현재 예약 가능 시간 아님: 요청(${roomNo} ${name})`);
    return res.status(403).json({ message: '현재 예약 가능 시간이 아닙니다.' });
  }

  try {
    const conflictSeat = await Reservation.findOne({ dormitory, floor, seat }); // 선택한 좌석이 이미 예약되었는지 확인
    const existingUser = await Reservation.findOne({ roomNo, name }); // 요청하는 사용자가 이미 예약했는지 확인

    // 좌석 충돌 처리: 다른 사용자가 이미 선택한 좌석이거나, 현재 사용자가 자신의 기존 예약 외 다른 좌석을 선택한 경우
    if (conflictSeat && (!existingUser || existingUser._id.toString() !== conflictSeat._id.toString())) {
      console.warn(`[예약 실패] 좌석 중복. 기존: ${conflictSeat.roomNo} ${conflictSeat.name} / 요청: ${roomNo} ${name} - ${dormitory} ${floor}층 ${seat}번`);
      return res.status(409).json({ message: '선택한 좌석은 이미 예약되었습니다.' });
    }

    let reservation;
    if (existingUser) { // 사용자가 이미 예약 내역이 있다면, 해당 예약 정보를 업데이트 (자리 이동)
      reservation = await Reservation.findByIdAndUpdate(
        existingUser._id,
        { dormitory, floor, seat, createdAt: new Date(), deviceIdentifier }, // `createdAt`은 변경 시점 기록
        { new: true, runValidators: true } // 업데이트된 문서 반환 및 스키마 유효성 검사
      );
      console.log(`[예약 변경 성공] ${roomNo} ${name} (이전: ${existingUser.floor}층 ${existingUser.seat}번) -> (새: ${dormitory} ${floor}층 ${seat}번) (기기: ${deviceIdentifier || '없음'})`);
    } else { // 새로운 예약 생성
      reservation = new Reservation({ roomNo, name, dormitory, floor, seat, deviceIdentifier });
      await reservation.save();
      console.log(`[신규 예약 성공] ${roomNo} ${name} -> ${dormitory} ${floor}층 ${seat}번 (기기: ${deviceIdentifier || '없음'})`);
    }

    // 예약 정보가 변경되었으므로 모든 클라이언트에게 업데이트된 예약 목록 전송
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({ message: '예약 성공', newReservation: reservation });
  } catch (e) {
    console.error("예약 처리 중 오류:", e);
    if (e.code === 11000) { // MongoDB의 고유(unique) 인덱스 충돌 오류
      console.error(`[예약 실패] MongoDB 중복 오류. 요청: ${roomNo} ${name}, ${dormitory} ${floor}층 ${seat}번`);
      return res.status(409).json({ message: '중복된 예약이 있습니다. (예: 이미 등록된 룸번호/이름 조합이거나, 이미 예약된 좌석)' });
    }
    res.status(500).json({ message: '서버 오류' });
  }
});

// 4. 예약 정보 업데이트 (PUT) API
// 주로 프론트엔드에서 특정 예약 ID를 통해 예약 변경 요청을 보낼 때 사용 (내부 로직을 POST에서 PUT으로 분리하는 목적)
app.put('/api/reservations/update/:id', async (req, res) => {
  if (req.body.honeypot_field) return res.status(400).json({ message: '비정상적 요청' });

  const { id } = req.params; // URL 파라미터에서 업데이트할 예약의 _id 가져옴
  const { roomNo, name, dormitory, floor, seat, requestingUserRoomNo, requestingUserName, requestingUserDormitory, deviceIdentifier } = req.body;

  // 필수 정보 누락 확인
  if (!roomNo || !name || !dormitory || !floor || seat == null) {
    console.warn(`[예약 변경 처리] 필수 정보 누락: ${JSON.stringify(req.body)}`);
    return res.status(400).json({ message: '모든 정보를 입력하세요.' });
  }

  // 예약 가능 시간 확인
  const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
  if (!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime) {
    console.warn(`[예약 변경 처리] 예약 가능 시간 미설정`);
    return res.status(403).json({ message: '예약 가능 시간이 설정되지 않았습니다.' });
  }
  const now = new Date();
  if (now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime) {
    console.warn(`[예약 변경 처리] 현재 예약 가능 시간 아님: 요청(${roomNo} ${name})`);
    return res.status(403).json({ message: '현재 예약 가능 시간이 아닙니다.' });
  }

  try {
    const existingReservation = await Reservation.findById(id); // 업데이트할 원본 예약 찾기
    if (!existingReservation) {
      console.warn(`[예약 변경 실패] ID ${id} 에 해당하는 예약을 찾을 수 없음.`);
      return res.status(404).json({ message: '해당 예약을 찾을 수 없습니다.' });
    }

    // 본인 예약 확인: 요청하는 사용자 정보와 기존 예약 정보가 일치하는지 검증
    if (existingReservation.roomNo !== requestingUserRoomNo ||
        existingReservation.name !== requestingUserName ||
        existingReservation.dormitory !== requestingUserDormitory) {
        console.warn(`[예약 변경 실패] 다른 사용자의 예약 변경 시도: 요청(${requestingUserRoomNo} ${requestingUserName}), 대상(${existingReservation.roomNo} ${existingReservation.name})`);
        return res.status(403).json({ message: '본인의 예약만 변경할 수 있습니다.' });
    }
    
    // 기기 식별자 확인: 예약 시 사용한 기기와 현재 요청 기기가 일치하는지 검증
    // (기존에 deviceIdentifier가 없던 예약은 이 검사를 스킵하여 호환성 유지)
    if (existingReservation.deviceIdentifier && existingReservation.deviceIdentifier !== deviceIdentifier) {
        console.warn(`[예약 변경 실패] 기기 불일치: ${roomNo} ${name}. 기존: ${existingReservation.deviceIdentifier || '없음'}, 요청: ${deviceIdentifier || '없음'}`);
        return res.status(403).json({ message: '예약 시 사용한 기기에서만 변경할 수 있습니다.' });
    }

    // 변경하려는 새 좌석이 다른 사람에게 이미 예약되어 있는지 확인 (단, 자기 자신의 기존 좌석은 제외)
    const isNewSeatBookedByOthers = await Reservation.findOne({
      dormitory, floor, seat,
      _id: { $ne: id } // 현재 업데이트하려는 예약의 ID와 다른 문서들 중에서만 찾음
    });
    if (isNewSeatBookedByOthers) {
      console.warn(`[예약 변경 실패] 새 좌석 중복: ${dormitory} ${floor}층 ${seat}번. 이미 ${isNewSeatBookedByOthers.roomNo} ${isNewSeatBookedByOthers.name}가 예약`);
      return res.status(409).json({ message: '선택하신 좌석은 이미 다른 사람에게 예약되었습니다.' });
    }
    
    // 예약 정보 업데이트 수행
    const updatedReservation = await Reservation.findByIdAndUpdate(
      id,
      { roomNo, name, dormitory, floor, seat, createdAt: new Date(), deviceIdentifier }, // createdAt 및 deviceIdentifier도 갱신
      { new: true, runValidators: true } // 업데이트된 문서 반환, 스키마 유효성 검사 실행
    );
    console.log(`[예약 변경 성공] ${roomNo} ${name}: ${existingReservation.floor}층 ${existingReservation.seat}번 -> ${dormitory} ${floor}층 ${seat}번 (기기: ${deviceIdentifier || '없음'})`);

    // 모든 클라이언트에게 업데이트된 예약 목록 전송
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({ message: '예약이 성공적으로 변경되었습니다.', updatedReservation });
  } catch (e) {
    console.error("예약 변경 처리 중 오류:", e);
    if (e.code === 11000) { // MongoDB 고유 인덱스 충돌
      console.error(`[예약 변경 실패] MongoDB 중복 오류. 요청: ${roomNo} ${name}, ${dormitory} ${floor}층 ${seat}번`);
      return res.status(409).json({ message: '중복된 예약 정보가 발생했습니다. (예: 이미 해당 룸번호/이름 또는 좌석이 사용 중)' });
    }
    res.status(500).json({ message: '서버 오류', error: e.message });
  }
});


// 5. 모든 예약 삭제 API (관리자만 가능)
app.delete('/api/reservations/all', async (req, res) => {
  const { adminPassword } = req.body;
  if (!ADMIN_PASSWORD || adminPassword !== ADMIN_PASSWORD) {
    console.warn(`[모든 예약 삭제 실패] 관리자 비밀번호 불일치. IP: ${req.ip}`);
    return res.status(403).json({ success: false, message: '관리자 권한이 없습니다.' });
  }
  try {
    await Reservation.deleteMany({}); // 모든 예약 문서 삭제
    const allReservations = await Reservation.find({}); // 빈 예약 목록
    io.emit('reservationsUpdated', allReservations); // 모든 클라이언트에 업데이트된 목록 전송
    console.log(`[모든 예약 삭제 성공] 관리자 ${req.ip} 가 모든 예약을 삭제했습니다.`);
    res.json({ message: '모든 예약 취소 완료' });
  } catch (e) {
    console.error("모든 예약 취소 중 오류:", e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 6. 개별 예약 삭제 API (본인 기기 또는 관리자만 가능)
app.delete('/api/reservations/:id', async (req, res) => {
  const { id } = req.params; // 삭제할 예약의 _id
  // 요청 본문에서 사용자 정보, 관리자 여부, 관리자 비밀번호, 기기 식별자를 받아옴
  const { requestingUserRoomNo, requestingUserName, requestingUserDormitory, isAdmin, adminPassword, deviceIdentifier } = req.body;

  try {
    const reservationToCancel = await Reservation.findById(id); // 취소할 예약 찾기
    if (!reservationToCancel) {
      console.warn(`[예약 취소 실패] ID ${id} 에 해당하는 예약을 찾을 수 없음.`);
      return res.status(404).json({ message: '취소할 예약을 찾을 수 없습니다.' });
    }

    // 권한 검증 로직
    if (isAdmin) { // 관리자 요청인 경우
      // 관리자 비밀번호 검증
      if (!ADMIN_PASSWORD || adminPassword !== ADMIN_PASSWORD) {
        console.warn(`[예약 취소 실패] 관리자 비밀번호 불일치. 요청자: ${req.ip}, 시도 ID: ${id}`);
        return res.status(403).json({ success: false, message: '관리자 비밀번호가 일치하지 않아 취소할 수 없습니다.' });
      }
      console.log(`[예약 취소 성공 (관리자)] ${reservationToCancel.roomNo} ${reservationToCancel.name} 의 ${reservationToCancel.floor}층 ${reservationToCancel.seat}번 예약 취소 (관리자: ${req.ip})`);
    } else { // 일반 사용자 요청인 경우
      // 필수 사용자 정보 누락 확인
      if (!requestingUserRoomNo || !requestingUserName || !requestingUserDormitory) {
          console.warn(`[예약 취소 실패] 사용자 정보 부족. 요청 IP: ${req.ip}, 시도 ID: ${id}`);
          return res.status(400).json({ message: '예약 취소를 위한 사용자 정보가 부족합니다.' });
      }
      // 예약 소유자 확인
      if (reservationToCancel.roomNo !== requestingUserRoomNo ||
          reservationToCancel.name !== requestingUserName ||
          reservationToCancel.dormitory !== requestingUserDormitory) {
          console.warn(`[예약 취소 실패] 다른 사용자의 예약 취소 시도: 요청(${requestingUserRoomNo} ${requestingUserName}), 대상(${reservationToCancel.roomNo} ${reservationToCancel.name})`);
          return res.status(403).json({ message: '본인의 예약만 취소할 수 있습니다.' });
      }
      // 기기 식별자 확인 (기존 예약 호환성 위해 deviceIdentifier가 없으면 검사 스킵)
      if (reservationToCancel.deviceIdentifier && reservationToCancel.deviceIdentifier !== deviceIdentifier) {
        console.warn(`[예약 취소 실패] 기기 불일치: 요청(${requestingUserRoomNo} ${requestingUserName}). 기존 기기: ${reservationToCancel.deviceIdentifier || '없음'}, 요청 기기: ${deviceIdentifier || '없음'}`);
        return res.status(403).json({ message: '예약 시 사용한 기기에서만 취소할 수 있습니다.' });
      }
      console.log(`[예약 취소 성공 (사용자)] ${requestingUserRoomNo} ${requestingUserName} 가 ${reservationToCancel.floor}층 ${reservationToCancel.seat}번 예약 취소 (기기: ${deviceIdentifier || '없음'})`);
    }

    // 예약 삭제 실행
    const del = await Reservation.findByIdAndDelete(id);
    if (!del) return res.status(404).json({ message: '예약 없음' }); // 이미 삭제되었을 경우

    // 예약 정보 변경 알림
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({ message: '예약 취소 완료' });
  } catch (e) {
    console.error("예약 취소 중 오류:", e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 7. 공지사항 조회 API (관리자 인증 필요)
app.get('/api/announcement', authenticateAdmin, async (req, res) => {
  try {
    let announcement = await Announcement.findOne({ key: 'currentAnnouncement' });
    if (!announcement) {
      announcement = new Announcement({ key: 'currentAnnouncement', message: "", active: false });
      await announcement.save();
      console.log('[공지사항] 기본 설정 생성됨.');
    }
    res.json(announcement);
  } catch (e) {
    console.error("공지사항 불러오기 실패:", e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// 8. 공지사항 업데이트 API (관리자 인증 필요)
app.put('/api/announcement', authenticateAdmin, async (req, res) => {
  try {
    const { message, active } = req.body;
    const updated = await Announcement.findOneAndUpdate(
      { key: 'currentAnnouncement' },
      { message, active, updatedAt: new Date() },
      { new: true, upsert: true }
    );
    io.emit('announcementUpdated', updated);
    console.log(`[공지사항 저장 성공] 메시지: "${message}", 활성화: ${active} (관리자: ${req.ip})`);
    res.json(updated);
  } catch (e) {
    console.error("공지사항 저장 실패:", e);
    res.status(500).json({ message: '서버 오류' });
  }
});

// Socket.IO 연결 이벤트
io.on('connection', socket => {
  console.log(`클라이언트 접속: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`클라이언트 연결 종료: ${socket.id}`);
  });
});

// 서버 시작
server.listen(PORT, () => {
  console.log(`서버 시작: http://localhost:${PORT}`);
});