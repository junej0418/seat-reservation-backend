const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt'); // bcrypt 라이브러리 추가
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.FRONTEND_URL, // .env 파일에서 불러온 프론트엔드 주소 (로컬 개발용)
  'http://localhost:5500',   // VS Code Live Server의 일반적인 localhost 주소
  'http://127.0.0.1:5500',   // VS Code Live Server의 일반적인 127.0.0.1 주소
  'http://localhost:3000',   // 백엔드 자체도 origin으로 요청할 수 있음
  'http://127.00.1:3000',   // 백엔드 자체도 origin으로 요청할 수 있음
  null,                      // HTML 파일을 로컬 시스템(file://)에서 직접 열 때

  // ⭐ 여러분의 Netlify 프론트엔드 주소를 여기에 정확히 넣어주세요! ⭐
  'https://heartfelt-cannoli-903df2.netlify.app',
];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if(!origin) return callback(null, true);
      if (!allowedOrigins.includes(origin)) return callback(new Error("CORS 차단된 도메인"), false);
      return callback(null, true);
    },
    methods: ['GET','POST','PUT','DELETE'],
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; // .env에서 관리자 비밀번호 불러옴

// CORS 미들웨어 설정
app.use(cors({
  origin: (origin, callback) => {
    if(!origin) return callback(null,true);
    if(!allowedOrigins.includes(origin)) return callback(new Error("CORS 차단된 도메인"), false);
    callback(null,true);
  },
  credentials: true
}));

app.use(express.json());

// API 요청 속도 제한 미들웨어
const limiter = rateLimit({
  windowMs: 60000,
  max: 20,
  message: '너무 많은 요청입니다. 잠시 후 시도해주세요.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.path === '/api/reservations/all'
});

// MongoDB 연결
mongoose.connect(MONGO_URI)
  .then(()=>console.log('MongoDB 연결 성공'))
  .catch(err=>console.error('MongoDB 연결 실패:',err));

// Reservation 스키마 정의 (비밀번호, 평문 비밀번호 필드 추가)
const reservationSchema = new mongoose.Schema({
  roomNo: {type:String, required:true},
  name: {type:String, required:true},
  dormitory: {type:String, required:true},
  floor: {type:String, required:true},
  seat: {type:Number, required:true},
  password: {type:String, required:true}, // 해싱된 비밀번호
  plainPassword: {type:String, required:true}, // ✨ 보안 위험: 관리자 열람용 평문 비밀번호 ✨
  createdAt: {type:Date, default:Date.now}
});
// 유니크 인덱스 설정
reservationSchema.index({roomNo:1, name:1}, {unique:true}); // 룸번호+이름 조합은 유일
reservationSchema.index({dormitory:1, floor:1, seat:1},{unique:true}); // 좌석은 유일

// 비밀번호 해싱 미들웨어 (저장 전에 실행)
reservationSchema.pre('save', async function(next) {
    if (this.isModified('password') && this.password.length < 50) { // 이미 해싱된 비밀번호가 짧으면 다시 해싱하지 않음
        this.password = await bcrypt.hash(this.password, 10); // 10은 saltRounds, 높을수록 안전
    }
    next();
});

const Reservation = mongoose.model('Reservation', reservationSchema);

// AdminSetting 스키마 정의
const adminSettingSchema = new mongoose.Schema({
  key: {type:String, unique:true, required:true},
  reservationStartTime: {type:Date, default:null},
  reservationEndTime: {type:Date, default:null}
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

// Announcement 스키마 정의
const announcementSchema = new mongoose.Schema({
  key: {type:String, unique:true, default:'currentAnnouncement'},
  message: {type:String, default:''},
  active: {type:Boolean, default:false},
  updatedAt: {type:Date, default:Date.now}
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// ---- API 라우트 정의 시작 ----

// 관리자 로그인 API
app.post('/api/admin-login', (req,res)=>{
  const {password} = req.body;
  if(!password) return res.status(400).json({success:false, message:'비밀번호를 입력해주세요.'});
  if(!ADMIN_PASSWORD) {
    console.error(`관리자 비밀번호(.env ADMIN_PASSWORD)가 설정되지 않았습니다.`);
    return res.status(500).json({success:false, message:'서버 관리자 비밀번호가 설정되지 않았습니다.'});
  }
  if(password === ADMIN_PASSWORD){
    console.log(`관리자 로그인 성공 - IP: ${req.ip} - 시간: ${new Date().toISOString()}`);
    return res.json({success:true, message:'관리자 로그인 성공'});
  } else {
    console.log(`관리자 로그인 실패 - IP: ${req.ip} - 시간: ${new Date().toISOString()}`);
    return res.status(401).json({success:false, message:'비밀번호가 틀렸습니다.'});
  }
});

// 예약 조회
app.get('/api/reservations', async (req,res)=>{
  try {
    const reservations = await Reservation.find({});
    res.json(reservations);
  } catch(e){
    console.error("예약 조회 실패:", e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 생성/수정 (자리 변경 포함)
app.post('/api/reservations', limiter, async (req,res)=>{
  if(req.body.honeypot_field) return res.status(400).json({message:'비정상적 요청'});

  const {roomNo, name, dormitory, floor, seat, password} = req.body; // ✨ password 추가 ✨
  if(!roomNo || !name || !dormitory || !floor || seat==null || !password) // ✨ password 필수화 ✨
    return res.status(400).json({message:'모든 정보를 입력하세요.'});

  const adminSettings = await AdminSetting.findOne({key:'reservationTimes'});
  if(!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime)
    return res.status(403).json({message:'예약 가능 시간이 설정되지 않았습니다.'});
  
  const now = new Date();
  if(now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime)
    return res.status(403).json({message:'현재 예약 가능 시간이 아닙니다.'});

  try{
    const conflictSeat = await Reservation.findOne({dormitory, floor, seat});
    const existingUser = await Reservation.findOne({roomNo, name});

    if(conflictSeat && (!existingUser || existingUser._id.toString() !== conflictSeat._id.toString()))
      return res.status(409).json({message:'선택한 좌석은 이미 예약되었습니다.'});

    let reservation;
    if(existingUser){ // 기존 예약이 있는 경우: 비밀번호 검증 후 업데이트
      const isPasswordCorrect = await bcrypt.compare(password, existingUser.password);
      if (!isPasswordCorrect) {
          console.log(`예약 변경/등록 실패 (비밀번호 불일치): ${name} (${roomNo})`);
          return res.status(401).json({ success: false, message: '예약 비밀번호가 일치하지 않습니다.' });
      }
      // 기존 예약 업데이트 시에는 password는 변경하지 않음 (재해싱하지 않음)
      reservation = await Reservation.findByIdAndUpdate(existingUser._id, {dormitory, floor, seat}, {new:true});
      console.log(`[예약 변경 성공] ${reservation.name} (${reservation.roomNo})님이 ${reservation.dormitory} ${reservation.floor}층 ${reservation.seat}번 좌석으로 변경했습니다. (_id: ${reservation._id})`);
    } else { // 신규 예약 생성
      // 새 예약 생성 시, password와 plainPassword 모두 저장
      reservation = new Reservation({roomNo, name, dormitory, floor, seat, password, plainPassword: password}); // ✨ password, plainPassword 전달 ✨
      await reservation.save();
      console.log(`[예약 생성 성공] ${reservation.name} (${reservation.roomNo})님이 ${reservation.dormitory} ${reservation.floor}층 ${reservation.seat}번 좌석을 예약했습니다. (_id: ${reservation._id})`);
    }

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({success:true, message:'예약 성공', newReservation: reservation});
  } catch(e){
    console.error("예약 처리 중 오류:", e);
    if(e.code === 11000){ // MongoDB duplicate key error
      return res.status(409).json({message:'중복된 예약 정보가 있습니다.'});
    }
    res.status(500).json({message:'서버 오류', error: e.message});
  }
});

// 예약 변경 (PUT) 라우트
app.put('/api/reservations/update/:id', limiter, async (req, res) => {
  if (req.body.honeypot_field) return res.status(400).json({ message: '비정상적 요청' });

  const { id } = req.params; // 업데이트할 예약의 _id
  const { roomNo, name, dormitory, floor, seat, password } = req.body; // ✨ password 추가 ✨

  if (!roomNo || !name || !dormitory || !floor || seat == null || !password) { // ✨ password 필수화 ✨
    return res.status(400).json({ message: '모든 정보를 입력하세요.' });
  }

  // 관리자 설정 확인 (예약 시간 제한)
  const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
  if (!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime) {
    return res.status(403).json({ message: '예약 가능 시간이 설정되지 않았습니다.' });
  }
  const now = new Date();
  if (now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime) {
    return res.status(403).json({ message: '현재 예약 가능 시간이 아닙니다.' });
  }

  try {
    // 1. 업데이트할 기존 예약 문서를 찾습니다.
    const existingReservation = await Reservation.findById(id);
    if (!existingReservation) {
      console.log(`예약 변경 실패: _id ${id} 예약을 찾을 수 없음`);
      return res.status(404).json({ message: '해당 예약을 찾을 수 없습니다.' });
    }

    // ✨ 비밀번호 검증 ✨
    const isPasswordCorrect = await bcrypt.compare(password, existingReservation.password);
    if (!isPasswordCorrect) {
        console.log(`예약 변경 실패 (비밀번호 불일치): _id ${id} - ${name} (${roomNo})`);
        return res.status(401).json({ success: false, message: '예약 비밀번호가 일치하지 않습니다.' });
    }

    // 2. 변경하려는 새 좌석이 다른 사람에게 이미 예약되어 있는지 확인합니다.
    const isNewSeatBookedByOthers = await Reservation.findOne({
      dormitory, floor, seat,
      _id: { $ne: id } // 현재 업데이트하려는 예약의 _id와 다른 문서를 찾음
    });
    if (isNewSeatBookedByOthers) {
      console.log(`예약 변경 실패 (좌석 중복): _id ${id} -> ${dormitory} ${floor}층 ${seat}번`);
      return res.status(409).json({ message: '선택하신 좌석은 이미 다른 사람에게 예약되었습니다.' });
    }
    
    // 4. 예약 정보 업데이트를 수행합니다. (password, plainPassword는 변경하지 않음)
    const updatedReservation = await Reservation.findByIdAndUpdate(
      id,
      { roomNo, name, dormitory, floor, seat },
      { new: true, runValidators: true }
    );
    console.log(`[예약 변경 성공] ${updatedReservation.name} (${updatedReservation.roomNo})님이 ${updatedReservation.dormitory} ${updatedReservation.floor}층 ${updatedReservation.seat}번 좌석으로 변경했습니다. (_id: ${updatedReservation._id})`);


    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations); // 모든 클라이언트에게 업데이트된 예약 정보를 전송

    res.json({ success:true, message: '예약이 성공적으로 변경되었습니다.', updatedReservation });
  } catch (e) {
    console.error("예약 변경 처리 중 오류:", e);
    if (e.code === 11000) { // MongoDB duplicate key error
      return res.status(409).json({ message: '중복된 예약 정보가 발생했습니다. (예: 이미 해당 룸번호/이름 또는 좌석이 사용 중)' });
    }
    res.status(500).json({ message: '서버 오류', error: e.message });
  }
});


// 전체 예약 삭제 (관리자용)
app.delete('/api/reservations/all', async (req,res)=>{
  try{
    const deletedCount = await Reservation.deleteMany({});
    console.log(`[모든 예약 취소 성공] 총 ${deletedCount.deletedCount}개의 예약이 취소되었습니다.`);
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({success:true, message:'모든 예약 취소 완료'});
  } catch(e){
    console.error("모든 예약 취소 중 오류:", e);
    res.status(500).json({message:'서버 오류', error: e.message});
  }
});

// 개별 예약 삭제
app.delete('/api/reservations/:id', async (req,res)=>{
  try{
    const { id } = req.params;
    const { password } = req.body; // ✨ 비밀번호 추가 ✨

    if (!password) {
        return res.status(400).json({ message: '비밀번호를 입력해주세요.' });
    }

    const existingReservation = await Reservation.findById(id);
    if(!existingReservation) {
      console.log(`예약 취소 실패: _id ${id} 예약을 찾을 수 없음`);
      return res.status(404).json({message:'예약을 찾을 수 없습니다.'});
    }

    // ✨ 비밀번호 검증 ✨
    const isPasswordCorrect = await bcrypt.compare(password, existingReservation.password);
    if (!isPasswordCorrect) {
        console.log(`예약 취소 실패 (비밀번호 불일치): _id ${id} - ${existingReservation.name} (${existingReservation.roomNo})`);
        return res.status(401).json({ success: false, message: '예약 비밀번호가 일치하지 않습니다.' });
    }

    await Reservation.findByIdAndDelete(id);
    console.log(`[예약 취소 성공] _id: ${id} 의 예약을 취소했습니다. (예약자: ${existingReservation.name} (${existingReservation.roomNo}), 좌석: ${existingReservation.dormitory} ${existingReservation.floor}층 ${existingReservation.seat}번)`);
    
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({success:true, message:'예약 취소 완료'});
  } catch(e){
    console.error("예약 취소 중 오류:", e);
    res.status(500).json({message:'서버 오류', error: e.message});
  }
});

// 관리자 예약시간 조회
app.get('/api/admin-settings', async (req,res)=>{
  try{
    let settings = await AdminSetting.findOne({key:'reservationTimes'});
    if(!settings){
      settings = new AdminSetting({key:'reservationTimes'});
      await settings.save();
      console.log('초기 관리자 예약 시간 설정 생성 완료');
    }
    res.json(settings);
  } catch(e){
    console.error("관리자 설정 불러오기 실패:", e);
    res.status(500).json({message:'서버 오류', error: e.message});
  }
});

// 관리자 예약시간 설정 (PUT)
app.put('/api/admin-settings', async (req, res) => {
    const { reservationStartTime, reservationEndTime } = req.body;
    try {
        const settings = await AdminSetting.findOneAndUpdate(
            { key: 'reservationTimes' },
            { reservationStartTime, reservationEndTime },
            { new: true, upsert: true } // 없으면 새로 생성, 있으면 업데이트
        );
        console.log(`[관리자 설정 업데이트 성공] 예약 시간: ${settings.reservationStartTime} ~ ${settings.reservationEndTime}`);
        io.emit('settingsUpdated', settings); // 모든 클라이언트에게 설정 업데이트 알림
        res.json({ success: true, message: '예약 가능 시간이 성공적으로 설정되었습니다.', settings });
    } catch (e) {
        console.error('관리자 설정 업데이트 실패:', e);
        res.status(500).json({ success: false, message: '설정 저장 중 오류가 발생했습니다.', error: e.message });
    }
});

// 공지사항 조회
app.get('/api/announcement', async (req, res) => {
    try {
        let announcement = await Announcement.findOne({ key: 'currentAnnouncement' });
        if (!announcement) {
            announcement = new Announcement({ key: 'currentAnnouncement' });
            await announcement.save();
            console.log('초기 공지사항 생성 완료');
        }
        res.json(announcement);
    } catch (e) {
        console.error('공지사항 조회 실패:', e);
        res.status(500).json({ success: false, message: '공지사항 불러오기 실패', error: e.message });
    }
});

// 공지사항 설정 (PUT)
app.put('/api/announcement', async (req, res) => {
    const { message, active } = req.body;
    try {
        const announcement = await Announcement.findOneAndUpdate(
            { key: 'currentAnnouncement' },
            { message, active, updatedAt: new Date() },
            { new: true, upsert: true }
        );
        console.log(`[공지사항 업데이트 성공] 활성화: ${announcement.active}, 내용: ${announcement.message.substring(0, 30)}...`);
        io.emit('announcementUpdated', announcement); // 모든 클라이언트에게 공지사항 업데이트 알림
        res.json({ success: true, message: '공지사항이 성공적으로 저장되었습니다.', announcement });
    } catch (e) {
        console.error('공지사항 업데이트 실패:', e);
        res.status(500).json({ success: false, message: '공지사항 저장 중 오류 발생', error: e.message });
    }
});

// ✨ 관리자용: 사용자 평문 비밀번호 열람 API (보안 위험) ✨
app.post('/api/admin/reservations/:id/view-plain-password', async (req, res) => {
  const { id } = req.params;
  const { adminPassword } = req.body;

  if (!adminPassword) {
      return res.status(400).json({ success: false, message: '관리자 비밀번호를 입력해주세요.' });
  }
  if (!ADMIN_PASSWORD) {
      console.error(`.env에 ADMIN_PASSWORD가 설정되지 않았습니다.`);
      return res.status(500).json({ success: false, message: '서버 관리자 비밀번호가 설정되지 않았습니다.' });
  }

  if (adminPassword === ADMIN_PASSWORD) {
      try {
          const reservation = await Reservation.findById(id).select('plainPassword name roomNo'); // plainPassword만 조회
          if (!reservation) {
              return res.status(404).json({ success: false, message: '예약을 찾을 수 없습니다.' });
          }
          console.log(`[관리자 비밀번호 열람] 관리자가 ${reservation.name} (${reservation.roomNo})님의 비밀번호를 열람했습니다. (_id: ${id})`);
          return res.json({ success: true, plainPassword: reservation.plainPassword });
      } catch (e) {
          console.error(`_id: ${id} 예약의 비밀번호 열람 실패:`, e);
          return res.status(500).json({ success: false, message: '비밀번호를 가져오는 중 오류가 발생했습니다.' });
      }
  } else {
      console.log(`관리자 비밀번호 열람 시도 실패 (비밀번호 불일치) - IP: ${req.ip}`);
      return res.status(401).json({ success: false, message: '관리자 비밀번호가 일치하지 않습니다.' });
  }
});


// Socket.IO 연결 처리
io.on('connection', async socket => {
  console.log(`클라이언트 접속: ${socket.id}`);
  // 클라이언트 연결 시 현재 예약 정보, 관리자 설정, 공지사항을 즉시 전송
  try {
      const allReservations = await Reservation.find({});
      socket.emit('reservationsInitial', allReservations); // 새로 연결된 클라이언트에게 초기 예약 정보 전송

      const adminSettings = await AdminSetting.findOne({key: 'reservationTimes'});
      socket.emit('adminSettingsInitial', adminSettings); // 초기 관리자 설정 전송

      const announcement = await Announcement.findOne({key: 'currentAnnouncement'});
      socket.emit('announcementInitial', announcement); // 초기 공지사항 전송
  } catch (e) {
      console.error("클라이언트 초기 데이터 전송 실패:", e);
  }

  socket.on('disconnect', () => {
    console.log(`클라이언트 연결 종료: ${socket.id}`);
  });
});

// 서버 시작
server.listen(PORT, () => {
  console.log(`서버 시작: http://localhost:${PORT}`);
});