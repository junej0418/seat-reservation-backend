// app.js
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
  process.env.FRONTEND_URL, // .env 파일에서 불러온 프론트엔드 주소 (로컬 개발용)
  'http://localhost:5500',   // VS Code Live Server의 일반적인 localhost 주소
  'http://127.0.0.1:5500',   // VS Code Live Server의 일반적인 127.0.0.1 주소
  'http://localhost:3000',   // 백엔드 자체도 origin으로 요청할 수 있음
  'http://127.0.0.1:3000',   // 백엔드 자체도 origin으로 요청할 수 있음
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.use(cors({
  origin: (origin, callback) => {
    if(!origin) return callback(null,true);
    if(!allowedOrigins.includes(origin)) return callback(new Error("CORS 차단된 도메인"), false);
    callback(null,true);
  },
  credentials: true
}));

app.use(express.json());

const limiter = rateLimit({
  windowMs: 60000,
  max: 20,
  message: '너무 많은 요청입니다. 잠시 후 시도해주세요.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.path === '/api/reservations/all' || req.path.startsWith('/api/admin-settings') || req.path.startsWith('/api/announcement')
});
app.use(limiter); 

mongoose.connect(MONGO_URI)
  .then(()=>console.log('MongoDB 연결 성공'))
  .catch(err=>console.error('MongoDB 연결 실패:',err));

const reservationSchema = new mongoose.Schema({
  roomNo: {type:String, required:true},
  name: {type:String, required:true},
  dormitory: {type:String, required:true},
  floor: {type:String, required:true},
  seat: {type:Number, required:true},
  createdAt: {type:Date, default:Date.now},
  deviceIdentifier: {type: String, required: false} 
});
reservationSchema.index({roomNo:1, name:1}, {unique:true});
reservationSchema.index({dormitory:1, floor:1, seat:1},{unique:true});
const Reservation = mongoose.model('Reservation', reservationSchema);

const adminSettingSchema = new mongoose.Schema({
  key: {type:String, unique:true, required:true},
  reservationStartTime: {type:Date, default:null},
  reservationEndTime: {type:Date, default:null}
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

const announcementSchema = new mongoose.Schema({
  key: {type:String, unique:true, default:'currentAnnouncement'},
  message: {type:String, default:''},
  active: {type:Boolean, default:false},
  updatedAt: {type:Date, default:Date.now}
});
const Announcement = mongoose.model('Announcement', announcementSchema);

const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log(`[인증 실패] 헤더 없음 또는 형식 오류: ${authHeader}`); // ⭐ 추가 로깅 ⭐
    return res.status(401).json({ success: false, message: '인증 헤더가 필요합니다.' });
  }

  const adminPasswordFromHeader = authHeader.split(' ')[1]; 
  
  if (!ADMIN_PASSWORD) {
    console.log('[인증 실패] ADMIN_PASSWORD 환경 변수 미설정'); // ⭐ 추가 로깅 ⭐
    return res.status(500).json({success:false, message:'서버 관리자 비밀번호가 설정되지 않았습니다.'});
  }
  if (adminPasswordFromHeader !== ADMIN_PASSWORD) {
    console.log(`[인증 실패] 비밀번호 불일치 (입력: ${adminPasswordFromHeader}, 정답: ${ADMIN_PASSWORD})`); // ⭐ 추가 로깅 ⭐
    return res.status(403).json({ success: false, message: '관리자 권한이 없습니다. 비밀번호가 일치하지 않습니다.' });
  }
  next();
};


// 관리자 로그인 API
app.post('/api/admin-login', (req,res)=>{
  const {password} = req.body;
  if(!password) return res.status(400).json({success:false, message:'비밀번호를 입력해주세요.'});
  if(!ADMIN_PASSWORD) return res.status(500).json({success:false, message:'서버 관리자 비밀번호가 설정되지 않았습니다.'});
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
app.post('/api/reservations', async (req,res)=>{
  if(req.body.honeypot_field) return res.status(400).json({message:'비정상적 요청'});

  const {roomNo, name, dormitory, floor, seat, deviceIdentifier} = req.body;
  if(!roomNo || !name || !dormitory || !floor || seat==null)
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

    if(conflictSeat && (!existingUser || existingUser._id.toString() !== conflictSeat._id.toString())) {
      console.log(`[예약 실패] 이미 예약된 좌석 (기존: ${conflictSeat.roomNo} ${conflictSeat.name} / 요청: ${roomNo} ${name}) - ${dormitory} ${floor}층 ${seat}번`);
      return res.status(409).json({message:'선택한 좌석은 이미 예약되었습니다.'});
    }

    let reservation;
    if(existingUser){
      reservation = await Reservation.findByIdAndUpdate(existingUser._id, {dormitory, floor, seat, createdAt: new Date(), deviceIdentifier}, {new:true});
      console.log(`[예약 변경 성공] ${roomNo} ${name} -> ${dormitory} ${floor}층 ${seat}번 (기기: ${deviceIdentifier || '없음'})`);
    } else {
      reservation = new Reservation({roomNo, name, dormitory, floor, seat, deviceIdentifier});
      await reservation.save();
      console.log(`[신규 예약 성공] ${roomNo} ${name} -> ${dormitory} ${floor}층 ${seat}번 (기기: ${deviceIdentifier || '없음'})`);
    }

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({message:'예약 성공', newReservation: reservation});
  } catch(e){
    console.error("예약 처리 중 오류:", e);
    if(e.code === 11000){
      console.error(`[예약 실패] 중복된 정보 - 요청: ${roomNo} ${name}, ${dormitory} ${floor}층 ${seat}번`);
      return res.status(409).json({message:'중복된 예약이 있습니다.'});
    }
    res.status(500).json({message:'서버 오류'});
  }
});

// ⭐⭐⭐ 예약 변경 (PUT) 라우트 ⭐⭐⭐
app.put('/api/reservations/update/:id', async (req, res) => {
  if (req.body.honeypot_field) return res.status(400).json({ message: '비정상적 요청' });

  const { id } = req.params;
  const { roomNo, name, dormitory, floor, seat, requestingUserRoomNo, requestingUserName, requestingUserDormitory, deviceIdentifier } = req.body; 

  if (!roomNo || !name || !dormitory || !floor || seat==null) {
    return res.status(400).json({ message: '모든 정보를 입력하세요.' });
  }

  const adminSettings = await AdminSetting.findOne({ key: 'reservationTimes' });
  if (!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime) {
    return res.status(403).json({ message: '예약 가능 시간이 설정되지 않았습니다.' });
  }
  const now = new Date();
  if (now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime) {
    return res.status(403).json({ message: '현재 예약 가능 시간이 아닙니다.' });
  }

  try {
    const existingReservation = await Reservation.findById(id);
    if (!existingReservation) {
      console.log(`[예약 변경 실패] ${roomNo} ${name} - ID ${id} 에 해당하는 예약을 찾을 수 없음.`);
      return res.status(404).json({ message: '해당 예약을 찾을 수 없습니다.' });
    }

    if (existingReservation.roomNo !== requestingUserRoomNo ||
        existingReservation.name !== requestingUserName ||
        existingReservation.dormitory !== requestingUserDormitory) {
        console.log(`[예약 변경 실패] ${requestingUserRoomNo} ${requestingUserName} - 다른 사용자의 예약 변경 시도: ${existingReservation.roomNo} ${existingReservation.name} ${existingReservation.floor}층 ${existingReservation.seat}번`);
        return res.status(403).json({ message: '본인의 예약만 변경할 수 있습니다.' });
    }
    
    if (existingReservation.deviceIdentifier && existingReservation.deviceIdentifier !== deviceIdentifier) {
        console.log(`[예약 변경 실패] ${roomNo} ${name} - 기기 불일치 (기존: ${existingReservation.deviceIdentifier}, 요청: ${deviceIdentifier})`);
        return res.status(403).json({ message: '예약 시 사용한 기기에서만 변경할 수 있습니다.' });
    }

    const isNewSeatBookedByOthers = await Reservation.findOne({
      dormitory, floor, seat,
      _id: { $ne: id }
    });
    if (isNewSeatBookedByOthers) {
      console.log(`[예약 변경 실패] ${roomNo} ${name} - 새 좌석(${dormitory} ${floor}층 ${seat}번)이 다른 사람에게(${isNewSeatBookedByOthers.roomNo} ${isNewSeatBookedByOthers.name}) 이미 예약됨`);
      return res.status(409).json({ message: '선택하신 좌석은 이미 다른 사람에게 예약되었습니다.' });
    }
    
    const updatedReservation = await Reservation.findByIdAndUpdate(
      id,
      { roomNo, name, dormitory, floor, seat, createdAt: new Date(), deviceIdentifier },
      { new: true, runValidators: true }
    );
    console.log(`[예약 변경 성공] ${roomNo} ${name} - ${existingReservation.floor}층 ${existingReservation.seat}번 -> ${dormitory} ${floor}층 ${seat}번 (기기: ${deviceIdentifier || '없음'})`);

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({ message: '예약이 성공적으로 변경되었습니다.', updatedReservation });
  } catch (e) {
    console.error("예약 변경 처리 중 오류:", e);
    if (e.code === 11000) {
      console.error(`[예약 변경 실패] ${roomNo} ${name} - 중복된 정보 발생`);
      return res.status(409).json({ message: '중복된 예약 정보가 발생했습니다. (예: 이미 해당 룸번호/이름 또는 좌석이 사용 중)' });
    }
    res.status(500).json({ message: '서버 오류', error: e.message });
  }
});
// ⭐⭐⭐ 예약 변경 (PUT) 라우트 끝 ⭐⭐⭐


app.delete('/api/reservations/all', async (req,res)=>{
  const { adminPassword } = req.body;
  if (!ADMIN_PASSWORD || adminPassword !== ADMIN_PASSWORD) {
    console.log(`[모든 예약 삭제 실패] 관리자 비밀번호 불일치 - IP: ${req.ip}`);
    return res.status(403).json({ success: false, message: '관리자 권한이 없습니다.' });
  }
  try{
    await Reservation.deleteMany({});
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    console.log(`[모든 예약 삭제 성공] 관리자 ${req.ip} 가 모든 예약을 삭제했습니다.`);
    res.json({message:'모든 예약 취소 완료'});
  } catch(e){
    console.error("모든 예약 취소 중 오류:", e);
    res.status(500).json({message:'서버 오류'});
  }
});

app.delete('/api/reservations/:id', async (req,res)=>{
  const { id } = req.params;
  const { requestingUserRoomNo, requestingUserName, requestingUserDormitory, isAdmin, adminPassword, deviceIdentifier } = req.body; 

  try{
    const reservationToCancel = await Reservation.findById(id);

    if(!reservationToCancel) {
        console.log(`[예약 취소 실패] ID ${id} 에 해당하는 예약을 찾을 수 없음.`);
        return res.status(404).json({message:'취소할 예약을 찾을 수 없습니다.'});
    }

    if (isAdmin) {
      if (!ADMIN_PASSWORD || adminPassword !== ADMIN_PASSWORD) {
        console.log(`[예약 취소 실패] 관리자 비밀번호 불일치 - 요청자: ${req.ip}, 시도 ID: ${id}`);
        return res.status(403).json({ success: false, message: '관리자 비밀번호가 일치하지 않아 취소할 수 없습니다.' });
      }
      console.log(`[예약 취소 성공 (관리자)] ${reservationToCancel.roomNo} ${reservationToCancel.name} 의 ${reservationToCancel.floor}층 ${reservationToCancel.seat}번 예약 취소 (관리자: ${req.ip})`);
    } else {
      if (!requestingUserRoomNo || !requestingUserName || !requestingUserDormitory) {
          console.log(`[예약 취소 실패] ${req.ip} - 사용자 정보 부족. ID: ${id}`);
          return res.status(400).json({ message: '예약 취소를 위한 사용자 정보가 부족합니다.' });
      }
      if (reservationToCancel.roomNo !== requestingUserRoomNo ||
          reservationToCancel.name !== requestingUserName ||
          reservationToCancel.dormitory !== requestingUserDormitory) {
          console.log(`[예약 취소 실패] ${requestingUserRoomNo} ${requestingUserName} - 다른 사용자의 예약 취소 시도: ${reservationToCancel.roomNo} ${reservationToCancel.name} ${reservationToCancel.floor}층 ${reservationToCancel.seat}번`);
          return res.status(403).json({ message: '본인의 예약만 취소할 수 있습니다.' });
      }
      if (reservationToCancel.deviceIdentifier && reservationToCancel.deviceIdentifier !== deviceIdentifier) {
        console.log(`[예약 취소 실패] ${requestingUserRoomNo} ${requestingUserName} - 기기 불일치 (기존: ${reservationToCancel.deviceIdentifier || '없음'}, 요청: ${deviceIdentifier || '없음'})`);
        return res.status(403).json({ message: '예약 시 사용한 기기에서만 취소할 수 있습니다.' });
      }
      console.log(`[예약 취소 성공 (사용자)] ${requestingUserRoomNo} ${requestingUserName} 가 ${reservationToCancel.floor}층 ${reservationToCancel.seat}번 예약 취소 (기기: ${deviceIdentifier || '없음'})`);
    }

    const del = await Reservation.findByIdAndDelete(id);
    if(!del) return res.status(404).json({message:'예약 없음'});

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({message:'예약 취소 완료'});
  } catch(e){
    console.error("예약 취소 중 오류:", e);
    res.status(500).json({message:'서버 오류'});
  }
});

app.get('/api/admin-settings', authenticateAdmin, async (req,res)=>{
  try{
    let settings = await AdminSetting.findOne({key:'reservationTimes'});
    if(!settings){
      settings = new AdminSetting({key:'reservationTimes'});
      await settings.save();
      console.log('[관리자 설정] 기본 설정 생성됨.'); // ⭐ 추가 로깅 ⭐
    }
    console.log(`[관리자 설정 조회 성공] - 조회 시각: ${new Date().toISOString()}`); // ⭐ 추가 로깅 ⭐
    res.json(settings);
  } catch(e){
    console.error("관리자 설정 불러오기 실패:", e);
    res.status(500).json({message:'서버 오류'});
  }
});

app.put('/api/admin-settings', authenticateAdmin, async (req,res)=>{
  try{
    const {reservationStartTime, reservationEndTime} = req.body;
    // ⭐ 수정 1: findOneAndUpdate의 쿼리 필터(`{key:'reservationTimes'}`)를 AdminSetting 스키마의 key 값과 일치하게 명시합니다. ⭐
    // `key` 필드가 'reservationTimes'로 고정되어 있다고 가정.
    const settings = await AdminSetting.findOneAndUpdate({key:'reservationTimes'}, {reservationStartTime, reservationEndTime}, {new:true, upsert:true, runValidators:true});
    
    // ⭐ 추가 로깅: 저장 후 실제 저장된 데이터 확인 ⭐
    if(settings) {
        console.log(`[관리자 설정 저장 성공] DB 저장된 설정: Start=${settings.reservationStartTime}, End=${settings.reservationEndTime} (관리자: ${req.ip})`);
    } else {
        console.error(`[관리자 설정 저장 오류] findOneAndUpdate가 null을 반환했습니다.`);
    }

    io.emit('settingsUpdated', settings);
    res.json(settings);
  } catch(e){
    console.error("관리자 예약 시간 저장 실패:", e); // ⭐ 에러 상세 정보 로그 추가 ⭐
    res.status(500).json({message:'서버 오류'});
  }
});

app.get('/api/announcement', authenticateAdmin, async (req,res)=>{
  try{
    let announcement = await Announcement.findOne({key:'currentAnnouncement'});
    if(!announcement){
      announcement = new Announcement({key:'currentAnnouncement', message:"", active:false});
      await announcement.save();
      console.log('[공지사항] 기본 설정 생성됨.'); // ⭐ 추가 로깅 ⭐
    }
    console.log(`[공지사항 조회 성공] - 조회 시각: ${new Date().toISOString()}`); // ⭐ 추가 로깅 ⭐
    res.json(announcement);
  } catch(e){
    console.error("공지사항 불러오기 실패:", e);
    res.status(500).json({message:'서버 오류'});
  }
});

app.put('/api/announcement', authenticateAdmin, async (req,res)=>{
  try{
    const {message, active} = req.body;
    const updated = await Announcement.findOneAndUpdate({key:'currentAnnouncement'}, {message, active, updatedAt:new Date()}, {new:true, upsert:true});
    console.log(`[공지사항 저장 성공] 메시지: "${message}", 활성화: ${active} (관리자: ${req.ip})`); // ⭐ 추가 로깅 ⭐
    io.emit('announcementUpdated', updated);
    res.json(updated);
  } catch(e){
    console.error("공지사항 저장 실패:", e);
    res.status(500).json({message:'서버 오류'});
  }
});


io.on('connection', socket => {
  console.log(`클라이언트 접속: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`클라이언트 연결 종료: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`서버 시작: http://localhost:${PORT}`);
});