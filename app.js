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

// CORS 허용 도메인 리스트
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  null,
  'https://heartfelt-cannoli-903df2.netlify.app'
];

// Socket.IO 설정(CORS 포함)
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if(!origin) return callback(null, true);
      if(!allowedOrigins.includes(origin)) return callback(new Error('CORS 차단된 도메인'), false);
      callback(null, true);
    },
    methods: ['GET','POST','PUT','DELETE'],
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_USERNAMES = process.env.ADMIN_USERNAMES ? process.env.ADMIN_USERNAMES.split(',') : [];

app.use(cors({
  origin: (origin, callback) => {
    if(!origin) return callback(null, true);
    if(!allowedOrigins.includes(origin)) return callback(new Error('CORS 차단된 도메인'), false);
    callback(null, true);
  },
  credentials: true
}));

app.use(express.json());

// trust proxy 설정(프록시 환경 대응)
app.set('trust proxy', 1);

// Rate-limit 설정(1분 20회, 예약 전체 삭제는 제외)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: '너무 많은 요청입니다. 잠시 후 시도해주세요.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.path === '/api/reservations/all'
});

// MongoDB 연결
mongoose.connect(MONGO_URI, {
  useNewUrlParser:true,
  useUnifiedTopology:true,
  serverSelectionTimeoutMS:15000,
}).then(()=>console.log('MongoDB 연결 성공'))
  .catch(err=>console.error('MongoDB 연결 실패:',err));

// 예약 스키마 정의
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

// 관리자 예약 가능시간 설정 스키마
const adminSettingSchema = new mongoose.Schema({
  key: {type:String, unique:true, required:true},
  reservationStartTime: {type:Date, default:null},
  reservationEndTime: {type:Date, default:null}
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

// 일반 공지 스키마
const announcementSchema = new mongoose.Schema({
  key: {type:String, unique:true, default:'currentAnnouncement'},
  message: {type:String, default:''},
  active: {type:Boolean, default:false},
  updatedAt: {type:Date, default:Date.now}
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// 관리자 전용 공지 스키마
const adminOnlyAnnouncementSchema = new mongoose.Schema({
  key: {type:String, unique:true, default:'adminOnlyAnnouncement'},
  message: {type:String, default:''},
  active: {type:Boolean, default:false},
  updatedAt: {type:Date, default:Date.now}
});
const AdminOnlyAnnouncement = mongoose.model('AdminOnlyAnnouncement', adminOnlyAnnouncementSchema);

// 약한 비밀번호 필터 함수
function isWeakPassword(password){
  const p = password.toLowerCase();
  const len = p.length;
  const patt = [
    /^(.)\1{3,}$/, /^abcd(e?f?g?h?i?j?k?l?m?n?o?p?q?r?s?t?u?v?w?x?y?z?)?$/,
    /^qwer(t?y?u?i?o?p?)?$/, /^asdf(g?h?j?k?l?)?$/, /^zxcv(b?n?m?)?$/
  ];
  if(patt.some(r => r.test(p))) return true;
  if(len<4) return false;
  for(let i=0; i<=len-4; i++){
    const sub = p.substr(i,4);
    if(/^\d{4}$/.test(sub)){
      const d = sub.split('').map(x => parseInt(x));
      if((d[1] === d[0]+1 && d[2]===d[1]+1 && d[3]===d[2]+1) || (d[1]===d[0]-1 && d[2]===d[1]-1 && d[3]===d[2]-1))
        return true;
    }
    if(/^[a-z]{4}$/.test(sub)){
      const c = sub.split('').map(x => x.charCodeAt(0));
      if((c[1]===c[0]+1&&c[2]===c[1]+1&&c[3]===c[2]+1)||(c[1]===c[0]-1&&c[2]===c[1]-1&&c[3]===c[2]-1))
        return true;
    }
  }
  return false;
}

// 관리자 로그인 API
app.post('/api/admin-login', (req, res) => {
  const {password, username} = req.body;
  const ip = req.ip;
  if(!username || !password) return res.status(400).json({success:false, message:'이름과 비밀번호를 모두 입력해주세요.'});
  if(!ADMIN_PASSWORD) return res.status(500).json({success:false, message:'서버 관리자 비밀번호가 설정되지 않았습니다.'});
  if(!ADMIN_USERNAMES.includes(username)) return res.status(401).json({success:false, message:'허용되지 않은 관리자 이름입니다.'});
  if(password === ADMIN_PASSWORD){
    console.log(`관리자 로그인 성공 - 이름: ${username} - IP: ${ip} - 시간: ${new Date().toISOString()}`);
    return res.json({success:true, message:'관리자 로그인 성공'});
  }
  console.log(`관리자 로그인 실패 (비밀번호 오류) - 이름: ${username} - IP: ${ip} - 시간: ${new Date().toISOString()}`);
  return res.status(401).json({success:false, message:'비밀번호가 틀렸습니다.'});
});

// 예약 전체 조회 API
app.get('/api/reservations', async (req, res) => {
  try{
    const reservations = await Reservation.find({});
    res.json(reservations);
  }catch(e){
    console.error('예약 조회 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 생성/변경 API
app.post('/api/reservations', limiter, async (req, res) => {
  if(req.body.honeypot_field) return res.status(400).json({message:'비정상적 요청'});
  const {roomNo, name, dormitory, floor, seat, password} = req.body;
  if(!roomNo || !name || !dormitory || !floor || seat == null || !password) return res.status(400).json({message:'모든 정보를 입력하세요.'});
  if(isWeakPassword(password)) return res.status(400).json({message:'매우 단순한 비밀번호는 사용할 수 없습니다.'});
  const adminSettings = await AdminSetting.findOne({key:'reservationTimes'});
  if(!adminSettings || !adminSettings.reservationStartTime || !adminSettings.reservationEndTime) return res.status(403).json({message:'예약 가능 시간이 설정되지 않았습니다.'});
  const now = new Date();
  if(now < adminSettings.reservationStartTime || now > adminSettings.reservationEndTime) return res.status(403).json({message:'현재 예약 가능 시간이 아닙니다.'});
  try{
    const conflictSeat = await Reservation.findOne({dormitory, floor, seat});
    const existingUser = await Reservation.findOne({roomNo, name});
    if(conflictSeat && (!existingUser || existingUser._id.toString() !== conflictSeat._id.toString())) return res.status(409).json({message:'선택된 좌석은 이미 예약되어 있습니다.'});
    let reservation;
    if(existingUser){
      const isPasswordCorrect = await bcrypt.compare(password, existingUser.password);
      if(!isPasswordCorrect) return res.status(401).json({success:false, message:'비밀번호가 일치하지 않습니다.'});
      reservation = await Reservation.findByIdAndUpdate(existingUser._id, {dormitory, floor, seat}, {new:true});
      console.log(`[예약 변경 성공] ${reservation.name} (${reservation.roomNo})`);
    } else {
      reservation = new Reservation({roomNo, name, dormitory, floor, seat, password, plainPassword:password});
      await reservation.save();
      console.log(`[예약 생성 성공] ${reservation.name} (${reservation.roomNo})`);
    }
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({success:true, message:'예약 성공', newReservation:reservation});
  }catch(e){
    console.error('예약 처리 중 오류:', e);
    if(e.code === 11000) return res.status(409).json({message:'중복된 예약입니다.'});
    res.status(500).json({message:'서버 오류'});
  }
});

// 개별 예약 취소 API
app.delete('/api/reservations/:id', async (req,res) => {
  try{
    const {id} = req.params;
    const {password, adminUsername} = req.body;
    if(!password) return res.status(400).json({message:'비밀번호를 입력해주세요.'});
    const existingReservation = await Reservation.findById(id);
    if(!existingReservation) return res.status(404).json({message:'예약을 찾을 수 없습니다.'});
    const isPasswordCorrect = await bcrypt.compare(password, existingReservation.password);
    if(!isPasswordCorrect) return res.status(401).json({success:false, message:'비밀번호 일치하지 않음'});
    await Reservation.findByIdAndDelete(id);
    const logText = adminUsername ? `관리자(${adminUsername})` : '사용자';
    console.log(`${logText} [예약 취소] ${existingReservation.name} (${existingReservation.roomNo})`);
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations);
    res.json({success:true, message:'예약이 취소되었습니다.'});
  }catch(e){
    console.error('예약 취소 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 모든 예약 취소 (관리자 비밀번호 확인 API)
app.delete('/api/reservations/all', async (req,res) => {
  const { adminUsername, adminPassword } = req.body;
  const ip = req.ip;
  if(!adminUsername || !adminPassword)
    return res.status(400).json({message:'관리자 이름과 비밀번호를 입력해주세요.'});
  if(!ADMIN_USERNAMES.includes(adminUsername))
    return res.status(403).json({message:'허가되지 않은 관리자입니다.'});
  if(adminPassword !== ADMIN_PASSWORD)
    return res.status(401).json({message:'관리자 비밀번호가 틀렸습니다.'});
  try{
    await Reservation.deleteMany({});
    console.log(`관리자(${adminUsername}) 모든 예약 취소 성공 - IP:${ip} 시간:${new Date().toISOString()}`);
    io.emit('reservationsUpdated', []);
    res.json({success:true, message:'모든 예약이 취소되었습니다.'});
  }catch(e){
    console.error('전 예약 취소 실패:',e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자 예약 가능 시간 조회
app.get('/api/admin-settings', async (req,res) => {
  try{
    let settings = await AdminSetting.findOne({key:'reservationTimes'});
    if(!settings){
      settings = new AdminSetting({key:'reservationTimes'});
      await settings.save();
    }
    res.json(settings);
  }catch(e){
    console.error('관리자 설정 조회 실패:', e);
    res.status(500).json({message:"서버 오류"});
  }
});

// 관리자 예약 가능 시간 저장
app.put('/api/admin-settings', async (req,res) => {
  const { reservationStartTime, reservationEndTime, adminUsername, adminPassword } = req.body;
  const ip = req.ip;
  if(!adminUsername || !adminPassword)
    return res.status(400).json({message:'관리자 이름과 비밀번호를 입력해주세요.'});
  if(!ADMIN_USERNAMES.includes(adminUsername))
    return res.status(403).json({message:'허가되지 않은 관리자입니다.'});
  if(adminPassword !== ADMIN_PASSWORD)
    return res.status(401).json({message:'관리자 비밀번호가 틀렸습니다.'});
  try{
    const settings = await AdminSetting.findOneAndUpdate(
      {key:'reservationTimes'},
      {reservationStartTime, reservationEndTime},
      {new:true, upsert:true}
    );
    console.log(`관리자(${adminUsername}) 예약 가능 시간 설정됨: ${reservationStartTime} ~ ${reservationEndTime} - IP:${ip}`);
    io.emit('settingsUpdated', settings);
    res.json({success:true, message:'예약 가능 시간이 설정되었습니다.', settings});
  }catch(e){
    console.error('관리자 예약 시간 설정 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 일반 공지사항 조회
app.get('/api/announcement', async (req,res) => {
  try{
    let announcement = await Announcement.findOne({key:'currentAnnouncement'});
    if(!announcement){
      announcement = new Announcement({key:'currentAnnouncement'});
      await announcement.save();
    }
    res.json(announcement);
  }catch(e){
    console.error('공지사항 조회 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 일반 공지사항 저장
app.put('/api/announcement', async (req,res) => {
  const {message, active, adminUsername, adminPassword} = req.body;
  const ip = req.ip;
  if(!adminUsername || !adminPassword)
    return res.status(400).json({message:'관리자 이름과 비밀번호가 필요합니다.'});
  if(!ADMIN_USERNAMES.includes(adminUsername))
    return res.status(403).json({message:'허가되지 않은 관리자입니다.'});
  if(adminPassword !== ADMIN_PASSWORD)
    return res.status(401).json({message:'비밀번호가 틀렸습니다.'});
  try{
    const announcement = await Announcement.findOneAndUpdate(
      {key:'currentAnnouncement'},
      {message, active, updatedAt: new Date()},
      {new:true, upsert:true}
    );
    console.log(`관리자(${adminUsername}) 일반 공지사항 변경 - IP:${ip}`);
    io.emit('announcementUpdated', announcement);
    res.json({success:true, message:'공지사항이 저장되었습니다.'});
  }catch(e){
    console.error('공지사항 저장 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자 전용 공지사항 조회
app.get('/api/admin-announcement', async (req,res) => {
  try{
    let announcement = await AdminOnlyAnnouncement.findOne({key:'adminOnlyAnnouncement'});
    if(!announcement){
      announcement = new AdminOnlyAnnouncement({key:'adminOnlyAnnouncement'});
      await announcement.save();
    }
    res.json(announcement);
  }catch(e){
    console.error('관리자 전용 공지사항 조회 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자 전용 공지사항 저장
app.put('/api/admin-announcement', async (req,res) => {
  const {message, active, adminUsername, adminPassword} = req.body;
  const ip = req.ip;
  if(!adminUsername || !adminPassword)
    return res.status(400).json({message:'관리자 이름과 비밀번호가 필요합니다.'});
  if(!ADMIN_USERNAMES.includes(adminUsername))
    return res.status(403).json({message:'허가되지 않은 관리자입니다.'});
  if(adminPassword !== ADMIN_PASSWORD)
    return res.status(401).json({message:'비밀번호가 틀렸습니다.'});
  try{
    const announcement = await AdminOnlyAnnouncement.findOneAndUpdate(
      {key:'adminOnlyAnnouncement'},
      {message, active, updatedAt: new Date()},
      {new:true, upsert:true}
    );
    console.log(`관리자(${adminUsername}) 관리자 전용 공지사항 변경 - IP:${ip}`);
    io.emit('adminAnnouncementUpdated', announcement);
    res.json({success:true, message:'관리자 전용 공지사항이 저장되었습니다.'});
  }catch(e){
    console.error('관리자 전용 공지사항 저장 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자용 예약 비밀번호 열람 API
app.post('/api/admin/reservations/:id/view-plain-password', async (req,res) => {
  const {id} = req.params;
  const {adminPassword, adminUsername} = req.body;
  const ip = req.ip;
  if(!adminPassword) return res.status(400).json({success:false, message:'관리자 비밀번호를 입력해주세요.'});
  if(adminPassword !== ADMIN_PASSWORD) return res.status(401).json({success:false,message:'관리자 비밀번호가 틀렸습니다.'});
  if(!adminUsername || !ADMIN_USERNAMES.includes(adminUsername)) return res.status(403).json({message:'권한이 없습니다.'});
  try{
    const reservation = await Reservation.findById(id).select('plainPassword name roomNo dormitory floor seat');
    if(!reservation) return res.status(404).json({success:false, message:'예약을 찾을 수 없습니다.'});
    console.log(`관리자(${adminUsername}) 예약 비밀번호 열람 성공 - ${reservation.name} (${reservation.roomNo}) - IP:${ip}`);
    res.json({success:true, plainPassword:reservation.plainPassword});
  }catch(e){
    console.error('비밀번호 열람 실패:', e);
    res.status(500).json({success:false, message:'서버 오류'});
  }
});

// Socket.IO 이벤트
io.on('connection', async (socket)=>{
  console.log(`클라이언트 연결됨: ${socket.id}`);
  try{
    const allReservations = await Reservation.find({});
    socket.emit('reservationsInitial', allReservations);
    const adminSettings = await AdminSetting.findOne({key:'reservationTimes'});
    socket.emit('adminSettingsInitial', adminSettings);
    const announcement = await Announcement.findOne({key:'currentAnnouncement'});
    socket.emit('announcementInitial', announcement);
    const adminAnnouncement = await AdminOnlyAnnouncement.findOne({key:'adminOnlyAnnouncement'});
    socket.emit('adminOnlyAnnouncementInitial', adminAnnouncement);
  }catch(e){
    console.error('초기 데이터 전송 실패:', e);
  }
  socket.on('disconnect', () => {
    console.log(`클라이언트 연결 종료: ${socket.id}`);
  });
});

// 서버 시작
server.listen(PORT, ()=>{
  console.log(`서버 실행중: http://localhost:${PORT}`);
});