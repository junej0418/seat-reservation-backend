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
  // ⭐ 수정 1: 관리자 관련 API는 rate limit에서 제외하여 작업 흐름에 방해되지 않도록 합니다. ⭐
  skip: req => req.path === '/api/reservations/all' || req.path.startsWith('/api/admin-settings') || req.path.startsWith('/api/announcement')
});
// ⭐ 추가 2: rate limiter 미들웨어를 모든 요청에 적용합니다. 이 부분이 빠져있어 제한이 작동하지 않았습니다. ⭐
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
  // ⭐ 추가 3: 예약한 기기를 식별할 수 있는 고유 ID 필드 추가 ⭐
  deviceIdentifier: {type: String, required: false} // 필수 아님: 기존 예약과의 호환성 위해
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

// ⭐ 수정 4: 관리자 권한 확인 미들웨어를 Authorization 헤더를 사용하도록 변경합니다. ⭐
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization; // 'Authorization: Bearer <password>' 형식으로 가정
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: '인증 헤더가 필요합니다.' });
  }

  const adminPasswordFromHeader = authHeader.split(' ')[1]; // 'Bearer ' 부분을 제거하고 실제 비밀번호 추출
  
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({success:false, message:'서버 관리자 비밀번호가 설정되지 않았습니다.'});
  }
  if (adminPasswordFromHeader !== ADMIN_PASSWORD) {
    return res.status(403).json({ success: false, message: '관리자 권한이 없습니다. 비밀번호가 일치하지 않습니다.' });
  }
  next(); // 비밀번호가 일치하면 다음 미들웨어 또는 라우트 핸들러로 넘어갑니다.
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
app.post('/api/reservations', async (req,res)=>{ // Rate Limiter는 app.use(limiter)로 모든 라우트에 적용되었습니다.
  if(req.body.honeypot_field) return res.status(400).json({message:'비정상적 요청'});

  // ⭐ 수정 5: deviceIdentifier를 요청 본문에서 받아와 사용합니다. ⭐
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
      // ⭐ 추가 6: 이미 예약된 좌석이 있을 때 로그를 남깁니다. ⭐
      console.log(`[예약 실패] 이미 예약된 좌석 (기존: ${conflictSeat.roomNo} ${conflictSeat.name} / 요청: ${roomNo} ${name}) - ${dormitory} ${floor}층 ${seat}번`);
      return res.status(409).json({message:'선택한 좌석은 이미 예약되었습니다.'});
    }

    let reservation;
    if(existingUser){
      // 기존 예약 업데이트 시 deviceIdentifier는 그대로 유지하거나, 새로 보낸 deviceIdentifier로 갱신할 수 있습니다.
      // 여기서는 업데이트 시에도 `deviceIdentifier`를 함께 갱신하도록 합니다.
      reservation = await Reservation.findByIdAndUpdate(existingUser._id, {dormitory, floor, seat, createdAt: new Date(), deviceIdentifier}, {new:true});
      // ⭐ 추가 7: 예약 변경 성공 시 로그를 남깁니다. ⭐
      console.log(`[예약 변경 성공] ${roomNo} ${name} -> ${dormitory} ${floor}층 ${seat}번 (기기: ${deviceIdentifier || '없음'})`);
    } else {
      // ⭐ 수정 8: 새로운 예약 생성 시 deviceIdentifier를 저장합니다. ⭐
      reservation = new Reservation({roomNo, name, dormitory, floor, seat, deviceIdentifier});
      await reservation.save();
      // ⭐ 추가 9: 신규 예약 성공 시 로그를 남깁니다. ⭐
      console.log(`[신규 예약 성공] ${roomNo} ${name} -> ${dormitory} ${floor}층 ${seat}번 (기기: ${deviceIdentifier || '없음'})`);
    }

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({message:'예약 성공', newReservation: reservation});
  } catch(e){
    console.error("예약 처리 중 오류:", e);
    if(e.code === 11000){ // MongoDB duplicate key error
      console.error(`[예약 실패] 중복된 정보 - 요청: ${roomNo} ${name}, ${dormitory} ${floor}층 ${seat}번`);
      return res.status(409).json({message:'중복된 예약이 있습니다.'});
    }
    res.status(500).json({message:'서버 오류'});
  }
});

// ⭐⭐⭐ 예약 변경 (PUT) 라우트 ⭐⭐⭐
app.put('/api/reservations/update/:id', async (req, res) => { // Rate Limiter는 app.use(limiter)로 모든 라우트에 적용되었습니다.
  if (req.body.honeypot_field) return res.status(400).json({ message: '비정상적 요청' });

  const { id } = req.params; // 업데이트할 예약의 _id
  // ⭐ 수정 10: 요청 본문에 사용자 식별 정보와 deviceIdentifier를 추가합니다. ⭐
  const { roomNo, name, dormitory, floor, seat, requestingUserRoomNo, requestingUserName, requestingUserDormitory, deviceIdentifier } = req.body; 

  if (!roomNo || !name || !dormitory || !floor || seat==null) {
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
      console.log(`[예약 변경 실패] ${roomNo} ${name} - ID ${id} 에 해당하는 예약을 찾을 수 없음.`);
      return res.status(404).json({ message: '해당 예약을 찾을 수 없습니다.' });
    }

    // ⭐ 추가 11: 예약 변경 요청자 검증 (본인의 예약만 변경 가능) ⭐
    if (existingReservation.roomNo !== requestingUserRoomNo ||
        existingReservation.name !== requestingUserName ||
        existingReservation.dormitory !== requestingUserDormitory) {
        console.log(`[예약 변경 실패] ${requestingUserRoomNo} ${requestingUserName} - 다른 사용자의 예약 변경 시도: ${existingReservation.roomNo} ${existingReservation.name} ${existingReservation.floor}층 ${existingReservation.seat}번`);
        return res.status(403).json({ message: '본인의 예약만 변경할 수 있습니다.' });
    }
    
    // ⭐ 추가 12: 예약 변경 시, 예약 시점의 기기 식별자와 현재 요청의 기기 식별자가 일치하는지 확인 (null이 아닐 경우) ⭐
    // 기존에 deviceIdentifier가 없는 예약은 검사를 스킵합니다 (기존 예약 호환성 유지)
    if (existingReservation.deviceIdentifier && existingReservation.deviceIdentifier !== deviceIdentifier) {
        console.log(`[예약 변경 실패] ${roomNo} ${name} - 기기 불일치 (기존: ${existingReservation.deviceIdentifier}, 요청: ${deviceIdentifier})`);
        return res.status(403).json({ message: '예약 시 사용한 기기에서만 변경할 수 있습니다.' });
    }


    // 2. 변경하려는 새 좌석이 다른 사람에게 이미 예약되어 있는지 확인합니다.
    //    단, 자기 자신의 기존 좌석은 중복 검사 대상에서 제외해야 합니다.
    const isNewSeatBookedByOthers = await Reservation.findOne({
      dormitory, floor, seat,
      _id: { $ne: id } // 현재 업데이트하려는 예약의 _id와 다른 문서를 찾음
    });
    if (isNewSeatBookedByOthers) {
      console.log(`[예약 변경 실패] ${roomNo} ${name} - 새 좌석(${dormitory} ${floor}층 ${seat}번)이 다른 사람에게(${isNewSeatBookedByOthers.roomNo} ${isNewSeatBookedByOthers.name}) 이미 예약됨`);
      return res.status(409).json({ message: '선택하신 좌석은 이미 다른 사람에게 예약되었습니다.' });
    }
    
    // 4. 예약 정보 업데이트를 수행합니다.
    // ⭐ 수정 13: 업데이트 시에도 deviceIdentifier를 갱신하도록 합니다. (사용자 기기 변경에 대응) ⭐
    const updatedReservation = await Reservation.findByIdAndUpdate(
      id,
      { roomNo, name, dormitory, floor, seat, createdAt: new Date(), deviceIdentifier }, // 클라이언트에서 보내온 모든 정보로 업데이트
      { new: true, runValidators: true } // 업데이트 후의 새 문서를 반환, 스키마 유효성 검사 실행
    );
    // ⭐ 추가 14: 예약 변경 성공 시 로그를 남깁니다. ⭐
    console.log(`[예약 변경 성공] ${roomNo} ${name} - ${existingReservation.floor}층 ${existingReservation.seat}번 -> ${dormitory} ${floor}층 ${seat}번 (기기: ${deviceIdentifier || '없음'})`);


    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations); // 모든 클라이언트에게 업데이트된 예약 정보를 전송

    res.json({ message: '예약이 성공적으로 변경되었습니다.', updatedReservation });
  } catch (e) {
    console.error("예약 변경 처리 중 오류:", e);
    if (e.code === 11000) { // MongoDB duplicate key error (예: 룸번호+이름 중복이 새로 생겼거나, 좌석 중복이 생겼을 때)
      console.error(`[예약 변경 실패] ${roomNo} ${name} - 중복된 정보 발생`);
      return res.status(409).json({ message: '중복된 예약 정보가 발생했습니다. (예: 이미 해당 룸번호/이름 또는 좌석이 사용 중)' });
    }
    res.status(500).json({ message: '서버 오류', error: e.message });
  }
});
// ⭐⭐⭐ 예약 변경 (PUT) 라우트 끝 ⭐⭐⭐


// ⭐ 수정 15: 모든 예약 삭제 API에 관리자 인증 미들웨어 적용 및 요청 본문에서 관리자 비밀번호 확인 ⭐
app.delete('/api/reservations/all', async (req,res)=>{
  const { adminPassword } = req.body; // 요청 본문에서 관리자 비밀번호를 직접 받음
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

// ⭐ 수정 16: 개별 예약 삭제 API - 요청자 검증 및 deviceIdentifier 확인 로직 추가 ⭐
app.delete('/api/reservations/:id', async (req,res)=>{
  const { id } = req.params;
  // ⭐ 추가: 요청 본문에서 사용자 식별 정보, 관리자 여부, 관리자 비밀번호, 그리고 deviceIdentifier를 받음 ⭐
  const { requestingUserRoomNo, requestingUserName, requestingUserDormitory, isAdmin, adminPassword, deviceIdentifier } = req.body; 

  try{
    const reservationToCancel = await Reservation.findById(id);

    if(!reservationToCancel) {
        console.log(`[예약 취소 실패] ID ${id} 에 해당하는 예약을 찾을 수 없음.`);
        return res.status(404).json({message:'취소할 예약을 찾을 수 없습니다.'});
    }

    // ⭐ 예약 소유자 또는 관리자만 취소 가능 ⭐
    if (isAdmin) { // 프론트엔드에서 관리자 요청으로 온 경우
      // 관리자 비밀번호가 일치하는지 백엔드에서 다시 확인
      if (!ADMIN_PASSWORD || adminPassword !== ADMIN_PASSWORD) {
        console.log(`[예약 취소 실패] 관리자 비밀번호 불일치 - 요청자: ${req.ip}, 시도 ID: ${id}`);
        return res.status(403).json({ success: false, message: '관리자 비밀번호가 일치하지 않아 취소할 수 없습니다.' });
      }
      console.log(`[예약 취소 성공 (관리자)] ${reservationToCancel.roomNo} ${reservationToCancel.name} 의 ${reservationToCancel.floor}층 ${reservationToCancel.seat}번 예약 취소 (관리자: ${req.ip})`);
    } else { // 일반 사용자 요청인 경우
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
      // ⭐ 추가 17: 예약 시 사용한 기기 식별자와 현재 요청의 기기 식별자가 일치하는지 확인 (null이 아닐 경우) ⭐
      if (reservationToCancel.deviceIdentifier && reservationToCancel.deviceIdentifier !== deviceIdentifier) {
        console.log(`[예약 취소 실패] ${requestingUserRoomNo} ${requestingUserName} - 기기 불일치 (기존: ${reservationToCancel.deviceIdentifier || '없음'}, 요청: ${deviceIdentifier || '없음'})`);
        return res.status(403).json({ message: '예약 시 사용한 기기에서만 취소할 수 있습니다.' });
      }
      console.log(`[예약 취소 성공 (사용자)] ${requestingUserRoomNo} ${requestingUserName} 가 ${reservationToCancel.floor}층 ${reservationToCancel.seat}번 예약 취소 (기기: ${deviceIdentifier || '없음'})`);
    }

    const del = await Reservation.findByIdAndDelete(id);
    if(!del) return res.status(404).json({message:'예약 없음'}); // 이미 삭제되었거나 다시 찾지 못한 경우 (경쟁 상태 등)

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({message:'예약 취소 완료'});
  } catch(e){
    console.error("예약 취소 중 오류:", e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자 예약시간 조회/설정
// ⭐ 수정 18: 관리자 설정 API에 authenticateAdmin 미들웨어 적용 ⭐
app.get('/api/admin-settings', authenticateAdmin, async (req,res)=>{
  try{
    let settings = await AdminSetting.findOne({key:'reservationTimes'});
    if(!settings){
      settings = new AdminSetting({key:'reservationTimes'});
      await settings.save();
    }
    res.json(settings);
  } catch(e){
    console.error("관리자 설정 불러오기 실패:", e);
    res.status(500).json({message:'서버 오류'});
  }
});

app.put('/api/admin-settings', authenticateAdmin, async (req,res)=>{
  try{
    const {reservationStartTime, reservationEndTime} = req.body;
    const settings = await AdminSetting.findOneAndUpdate({key:'reservationTimes'}, {reservationStartTime, reservationEndTime}, {new:true, upsert:true});
    io.emit('settingsUpdated', settings);
    console.log(`[관리자 설정 저장 성공] 예약 가능 시간: ${reservationStartTime} ~ ${reservationEndTime} (관리자: ${req.ip})`);
    res.json(settings);
  } catch(e){
    console.error("관리자 예약 시간 저장 실패:", e);
    res.status(500).json({message:'서버 오류'});
  }
});

// ⭐ 수정 19: 공지사항 API에 authenticateAdmin 미들웨어 적용 ⭐
app.get('/api/announcement', authenticateAdmin, async (req,res)=>{
  try{
    let announcement = await Announcement.findOne({key:'currentAnnouncement'});
    if(!announcement){
      announcement = new Announcement({key:'currentAnnouncement', message:"", active:false});
      await announcement.save();
    }
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
    io.emit('announcementUpdated', updated);
    console.log(`[공지사항 저장 성공] 메시지: "${message}", 활성화: ${active} (관리자: ${req.ip})`);
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