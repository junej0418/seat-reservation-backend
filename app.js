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

    // 허용 도메인 리스트
    const allowedOrigins = [
      process.env.FRONTEND_URL,
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      null,
      'https://heartfelt-cannoli-903df2.netlify.app',
    ];

    // Socket.IO 인스턴스 생성 (CORS 설정 포함)
    const io = new Server(server, {
      cors: {
        origin: (origin, callback) => {
          if (!origin) return callback(null, true);
          if (!allowedOrigins.includes(origin)) return callback(new Error('CORS 차단된 도메인'), false);
          callback(null, true);
        },
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true
      }
    });

    const PORT = process.env.PORT || 3000;
    const MONGO_URI = process.env.MONGO_URI;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

    // 미들웨어 설정
    app.use(cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (!allowedOrigins.includes(origin)) return callback(new Error('CORS 차단된 도메인'), false);
        callback(null, true);
      },
      credentials: true,
    }));
    app.use(express.json());

    // API 호출 속도 제한
    const limiter = rateLimit({
      windowMs: 60000,
      max: 20,
      message: '너무 많은 요청입니다. 잠시 후 시도해주세요.',
      standardHeaders: true,
      legacyHeaders: false,
      skip: req => req.path === '/api/reservations/all',
    });

    // MongoDB 연결 (타임아웃 15초로)
    mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 15000,
    })
    .then(() => console.log('MongoDB 연결 성공'))
    .catch(err => console.error('MongoDB 연결 실패:', err));


    // 예약 스키마 및 모델 (비밀번호 해싱 포함)
    const reservationSchema = new mongoose.Schema({
      roomNo: { type: String, required: true },
      name: { type: String, required: true },
      dormitory: { type: String, required: true },
      floor: { type: String, required: true },
      seat: { type: Number, required: true },
      password: { type: String, required: true }, // 해싱된 비밀번호
      plainPassword: { type: String, required: true }, // 관리자 확인용 평문 비밀번호
      createdAt: { type: Date, default: Date.now },
    });
    reservationSchema.index({ roomNo: 1, name: 1 }, { unique: true });
    reservationSchema.index({ dormitory: 1, floor: 1, seat: 1 }, { unique: true });

    reservationSchema.pre('save', async function(next) {
      if (this.isModified('password') && this.password.length < 50) {
        this.password = await bcrypt.hash(this.password, 10);
      }
      next();
    });
    const Reservation = mongoose.model('Reservation', reservationSchema);


    // 관리자 설정 스키마 및 모델
    const adminSettingSchema = new mongoose.Schema({
      key: { type: String, unique: true, required: true },
      reservationStartTime: { type: Date, default: null },
      reservationEndTime: { type: Date, default: null },
    });
    const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

    // 공지사항 스키마 및 모델
    const announcementSchema = new mongoose.Schema({
      key: { type: String, unique: true, default: 'currentAnnouncement' },
      message: { type: String, default: '' },
      active: { type: Boolean, default: false },
      updatedAt: { type: Date, default: Date.now },
    });
    const Announcement = mongoose.model('Announcement', announcementSchema);

    // 관리자 로그인 API
    app.post('/api/admin-login', (req, res) => {
      const { password } = req.body;
      if (!password) return res.status(400).json({ success: false, message: '비밀번호를 입력해주세요.' });
      if (!ADMIN_PASSWORD) return res.status(500).json({ success: false, message: '서버 관리자 비밀번호 미설정' });
      if (password === ADMIN_PASSWORD) {
        console.log(`관리자 로그인 성공 - IP: ${req.ip} - 시간: ${new Date().toISOString()}`);
        return res.json({ success: true, message: '관리자 로그인 성공' });
      } else {
        console.log(`관리자 로그인 실패 - IP: ${req.ip} - 시간: ${new Date().toISOString()}`);
        return res.status(401).json({ success: false, message: '비밀번호가 틀렸습니다.' });
      }
    });

    // 예약 전체 조회 API
    app.get('/api/reservations', async (req, res) => {
      try {
        const reservations = await Reservation.find({});
        res.json(reservations);
      } catch (e) {
        console.error('예약 조회 실패:', e);
        res.status(500).json({ message: '서버 오류' });
      }
    });

    // 예약 생성 또는 변경 API
    app.post('/api/reservations', limiter, async (req, res) => {
      if (req.body.honeypot_field) return res.status(400).json({ message: '비정상적 요청' });

      const { roomNo, name, dormitory, floor, seat, password } = req.body;
      if (!roomNo || !name || !dormitory || !floor || seat == null || !password)
        return res.status(400).json({ message: '모든 정보를 입력하세요.' });

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

    // 예약 변경 API (PUT)
    app.put('/api/reservations/update/:id', limiter, async (req, res) => {
      if (req.body.honeypot_field) return res.status(400).json({ message: '비정상적 요청' });

      const { id } = req.params;
      const { roomNo, name, dormitory, floor, seat, password } = req.body;
      if (!roomNo || !name || !dormitory || !floor || seat == null || !password)
        return res.status(400).json({ message: '모든 정보를 입력하세요.' });

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

        const updatedReservation = await Reservation.findByIdAndUpdate(id, { roomNo, name, dormitory, floor, seat }, { new: true, runValidators: true });
        console.log(`[예약 변경 성공] ${updatedReservation.name} (${updatedReservation.roomNo}) 좌석 변경됨.`);

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

    // 예약 삭제 API
    app.delete('/api/reservations/:id', async (req, res) => {
      try {
        const { id } = req.params;
        const { password } = req.body;
        if (!password)
          return res.status(400).json({ message: '비밀번호를 입력해주세요.' });

        const existingReservation = await Reservation.findById(id);
        if (!existingReservation)
          return res.status(404).json({ message: '예약을 찾을 수 없습니다.' });

        const isPasswordCorrect = await bcrypt.compare(password, existingReservation.password);
        if (!isPasswordCorrect)
          return res.status(401).json({ success: false, message: '예약 비밀번호가 일치하지 않습니다.' });

        await Reservation.findByIdAndDelete(id);
        console.log(`[예약 취소 성공] ${existingReservation.name} (${existingReservation.roomNo}) 예약 취소.`);

        const allReservations = await Reservation.find({});
        io.emit('reservationsUpdated', allReservations);

        res.json({ success: true, message: '예약 취소 완료' });
      } catch (e) {
        console.error('예약 취소 중 오류:', e);
        res.status(500).json({ message: '서버 오류' });
      }
    });

    // 기타 관리자 설정, 공지사항 API (위와 같은 패턴으로 완성)

    // 관리자 예약 비밀번호 열람 API
    app.post('/api/admin/reservations/:id/view-plain-password', async (req, res) => {
      const { id } = req.params;
      const { adminPassword } = req.body;
      if (!adminPassword) return res.status(400).json({ success: false, message: '관리자 비밀번호를 입력해주세요.' });
      if (adminPassword !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: '관리자 비밀번호가 틀렸습니다.' });
      try {
        const reservation = await Reservation.findById(id).select('plainPassword name roomNo');
        if (!reservation) return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });
        console.log(`관리자가 ${reservation.name} (${reservation.roomNo}) 비밀번호를 열람했습니다.`);
        res.json({ success: true, plainPassword: reservation.plainPassword });
      } catch (e) {
        console.error('비밀번호 열람 실패:', e);
        res.status(500).json({ success: false, message: '서버 오류' });
      }
    });

    // Socket.IO 처리
    io.on('connection', async socket => {
      console.log(`클라이언트 연결: ${socket.id}`);
      try {
        const allReservations = await Reservation.find({});
        socket.emit('reservationsInitial', allReservations);
        const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
        socket.emit('adminSettingsInitial', adminSettings);
        const announcement = await Announcement.findOne({ key: 'currentAnnouncement' });
        socket.emit('announcementInitial', announcement);
      } catch (e) {
        console.error('초기 데이터 전송 실패:', e);
      }
      socket.on('disconnect', () => { console.log(`클라이언트 연결 종료: ${socket.id}`); });
    });

    server.listen(PORT, () => {
      console.log(`서버 실행 중: http://localhost:${PORT}`);
    });
