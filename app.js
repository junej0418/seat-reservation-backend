// app.js - Node.js + Express + MongoDB + Socket.IO 완전 코드

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

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  null,
  'https://heartfelt-cannoli-903df2.netlify.app'
];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null,true);
      if (!allowedOrigins.includes(origin)) return callback(new Error('CORS blocked'), false);
      return callback(null,true);
    },
    methods: ['GET','POST','PUT','DELETE'],
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_USERNAMES = process.env.ADMIN_USERNAMES ? process.env.ADMIN_USERNAMES.split(',') : [];

// 미들웨어 설정
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null,true);
    if (!allowedOrigins.includes(origin)) return callback(new Error('CORS blocked'), false);
    return callback(null,true);
  },
  credentials: true
}));
app.use(express.json());
app.set('trust proxy', 1); 

// Rate limiter
const limiter = rateLimit({
  windowMs: 60000, 
  max: 30, 
  message: 'Too many requests, please try again later.',
  standardHeaders: true, 
  legacyHeaders: false, 
  skip: req => req.path === '/api/reservations/all'
});
app.use('/api/reservations', limiter);

// MongoDB 연결
mongoose.connect(MONGO_URI, {
  useNewUrlParser:true,
  useUnifiedTopology:true,
  serverSelectionTimeoutMS:15000
}).then(()=>console.log('MongoDB connected'))
  .catch(err=>console.error('MongoDB connection failed:', err));

// 1. 예약 스키마
const reservationSchema = new mongoose.Schema({
  roomNo: {type:String, required:true},
  name: {type:String, required:true},
  dormitory: {type:String, required:true},
  floor: {type:String, required:true},
  seat: {type:Number, required:true},
  password: {type:String, required:true}, 
  plainPassword: {type:String, required:true}, 
  createdAt: {type:Date, default:Date.now}
});
reservationSchema.index({roomNo:1, name:1}, {unique:true}); 
reservationSchema.index({dormitory:1, floor:1, seat:1}, {unique:true}); 

reservationSchema.pre('save', async function(next){
  if(this.isModified('password') && this.password.length < 50){
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});
const Reservation = mongoose.model('Reservation', reservationSchema);

// 2. 관리자 설정 스키마
const adminSettingSchema = new mongoose.Schema({
  key:{type:String, unique:true, required:true}, 
  reservationStartTime: {type:Date, default:null}, 
  reservationEndTime: {type:Date, default:null}   
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

// 3. 공지사항 스키마
const announcementSchema = new mongoose.Schema({
  key:{type:String, unique:true, default:'currentAnnouncement'}, 
  message:{type:String, default:''}, 
  active:{type:Boolean, default:false}, 
  updatedAt:{type:Date, default:Date.now}
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// 4. 관리자 전용 공지 스키마
const adminOnlyAnnouncementSchema = new mongoose.Schema({
  key:{type:String, unique:true, default:'adminOnlyAnnouncement'}, 
  message:{type:String, default:''}, 
  active:{type:Boolean, default:false}, 
  updatedAt:{type:Date, default:Date.now}
});
const AdminOnlyAnnouncement = mongoose.model('AdminOnlyAnnouncement', adminOnlyAnnouncementSchema);

// 5. [NEW] 개인정보 수집 이용 동의 스키마
const privacyConsentSchema = new mongoose.Schema({
  name: {type: String, required: true},
  roomNo: {type: String, required: true},
  dormitory: {type: String, required: true},
  agreedAt: {type: Date, default: Date.now},
  ipAddress: String
});
// 이름+룸번호+기숙사가 같으면 중복 저장 방지
privacyConsentSchema.index({ name: 1, roomNo: 1, dormitory: 1 }, { unique: true });
const PrivacyConsent = mongoose.model('PrivacyConsent', privacyConsentSchema);


// --- API Routes ---

// [NEW] 개인정보 동의 여부 확인
app.post('/api/privacy-check', async (req, res) => {
  try {
    const { name, roomNo, dormitory } = req.body;
    if (!name || !roomNo || !dormitory) return res.json({ consented: false });

    const exist = await PrivacyConsent.exists({ name, roomNo, dormitory });
    res.json({ consented: !!exist });
  } catch (e) {
    console.error('Privacy check error:', e);
    res.status(500).json({ consented: false }); 
  }
});

// [NEW] 개인정보 동의 저장
app.post('/api/privacy-agree', async (req, res) => {
  try {
    const { name, roomNo, dormitory } = req.body;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!name || !roomNo || !dormitory) return res.status(400).json({ success: false });

    // 중복 확인 후 없으면 생성
    const exists = await PrivacyConsent.findOne({ name, roomNo, dormitory });
    if (!exists) {
      await PrivacyConsent.create({ name, roomNo, dormitory, ipAddress });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('Privacy agree error:', e);
    res.status(500).json({ success: false });
  }
});

// 기존 API들
app.get('/api/reservations', async (req, res) => {
  try {
    const reservations = await Reservation.find({});
    res.json(reservations);
  } catch (e) {
    res.status(500).json({message:'서버 오류'});
  }
});

app.post('/api/reservations', async (req, res) => {
  const {roomNo, name, dormitory, floor, seat, password} = req.body;
  
  // 유효성 검사 등 기존 로직 유지
  if(!roomNo || !name || !dormitory || !floor || seat === undefined || !password) 
    return res.status(400).json({message:'모든 정보가 필요합니다.'});

  // 예약 시간 체크
  const adminSetting = await AdminSetting.findOne({key:'reservationTimes'});
  if(!adminSetting || !adminSetting.reservationStartTime || !adminSetting.reservationEndTime) 
    return res.status(403).json({message:'예약 가능 시간이 설정되지 않았습니다.'});
  
  const now = new Date();
  if(now < adminSetting.reservationStartTime || now > adminSetting.reservationEndTime) 
    return res.status(403).json({message:'현재 예약 가능 시간이 아닙니다.'});

  try {
    const conflict = await Reservation.findOne({dormitory, floor, seat});
    const existing = await Reservation.findOne({roomNo, name});

    if(conflict && (!existing || existing._id.toString() !== conflict._id.toString())) 
      return res.status(409).json({message:'선택하신 좌석은 이미 예약되어 있습니다.'});
    
    if(existing){
      // 기존 예약 변경
      const match = await bcrypt.compare(password, existing.password);
      if(!match) return res.status(401).json({message:'비밀번호가 일치하지 않습니다.'});
      
      existing.dormitory = dormitory;
      existing.floor = floor;
      existing.seat = seat;
      // 비밀번호가 바뀌진 않음
      await existing.save();
      
      const allReservations = await Reservation.find({});
      io.emit('reservationsUpdated', allReservations);
      return res.json({success:true, message:'예약이 변경되었습니다.'});
    }

    // 신규 예약
    const newReservation = new Reservation({
      roomNo, name, dormitory, floor, seat, password, plainPassword: password 
    });
    await newReservation.save();

    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({success:true, message:'예약이 완료되었습니다.'});

  } catch(e) {
    console.error(e);
    res.status(500).json({message:'예약 처리 중 오류 발생'});
  }
});

// 예약 취소 (사용자)
app.delete('/api/reservations', async (req, res) => {
  const {roomNo, name, password} = req.body;
  try {
    const target = await Reservation.findOne({roomNo, name});
    if(!target) return res.status(404).json({message:'예약을 찾을 수 없습니다.'});
    
    const match = await bcrypt.compare(password, target.password);
    if(!match) return res.status(401).json({message:'비밀번호가 일치하지 않습니다.'});

    await Reservation.findByIdAndDelete(target._id);
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({success:true, message:'예약이 취소되었습니다.'});
  } catch(e) {
    res.status(500).json({message:'오류 발생'});
  }
});

// 관리자 설정 조회
app.get('/api/admin-settings', async (req, res) => {
  try {
    const settings = await AdminSetting.findOne({key:'reservationTimes'});
    res.json(settings || {});
  } catch(e) {
    res.status(500).json({message:'오류'});
  }
});

// 관리자 설정 저장
app.put('/api/admin-settings', async (req, res) => {
  const {reservationStartTime, reservationEndTime, adminPassword} = req.body;
  if(adminPassword !== ADMIN_PASSWORD) return res.status(403).json({message:'관리자 권한이 없습니다.'});
  
  try {
    await AdminSetting.findOneAndUpdate(
      {key:'reservationTimes'},
      {reservationStartTime, reservationEndTime},
      {upsert:true}
    );
    const settings = await AdminSetting.findOne({key:'reservationTimes'});
    io.emit('adminSettingsUpdated', settings);
    res.json({success:true});
  } catch(e) {
    res.status(500).json({message:'오류'});
  }
});

// 공지사항 API들
app.get('/api/announcement', async (req, res) => {
  const data = await Announcement.findOne({key:'currentAnnouncement'});
  res.json(data || {});
});
app.post('/api/announcement', async (req, res) => {
  const {message, active} = req.body;
  const updated = await Announcement.findOneAndUpdate(
    {key:'currentAnnouncement'}, {message, active, updatedAt:Date.now()}, {upsert:true, new:true}
  );
  io.emit('announcementUpdated', updated);
  res.json({success:true});
});

app.get('/api/admin-announcement', async (req, res) => {
  const data = await AdminOnlyAnnouncement.findOne({key:'adminOnlyAnnouncement'});
  res.json(data || {});
});
app.post('/api/admin-announcement', async (req, res) => {
  const {message, active} = req.body;
  const updated = await AdminOnlyAnnouncement.findOneAndUpdate(
    {key:'adminOnlyAnnouncement'}, {message, active, updatedAt:Date.now()}, {upsert:true, new:true}
  );
  io.emit('adminAnnouncementUpdated', updated);
  res.json({success:true});
});

// 관리자 로그인 확인
app.post('/api/admin/login', (req, res) => {
  const {adminUsername, adminPassword} = req.body;
  if(adminPassword === ADMIN_PASSWORD && ADMIN_USERNAMES.includes(adminUsername)) {
    res.json({success:true});
  } else {
    res.status(401).json({success:false});
  }
});

// 관리자 비밀번호 열람
app.post('/api/admin/reservations/:id/view-plain-password', async (req, res) => {
  const { adminUsername, adminPassword } = req.body;
  if (adminPassword !== ADMIN_PASSWORD || !ADMIN_USERNAMES.includes(adminUsername)) {
    return res.status(403).json({ message: '권한이 없습니다.' });
  }
  try {
    const reservation = await Reservation.findById(req.params.id);
    if (!reservation) return res.status(404).json({ message: '예약 없음' });
    // 로그 남기기
    console.log(`관리자(${adminUsername})가 ${reservation.name}의 비밀번호 열람`);
    res.json({ plainPassword: reservation.plainPassword });
  } catch (e) {
    res.status(500).json({ message: '서버 오류' });
  }
});

// 관리자 예약 삭제
app.delete('/api/admin/reservations/:id', async (req, res) => {
    const { adminUsername } = req.body; // 바디나 쿼리로 받을 수 있음, 여기선 단순화
    // 실제 구현시엔 여기서도 adminPassword 체크 권장하지만 기존 코드 유지
    try {
        const reservation = await Reservation.findByIdAndDelete(req.params.id);
        if(reservation) {
             console.log(`관리자(${adminUsername})가 예약 삭제`);
             const all = await Reservation.find({});
             io.emit('reservationsUpdated', all);
        }
        res.json({success:true, message:'삭제되었습니다.'});
    } catch(e) { res.status(500).json({message:'오류'}); }
});

// 전체 예약 삭제
app.delete('/api/reservations/all', async (req, res) => {
    try {
        await Reservation.deleteMany({});
        io.emit('reservationsUpdated', []);
        res.json({success:true});
    } catch(e) { res.status(500).json({message:'오류'}); }
});

// Socket
io.on('connection', (socket) => {
    console.log('Client connected');
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));