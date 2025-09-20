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
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  null,
  'https://heartfelt-cannoli-903df2.netlify.app',
];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if(!origin) return callback(null, true);
      if(!allowedOrigins.includes(origin)) return callback(new Error("CORS 차단된 도메인"), false);
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
  .catch(err=>console.error('MongoDB 연결 실패:', err));

// 예약 스키마 및 모델
const reservationSchema = new mongoose.Schema({
  roomNo: {type:String, required:true},
  name: {type:String, required:true},
  dormitory: {type:String, required:true},
  floor: {type:String, required:true},
  seat: {type:Number, required:true},
  createdAt: {type:Date, default:Date.now},
  deviceIdentifier: {type:String, required:false}
});
reservationSchema.index({roomNo:1, name:1}, {unique:true});
reservationSchema.index({dormitory:1, floor:1, seat:1},{unique:true});
const Reservation = mongoose.model('Reservation', reservationSchema);

// 관리자 설정 스키마 및 모델
const adminSettingSchema = new mongoose.Schema({
  key: {type:String, unique:true, required:true},
  reservationStartTime: {type:Date, default:null},
  reservationEndTime: {type:Date, default:null}
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

// 공지사항 스키마 및 모델
const announcementSchema = new mongoose.Schema({
  key: {type:String, unique:true, default:'currentAnnouncement'},
  message: {type:String, default:''},
  active: {type:Boolean, default:false},
  updatedAt: {type:Date, default:Date.now}
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// 관리자 인증 미들웨어: Authorization 헤더 기반
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if(!authHeader || !authHeader.startsWith('Bearer ')){
    return res.status(401).json({success:false, message:'인증 헤더가 필요합니다.'});
  }
  const adminPassword = authHeader.split(' ')[1];
  if(!ADMIN_PASSWORD){
    return res.status(500).json({success:false, message:'서버 관리자 비밀번호가 설정되지 않았습니다.'});
  }
  if(adminPassword !== ADMIN_PASSWORD){
    return res.status(403).json({success:false,message:'관리자 권한이 없습니다. 비밀번호가 일치하지 않습니다.'});
  }
  next();
};

// 관리자 예약 가능 시간 조회
app.get('/api/admin-settings', authenticateAdmin, async (req,res) => {
  try{
    let settings = await AdminSetting.findOne({key:'reservationTimes'});
    if(!settings){
      settings = new AdminSetting({key:'reservationTimes'});
      await settings.save();
    }
    res.json(settings);
  }catch(e){
    console.error('관리자 설정 불러오기 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자 예약 가능 시간 저장
app.put('/api/admin-settings', authenticateAdmin, async (req,res) => {
  try{
    const {reservationStartTime, reservationEndTime} = req.body;
    const settings = await AdminSetting.findOneAndUpdate(
      {key:'reservationTimes'},
      {reservationStartTime, reservationEndTime},
      {new:true, upsert:true, runValidators:true}
    );
    io.emit('settingsUpdated', settings);
    res.json(settings);
  }catch(e){
    console.error('관리자 예약 시간 저장 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 조회
app.get('/api/reservations', async (req,res) => {
  try{
    const reservations = await Reservation.find({});
    res.json(reservations);
  }catch(e){
    console.error('예약 조회 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 생성/변경
app.post('/api/reservations', async (req,res) => {
  if(req.body.honeypot_field) return res.status(400).json({message:'비정상적 요청'});

  const {roomNo, name, dormitory, floor, seat, deviceIdentifier} = req.body;
  if(!roomNo || !name || !dormitory || !floor || seat == null)
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

    if(conflictSeat && (!existingUser || existingUser._id.toString()!==conflictSeat._id.toString()))
      return res.status(409).json({message:'선택한 좌석은 이미 예약되었습니다.'});

    let reservation;
    if(existingUser){
      reservation = await Reservation.findByIdAndUpdate(existingUser._id, {dormitory, floor, seat, createdAt: new Date(), deviceIdentifier}, {new:true});
    }else{
      reservation = new Reservation({roomNo, name, dormitory, floor, seat, deviceIdentifier});
      await reservation.save();
    }

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({message:'예약 성공', newReservation: reservation});
  }catch(e){
    console.error('예약 처리 중 오류:', e);
    if(e.code === 11000){
      return res.status(409).json({message:'중복된 예약이 있습니다.'});
    }
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 변경 API
app.put('/api/reservations/update/:id', async (req,res) => {
  if(req.body.honeypot_field) return res.status(400).json({message:'비정상적 요청'});

  const { id } = req.params;
  const {roomNo, name, dormitory, floor, seat, requestingUserRoomNo, requestingUserName, requestingUserDormitory, deviceIdentifier} = req.body;

  if(!roomNo || !name || !dormitory || !floor || seat == null)
    return res.status(400).json({message:'모든 정보를 입력하세요.'});

  const adminSettings = await AdminSetting.findOne({key:'reservationTimes'});
  if(!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime)
    return res.status(403).json({message:'예약 가능 시간이 설정되지 않았습니다.'});

  const now = new Date();
  if(now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime)
    return res.status(403).json({message:'현재 예약 가능 시간이 아닙니다.'});

  try {
    const existingReservation = await Reservation.findById(id);
    if(!existingReservation)
      return res.status(404).json({message:'해당 예약을 찾을 수 없습니다.'});

    if(existingReservation.roomNo !== requestingUserRoomNo ||
      existingReservation.name !== requestingUserName ||
      existingReservation.dormitory !== requestingUserDormitory)
      return res.status(403).json({message:'본인의 예약만 변경할 수 있습니다.'});

    if(existingReservation.deviceIdentifier && existingReservation.deviceIdentifier !== deviceIdentifier)
      return res.status(403).json({message:'예약 시 사용한 기기에서만 변경할 수 있습니다.'});

    const seatConflict = await Reservation.findOne({
      dormitory, floor, seat, _id: { $ne: id }
    });
    if(seatConflict)
      return res.status(409).json({message:'선택하신 좌석은 이미 예약되었습니다.'});

    const updatedReservation = await Reservation.findByIdAndUpdate(
      id,
      {roomNo, name, dormitory, floor, seat, createdAt: new Date(), deviceIdentifier},
      {new:true, runValidators:true}
    );

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({message:'예약 변경 성공', updatedReservation});
  } catch(e){
    console.error('예약 변경 처리 중 오류:', e);
    if(e.code === 11000)
      return res.status(409).json({message:'중복된 예약 정보입니다.'});
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 취소 API
app.delete('/api/reservations/:id', async (req,res) => {
  const { id } = req.params;
  const { requestingUserRoomNo, requestingUserName, requestingUserDormitory, isAdmin, adminPassword, deviceIdentifier } = req.body;

  try {
    const reservationToCancel = await Reservation.findById(id);
    if(!reservationToCancel) return res.status(404).json({message:'취소할 예약을 찾을 수 없습니다.'});

    if(isAdmin){
      if(!ADMIN_PASSWORD || adminPassword !== ADMIN_PASSWORD)
        return res.status(403).json({message:'관리자 권한 없음 또는 비밀번호 불일치'});
    } else {
      if(!requestingUserRoomNo || !requestingUserName || !requestingUserDormitory)
        return res.status(400).json({message:'사용자 정보 부족'});
      if(reservationToCancel.roomNo !== requestingUserRoomNo ||
        reservationToCancel.name !== requestingUserName ||
        reservationToCancel.dormitory !== requestingUserDormitory)
        return res.status(403).json({message:'본인 예약만 취소 가능'});
      if(reservationToCancel.deviceIdentifier &&
         reservationToCancel.deviceIdentifier !== deviceIdentifier)
        return res.status(403).json({message:'예약 시 사용한 기기에서만 취소 가능'});
    }

    await Reservation.findByIdAndDelete(id);
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);

    res.json({message:'예약 취소 완료'});
  } catch (e){
    console.error('예약 취소 중 오류:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 공지사항 조회, 저장, 관리자 로그인, 기타 필요한 API 등 추가 구현 가능

io.on('connection', socket => {
  console.log(`클라이언트 접속: ${socket.id}`);
  socket.on('disconnect', () => console.log(`클라이언트 연결 종료: ${socket.id}`));
});

server.listen(PORT, () => {
  console.log(`서버 시작: http://localhost:${PORT}`);
});