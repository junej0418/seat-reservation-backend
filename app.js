// app.js (전체 코드)
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit'); // 'express-limiter'에서 'express-rate-limit'으로 수정

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL, methods: ['GET','POST','PUT','DELETE'], credentials: true }
});

app.set('trust proxy', true);
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60000,
  max: 20,
  message: '너무 많은 요청입니다. 잠시 후 시도해주세요.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.path === '/api/reservations/all' // 모든 예약 삭제 요청에는 rate limiting 적용하지 않음
});
app.use(limiter);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB 연결 성공'))
  .catch(console.error);

// 스키마 및 모델 정의
const reservationSchema = new mongoose.Schema({
  roomNo: String, name: String, dormitory: String, floor: String, seat: Number, createdAt: { type: Date, default: Date.now }
});
reservationSchema.index({ roomNo:1, name:1 }, { unique: true }); // 이름 + 룸 번호 조합은 고유
reservationSchema.index({ dormitory:1, floor:1, seat:1 }, { unique: true }); // 기숙사 + 층 + 좌석 조합은 고유 (좌석 중복 예약 방지)
const Reservation = mongoose.model('Reservation', reservationSchema);

const adminSettingSchema = new mongoose.Schema({
  // 이 모델의 key 필드는 유일하게 'adminSettings' 값을 가질 것임
  key: { type: String, unique: true, default: 'adminSettings' }, 
  reservationStartTime: Date,
  reservationEndTime: Date
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

const announcementSchema = new mongoose.Schema({
  // 이 모델의 key 필드는 유일하게 'announcement' 값을 가질 것임
  key: { type: String, unique: true, default: 'announcement' },
  message: String,
  active: Boolean,
  updatedAt: { type: Date, default: Date.now }
});
const Announcement = mongoose.model('Announcement', announcementSchema);

const cancelledReservationSchema = new mongoose.Schema({
  originalReservationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Reservation' },
  roomNo: String, name: String,
  dormitory: String, floor: String, seat: Number,
  reservationMadeAt: Date, // 예약이 최초 생성된 시점
  cancelledAt: { type: Date, default: Date.now } // 예약이 취소된 시점
});
const CancelledReservation = mongoose.model('CancelledReservation', cancelledReservationSchema);

// Socket.IO 이벤트 전파 함수 (중복 코드를 줄이고 일관성 유지)
const emitReservationsUpdate = async () => {
    const reservations = await Reservation.find();
    io.emit('reservationsUpdated', reservations);
};

const emitAdminSettingsUpdate = async () => {
    const settings = await AdminSetting.findOne();
    io.emit('settingsUpdated', settings);
};

const emitAnnouncementUpdate = async () => {
    const announcement = await Announcement.findOne();
    io.emit('announcementUpdated', announcement);
};

// 모든 예약 조회
app.get('/api/reservations', async (req, res) => {
  try {
    const reservations = await Reservation.find();
    res.json(reservations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '예약 조회 실패' });
  }
});

// 예약 생성
app.post('/api/reservations', async (req, res) => {
  try {
    const { roomNo, name, dormitory, floor, seat } = req.body;

    // 중복 예약 방지 (예외 처리)
    const existingReservation = await Reservation.findOne({ roomNo, name, dormitory });
    if (existingReservation) {
        return res.status(400).json({ message: '이미 해당 정보로 예약된 좌석이 있습니다. 좌석을 변경하려면 예약 변경 기능을 사용해주세요.' });
    }
    const existingSeatReservation = await Reservation.findOne({ dormitory, floor, seat });
    if (existingSeatReservation) {
        return res.status(400).json({ message: '선택하신 좌석은 이미 예약되었습니다.' });
    }

    const newReservation = new Reservation({ roomNo, name, dormitory, floor, seat });
    await newReservation.save();
    emitReservationsUpdate(); // 모든 클라이언트에게 업데이트 알림
    res.status(201).json({ message: '예약이 완료되었습니다.', newReservation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '예약 생성 실패' });
  }
});

// 예약 삭제 (취소)
app.delete('/api/reservations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deletedReservation = await Reservation.findByIdAndDelete(id);

    if (!deletedReservation) {
      return res.status(404).json({ message: '해당 예약을 찾을 수 없습니다.' });
    }

    // 취소된 예약 기록
    const cancelled = new CancelledReservation({
        originalReservationId: deletedReservation._id,
        roomNo: deletedReservation.roomNo,
        name: deletedReservation.name,
        dormitory: deletedReservation.dormitory,
        floor: deletedReservation.floor,
        seat: deletedReservation.seat,
        reservationMadeAt: deletedReservation.createdAt // 기존 예약의 생성일
    });
    await cancelled.save();

    emitReservationsUpdate(); // 모든 클라이언트에게 업데이트 알림
    res.json({ message: '예약이 성공적으로 취소되었습니다.', deletedReservation });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '예약 취소 실패' });
  }
});

// ⭐⭐⭐ 이 부분이 새롭게 추가되는 예약 변경 (PUT) API 라우트입니다. ⭐⭐⭐
app.put('/api/reservations/update/:id', async (req, res) => {
  try {
    const { id } = req.params; // 변경할 예약의 _id
    const { roomNo, name, dormitory, floor, seat } = req.body; // 업데이트될 정보

    // 현재 사용자의 기존 예약 확인 (이동 전 좌석)
    const existingReservation = await Reservation.findById(id);
    if (!existingReservation) {
      return res.status(404).json({ message: '해당 예약을 찾을 수 없습니다.' });
    }

    // 변경하려는 새 좌석이 이미 다른 사람에게 예약되어 있는지 확인
    // 이때, 자기 자신의 기존 예약 (_id)은 중복 검사에서 제외해야 함
    const isNewSeatBookedByOthers = await Reservation.findOne({
        dormitory, floor, seat,
        _id: { $ne: id } // 현재 업데이트하는 자신의 _id는 제외
    });
    if (isNewSeatBookedByOthers) {
        return res.status(400).json({ message: '선택하신 좌석은 이미 다른 사람에게 예약되었습니다.' });
    }

    // 예약 정보 업데이트
    const updatedReservation = await Reservation.findByIdAndUpdate(
      id,
      { roomNo, name, dormitory, floor, seat },
      { new: true, runValidators: true } // 업데이트 후의 새로운 문서를 반환
    );

    emitReservationsUpdate(); // 모든 클라이언트에게 업데이트 알림
    res.json({ message: '예약이 성공적으로 변경되었습니다.', updatedReservation });
  } catch (err) {
    console.error('예약 변경 오류:', err);
    // Mongoose duplicate key error (11000) 처리: roomNo + name 조합이 중복되는 경우
    if (err.code === 11000) {
        // 이 에러는 주로 roomNo + name unique 인덱스 때문이거나, seat unique 인덱스 때문일 수 있습니다.
        // seat unique 인덱스에 대한 처리는 이미 위에서 했습니다.
        // 만약 roomNo+name 조합이 다른 예약과 겹친다면, 이 에러가 발생할 수 있습니다.
        return res.status(400).json({ message: '입력하신 룸 번호와 이름으로 이미 다른 예약이 존재합니다. 다시 확인해주세요.' });
    }
    res.status(500).json({ message: '예약 변경 실패', error: err.message });
  }
});
// ⭐⭐⭐ 예약 변경 (PUT) API 라우트 추가 끝 ⭐⭐⭐

// 모든 예약 삭제 (관리자용)
app.delete('/api/reservations/all', async (req, res) => {
    try {
        const reservationsToDelete = await Reservation.find({});
        // 각 예약을 삭제하면서 취소 기록도 남기도록 구현
        for (const resData of reservationsToDelete) {
            const cancelled = new CancelledReservation({
                originalReservationId: resData._id,
                roomNo: resData.roomNo,
                name: resData.name,
                dormitory: resData.dormitory,
                floor: resData.floor,
                seat: resData.seat,
                reservationMadeAt: resData.createdAt
            });
            await cancelled.save();
        }
        await Reservation.deleteMany({}); // 모든 예약 삭제

        emitReservationsUpdate();
        res.json({ message: '모든 예약이 성공적으로 삭제되었습니다.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: '모든 예약 삭제 실패' });
    }
});


// 관리자 설정 조회 및 저장 API
app.get('/api/admin-settings', async (req, res) => {
    try {
        let settings = await AdminSetting.findOne();
        if (!settings) {
            settings = new AdminSetting({ key: 'adminSettings', reservationStartTime: null, reservationEndTime: null });
            await settings.save();
        }
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: '설정 조회 실패' });
    }
});

app.put('/api/admin-settings', async (req, res) => {
    try {
        const { reservationStartTime, reservationEndTime } = req.body;
        // 'adminSettings' 키를 가진 문서를 찾아서 업데이트, 없으면 새로 생성
        const updatedSettings = await AdminSetting.findOneAndUpdate(
            { key: 'adminSettings' },
            { reservationStartTime, reservationEndTime },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        emitAdminSettingsUpdate();
        res.json({ message: '설정 저장 성공', updatedSettings });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: '설정 저장 실패' });
    }
});


// 공지사항 조회 및 저장 API
app.get('/api/announcement', async (req, res) => {
    try {
        let announcement = await Announcement.findOne();
        if (!announcement) {
            announcement = new Announcement({ key: 'announcement', message: '', active: false });
            await announcement.save();
        }
        res.json(announcement);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: '공지사항 조회 실패' });
    }
});

app.put('/api/announcement', async (req, res) => {
    try {
        const { message, active } = req.body;
        const updatedAnnouncement = await Announcement.findOneAndUpdate(
            { key: 'announcement' },
            { message, active, updatedAt: new Date() },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        emitAnnouncementUpdate();
        res.json({ message: '공지사항 저장 성공', updatedAnnouncement });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: '공지사항 저장 실패' });
    }
});


// 관리자 로그인
app.post('/api/admin-login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) { // .env 파일에 ADMIN_PASSWORD 설정 필요
        res.json({ success: true, message: '관리자 로그인 성공' });
    } else {
        res.status(401).json({ success: false, message: '비밀번호가 올바르지 않습니다.' });
    }
});

// Socket.IO 연결 핸들러
io.on('connection', (socket) => {
  console.log('클라이언트 연결됨:', socket.id);

  // 클라이언트 연결 시 현재 예약 정보와 관리자 설정, 공지사항을 즉시 전송
  emitReservationsUpdate();
  emitAdminSettingsUpdate();
  emitAnnouncementUpdate();

  socket.on('disconnect', () => {
    console.log('클라이언트 연결 해제됨:', socket.id);
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`서버 시작 on port ${process.env.PORT || 3000}`);
});
