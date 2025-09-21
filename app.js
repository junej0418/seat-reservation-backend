const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  process.env.FRONTEND_URL || '', 'http://localhost:5500', 'http://127.0.0.1:5500',
  'http://localhost:3000', 'http://127.0.0.1:3000', null, 'https://heartfelt-cannoli-903df2.netlify.app',
];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if(!origin) return callback(null,true);
      if(!allowedOrigins.includes(origin)) return callback(new Error('CORS 차단됨'), false);
      callback(null,true);
    },
    methods: ['GET','POST','PUT','DELETE'],
    credentials: true,
  }
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

app.use(cors({
  origin: (origin, callback) => {
    if(!origin) return callback(null,true);
    if(!allowedOrigins.includes(origin)) return callback(new Error('CORS 차단됨'), false);
    callback(null,true);
  },
  credentials: true,
}));

app.use(express.json());

mongoose.connect(MONGO_URI)
  .then(() => console.log('MongoDB 연결 성공'))
  .catch(err => console.error('MongoDB 연결 실패:', err));

// 예약 스키마
const reservationSchema = new mongoose.Schema({
  roomNo: {type:String, required:true},
  name: {type:String, required:true},
  dormitory: {type:String, required:true},
  floor: {type:String, required:true},
  seat: {type:Number, required:true},
  createdAt: {type:Date, default:Date.now},
  password: {type:String, required:true}
});
reservationSchema.index({roomNo:1,name:1},{unique:true});
reservationSchema.index({dormitory:1,floor:1,seat:1},{unique:true});
const Reservation = mongoose.model('Reservation', reservationSchema);

const adminSettingSchema = new mongoose.Schema({
  key: {type:String, unique:true, required:true},
  reservationStartTime: {type:Date, default:null},
  reservationEndTime: {type:Date, default:null},
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

const announcementSchema = new mongoose.Schema({
  key: {type:String, unique:true, default:'currentAnnouncement'},
  message: {type:String, default:''},
  active: {type:Boolean, default:false},
  updatedAt: {type:Date, default:Date.now}
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// 관리자 권한 인증 미들웨어
const authenticateAdmin = (req,res,next) => {
  const authHeader = req.headers.authorization;
  if(!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({success:false, message:'인증 필요'});
  const token = authHeader.split(' ')[1];
  if(token !== ADMIN_PASSWORD) return res.status(403).json({success:false, message:'권한 없음'});
  next();
};

// 관리자 로그인
app.post('/api/admin-login', (req,res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({success:false, message:'비밀번호 필요'});
  if(password === ADMIN_PASSWORD) res.json({success:true, message:'로그인 성공'});
  else res.status(401).json({success:false, message:'비밀번호 틀림'});
});

// 관리자 예약 가능 시간 조회
app.get('/api/admin-settings', authenticateAdmin, async (req,res) => {
  try {
    let setting = await AdminSetting.findOne({key:'reservationTimes'});
    if(!setting){
      setting = new AdminSetting({key:'reservationTimes'});
      await setting.save();
    }
    res.json(setting);
  } catch(e){
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자 예약 가능 시간 저장
app.put('/api/admin-settings', authenticateAdmin, async (req,res) => {
  try{
    const { reservationStartTime, reservationEndTime } = req.body;
    const setting = await AdminSetting.findOneAndUpdate({key:'reservationTimes'}, {reservationStartTime, reservationEndTime},{new:true, upsert:true});
    io.emit('settingsUpdated', setting);
    res.json(setting);
  } catch(e){
    res.status(500).json({message:'서버 오류'});
  }
});

// 공지사항 조회
app.get('/api/announcement', authenticateAdmin, async (req,res) => {
  try{
    let announcement = await Announcement.findOne({key:'currentAnnouncement'});
    if(!announcement){
      announcement = new Announcement({key:'currentAnnouncement',message:'',active:false});
      await announcement.save();
    }
    res.json(announcement);
  } catch(e) {
    res.status(500).json({message:'서버 오류'});
  }
});

// 공지사항 저장
app.put('/api/announcement', authenticateAdmin, async (req,res) => {
  try{
    const {message, active} = req.body;
    const updated = await Announcement.findOneAndUpdate({key:'currentAnnouncement'}, {message,active,updatedAt:new Date()}, {new:true, upsert:true});
    io.emit('announcementUpdated', updated);
    res.json(updated);
  } catch(e){
    res.status(500).json({message:'서버 오류'});
  }
});

// 전체 예약 조회
app.get('/api/reservations', async (req,res) => {
  try {
    const reservations = await Reservation.find({});
    res.json(reservations);
  } catch(e) {
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 생성/변경 API
app.post('/api/reservations', async (req,res) => {
  const { roomNo, name, dormitory, floor, seat, password } = req.body;
  if(!roomNo||!name||!dormitory||!floor||seat==null||!password) 
    return res.status(400).json({ message: "모든 정보 필요"});
  try {
    const setting = await AdminSetting.findOne({key:'reservationTimes'});
    if(!setting || !setting.reservationStartTime || !setting.reservationEndTime)
      return res.status(403).json({message:'예약 가능 시간 미설정'});
    const now=new Date();
    if(now<setting.reservationStartTime || now>setting.reservationEndTime)
      return res.status(403).json({message:'예약 시간 아님'});
    const existUser = await Reservation.findOne({roomNo,name});
    const seatConflict = await Reservation.findOne({dormitory, floor, seat});
    if(seatConflict && (!existUser || existUser._id.toString()!==seatConflict._id.toString()))
      return res.status(409).json({message:'좌석 예약중복'});
    if(existUser){
      const updated = await Reservation.findByIdAndUpdate(existUser._id,{dormitory,floor,seat,password,createdAt:new Date()},{new:true});
      io.emit('reservationsUpdated', await Reservation.find({}));
      return res.json({message:'예약 변경 성공', reservation:updated});
    }
    else {
      const newRt = new Reservation({roomNo,name,dormitory,floor,seat,password});
      await newRt.save();
      io.emit('reservationsUpdated', await Reservation.find({}));
      return res.json({message:'예약 성공', reservation:newRt});
    }
  } catch(e){
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 취소 API
app.delete('/api/reservations/:id', async (req,res) => {
  const {id} = req.params;
  const {password,isAdmin,adminPassword} = req.body;
  try {
    const r = await Reservation.findById(id);
    if(!r) return res.status(404).json({message:'예약없음'});
    if(isAdmin){
      if(adminPassword !== ADMIN_PASSWORD) return res.status(403).json({message:'관리자 비밀번호 오류'});
    } else {
      if(password !== r.password) return res.status(403).json({message:'비밀번호 오류'});
    }
    await Reservation.findByIdAndDelete(id);
    io.emit('reservationsUpdated', await Reservation.find({}));
    res.json({message:'취소완료'});
  } catch(e){
    res.status(500).json({message:'서버 오류'});
  }
});

io.on('connection', socket=>{
  console.log('클라이언트 접속:', socket.id);
  socket.on('disconnect', () => console.log('클라이언트 연결 종료:', socket.id));
})

server.listen(PORT, () => console.log(`서버 시작 http://localhost:${PORT}`));