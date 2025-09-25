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
  null, // 로컬 파일 접근용
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
app.set('trust proxy', 1); // 프록시 환경에서 클라이언트 IP 정확히 파악

// Rate limiter 설정: 1분당 최대 20회 요청 제한
// 모든 예약 취소는 관리자 기능이므로 제외 (편의상)
const limiter = rateLimit({
  windowMs: 60000, // 1분
  max: 20, // 1분당 20회 요청
  message: 'Too many requests, please try again later.', // 너무 많은 요청 시 메시지
  standardHeaders: true, // 표준 RateLimit 헤더 사용
  legacyHeaders: false, // 레거시 X-RateLimit 헤더 사용 안 함
  skip: req => req.path === '/api/reservations/all' // 모든 예약 취소 API는 레이트 리밋 적용 안함
});

// MongoDB 연결
mongoose.connect(MONGO_URI, {
  useNewUrlParser:true,
  useUnifiedTopology:true,
  serverSelectionTimeoutMS:15000 // 서버 선택 타임아웃 15초
}).then(()=>console.log('MongoDB connected'))
  .catch(err=>console.error('MongoDB connection failed:', err));

// 예약 스키마 정의
const reservationSchema = new mongoose.Schema({
  roomNo: {type:String, required:true},
  name: {type:String, required:true},
  dormitory: {type:String, required:true},
  floor: {type:String, required:true},
  seat: {type:Number, required:true},
  password: {type:String, required:true}, // bcrypt 해싱된 비밀번호
  plainPassword: {type:String, required:true}, // 관리자 확인용 평문 비밀번호 (보안 주의)
  createdAt: {type:Date, default:Date.now} // 예약 생성 시간
});

// 인덱스 설정: 중복 예약 방지
reservationSchema.index({roomNo:1, name:1}, {unique:true}); // 룸번호+이름 유일
reservationSchema.index({dormitory:1, floor:1, seat:1}, {unique:true}); // 기숙사+층+좌석 유일

// 비밀번호 저장 전 해싱 미들웨어
reservationSchema.pre('save', async function(next){
  // 비밀번호가 수정되었고, 아직 해싱되지 않은 경우 (50자 미만)
  if(this.isModified('password') && this.password.length < 50){
    this.password = await bcrypt.hash(this.password, 10); // 10회 솔트 라운드로 해싱
  }
  next();
});
const Reservation = mongoose.model('Reservation', reservationSchema);

// 관리자 예약 가능 시간 설정 스키마 정의
const adminSettingSchema = new mongoose.Schema({
  key:{type:String, unique:true, required:true}, // 'reservationTimes'로 고정
  reservationStartTime: {type:Date, default:null}, // 예약 시작 가능 시간
  reservationEndTime: {type:Date, default:null}   // 예약 종료 가능 시간
});
const AdminSetting = mongoose.model('AdminSetting', adminSettingSchema);

// 일반 공지사항 스키마 정의
const announcementSchema = new mongoose.Schema({
  key:{type:String, unique:true, default:'currentAnnouncement'}, // 'currentAnnouncement' 고정
  message:{type:String, default:''}, // 공지 내용
  active:{type:Boolean, default:false}, // 공지 활성화 여부
  updatedAt:{type:Date, default:Date.now} // 마지막 업데이트 시간
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// 관리자 전용 공지사항 스키마 정의
const adminOnlyAnnouncementSchema = new mongoose.Schema({
  key:{type:String, unique:true, default:'adminOnlyAnnouncement'}, // 'adminOnlyAnnouncement' 고정
  message:{type:String, default:''}, // 관리자 전용 공지 내용
  active:{type:Boolean, default:false}, // 관리자 전용 공지 활성화 여부
  updatedAt:{type:Date, default:Date.now} // 마지막 업데이트 시간
});
const AdminOnlyAnnouncement = mongoose.model('AdminOnlyAnnouncement', adminOnlyAnnouncementSchema);

// 약한 비밀번호 검사 헬퍼 함수
function isWeakPassword(password){
  const p=password.toLowerCase();
  const len=p.length;
  // 단순 반복 문자 (예: 1111, aaaa), 키보드 연속 패턴 (예: abcd, qwer)
  const simplePatterns=[
    /^(.)\1{3,}$/,
    /^abcd(e?f?g?h?i?j?k?l?m?n?o?p?q?r?s?t?u?v?w?x?y?z?)?$/,
    /^qwer(t?y?u?i?o?p?)?$/,
    /^asdf(g?h?j?k?l?)?$/,
    /^zxcv(b?n?m?)?$/
  ];
  if(simplePatterns.some(r=>r.test(p))) return true;
  if(len < 4) return false; // 4자 미만은 약한 비밀번호 검사에 포함시키지 않음

  // 숫자 및 알파벳 연속/역순 4자리 패턴
  for(let i=0; i<=len-4; i++){
    const sub=p.substr(i,4);
    if(/^\d{4}$/.test(sub)){ // 4자리 숫자
      const d=sub.split('').map(x=>parseInt(x));
      if((d[1]==d[0]+1&&d[2]==d[1]+1&&d[3]==d[2]+1) || (d[1]==d[0]-1&&d[2]==d[1]-1&&d[3]==d[2]-1)) return true;
    }
    if(/^[a-z]{4}$/.test(sub)){ // 4자리 알파벳
      const c=sub.split('').map(x=>x.charCodeAt(0));
      if((c[1]==c[0]+1&&c[2]==c[1]+1&&c[3]==c[2]+1) || (c[1]==c[0]-1&&c[2]==c[1]-1&&c[3]==c[2]-1)) return true;
    }
  }
  return false;
}

// 관리자 로그인 API
app.post('/api/admin-login', (req,res)=>{
  const {password, username} = req.body;
  const ip=req.ip;
  if(!username || !password) return res.status(400).json({success:false,message:'이름과 비밀번호 모두 입력 필요'});
  if(!ADMIN_PASSWORD) {
    console.error(`서버 오류: ADMIN_PASSWORD 환경변수 미설정. IP: ${ip}`);
    return res.status(500).json({success:false,message:'서버 관리자 비밀번호 미설정'});
  }
  if(!ADMIN_USERNAMES.includes(username)) {
    console.log(`관리자 로그인 실패 (이름 오류): ${username}, IP: ${ip}`);
    return res.status(401).json({success:false,message:'허용되지 않은 관리자 이름'});
  }
  if(password === ADMIN_PASSWORD){
    console.log(`관리자 로그인 성공: ${username}, IP: ${ip}, 시간: ${new Date().toISOString()}`);
    res.json({success:true, message:'관리자 로그인 성공'});
  } else {
    console.log(`관리자 로그인 실패 (비밀번호 오류): ${username}, IP: ${ip}, 시간: ${new Date().toISOString()}`);
    res.status(401).json({success:false,message:'비밀번호 불일치'});
  }
});

// 모든 예약 조회 API
app.get('/api/reservations', async (req, res)=>{
  try{
    const reservations = await Reservation.find({});
    res.json(reservations);
  }catch(e){
    console.error('예약 조회 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 예약 생성 또는 수정 API
app.post('/api/reservations', limiter, async (req,res) => {
  if(req.body.honeypot_field) return res.status(400).json({message:'비정상적 요청'}); // honeypot 필터
  const {roomNo, name, dormitory, floor, seat, password} = req.body;
  if(!roomNo || !name || !dormitory || !floor || seat === undefined || !password) 
    return res.status(400).json({message:'모든 정보가 필요합니다.'});
  if(isWeakPassword(password)) 
    return res.status(400).json({message:'매우 단순한 비밀번호는 사용할 수 없습니다. 다른 비밀번호를 사용해주세요.'});

  // 예약 가능 시간 확인
  const adminSetting = await AdminSetting.findOne({key:'reservationTimes'});
  if(!adminSetting || !adminSetting.reservationStartTime || !adminSetting.reservationEndTime)
    return res.status(403).json({message:'예약 가능 시간이 설정되지 않았습니다.'});
  const now = new Date();
  if(now < adminSetting.reservationStartTime || now > adminSetting.reservationEndTime)
    return res.status(403).json({message:'현재 예약 가능 시간이 아닙니다.'});
  
  try {
    const conflict = await Reservation.findOne({dormitory, floor, seat});
    const existing = await Reservation.findOne({roomNo, name});

    // 중복 좌석 또는 이미 존재하는 사용자의 좌석 변경
    if(conflict && (!existing || existing._id.toString() !== conflict._id.toString())) 
      return res.status(409).json({message:'선택하신 좌석은 이미 예약되어 있습니다.'});

    if(existing){ // 기존 사용자 - 예약 변경
      const match = await bcrypt.compare(password, existing.password);
      if(!match) return res.status(401).json({message:'비밀번호가 일치하지 않습니다.'});
      const resv = await Reservation.findByIdAndUpdate(existing._id, {dormitory,floor,seat}, {new:true});
      console.log(`예약 변경 성공: ${resv.name} (${resv.roomNo}), 좌석: ${resv.dormitory} ${resv.floor}-${resv.seat}`);
      res.json({success:true, message:'예약 변경 성공', reservation: resv});
    } else { // 신규 사용자 - 예약 생성
      const resv = new Reservation({roomNo,name,dormitory,floor,seat,password,plainPassword:password});
      await resv.save();
      console.log(`예약 생성 성공: ${resv.name} (${resv.roomNo}), 좌석: ${resv.dormitory} ${resv.floor}-${resv.seat}`);
      res.json({success:true, message:'예약 성공', reservation: resv});
    }
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations); // 실시간 업데이트 알림
  } catch(e){
    console.error('예약 생성/변경 실패:', e);
    if(e.code === 11000) return res.status(409).json({message:'중복된 예약 정보입니다.'});
    res.status(500).json({message:'서버 오류'});
  }
});

// --- !!! 라우트 순서 변경: `/api/reservations/all` 라우트를 `:id` 라우트보다 먼저 정의 !!! ---
// 모든 예약 취소 API (관리자 이름 및 비밀번호 검증)
app.delete('/api/reservations/all', async(req, res)=>{
  const {adminUsername, adminPassword} = req.body; // 관리자 이름과 비밀번호를 모두 받음
  const clientIp = req.ip;

  // 관리자 이름 및 비밀번호 검증
  if(!adminUsername || !ADMIN_USERNAMES.includes(adminUsername)) {
    console.log(`모든 예약 취소 실패 (권한 없음 - ${adminUsername || '미지정'}), IP: ${clientIp}`);
    return res.status(403).json({message:'권한이 없습니다. 관리자 로그인 확인요망'});
  }
  if(adminPassword !== ADMIN_PASSWORD) {
    console.log(`모든 예약 취소 실패 (관리자 비밀번호 불일치 - ${adminUsername}), IP: ${clientIp}`);
    return res.status(401).json({success:false, message:'관리자 비밀번호가 틀렸습니다.'});
  }

  try{
    await Reservation.deleteMany({}); // 모든 예약 삭제
    console.warn(`[모든 예약 삭제] 관리자(${adminUsername})에 의해 모든 예약이 취소되었습니다. IP: ${clientIp}`);
    io.emit('reservationsUpdated', []); // 모든 클라이언트에 예약 목록 비어있음을 알림
    res.json({success:true,message:'모든 예약이 취소되었습니다.'});
  }catch(e){
    console.error('전체 예약 삭제 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 개별 예약 취소 API (관리자 권한 시 예약자 비밀번호 없이 바로 취소 가능)
app.delete('/api/reservations/:id', async(req, res)=>{
  try{
    const {id} = req.params;
    let {password, adminUsername} = req.body;
    const clientIp = req.ip;

    const isAdmin = adminUsername && ADMIN_USERNAMES.includes(adminUsername);

    if(isAdmin){ // 관리자 권한으로 삭제 요청
      const reservation = await Reservation.findById(id);
      if(!reservation) return res.status(404).json({message:'예약을 찾을 수 없습니다.'});
      await Reservation.findByIdAndDelete(id);
      console.log(`관리자(${adminUsername})에 의해 예약(${reservation.name}, ${reservation.roomNo}) 취소됨. IP: ${clientIp}`);
      const allReservations = await Reservation.find({});
      io.emit('reservationsUpdated', allReservations); // 실시간 업데이트 알림
      return res.json({success:true, message:`관리자(${adminUsername})가 예약을 취소했습니다.`});
    }

    // 관리자 권한이 없거나, adminUsername이 유효하지 않을 경우: 예약자 비밀번호 검증 필요
    if(!password) return res.status(400).json({message:'예약 비밀번호를 입력해주세요.'});
    const reservation = await Reservation.findById(id);
    if(!reservation) return res.status(404).json({message:'예약을 찾을 수 없습니다.'});
    const match = await bcrypt.compare(password, reservation.password);
    if(!match) return res.status(401).json({success:false,message:'예약 비밀번호가 일치하지 않습니다.'});
    await Reservation.findByIdAndDelete(id);
    console.log(`사용자에 의해 예약(${reservation.name}, ${reservation.roomNo}) 취소됨. IP: ${clientIp}`);
    const allReservations = await Reservation.find({});
    io.emit('reservationsUpdated', allReservations); // 실시간 업데이트 알림
    res.json({success:true,message:'예약 취소 완료'});
  }catch(e){
    console.error('예약 취소 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자 예약 가능 시간 조회 API
app.get('/api/admin-settings', async (req,res) => {
  try{
    let settings = await AdminSetting.findOne({key:'reservationTimes'});
    if(!settings){ // 설정이 없으면 기본값으로 생성
      settings = new AdminSetting({key:'reservationTimes'});
      await settings.save();
    }
    res.json(settings);
  }catch(e){
    console.error('관리자 설정 조회 실패:', e);
    res.status(500).json({message:"서버 오류"});
  }
});

// 관리자 예약 가능 시간 저장 API (관리자 이름+비밀번호 검증)
app.put('/api/admin-settings', async (req,res) => {
  const { reservationStartTime, reservationEndTime, adminUsername, adminPassword } = req.body;
  const clientIp = req.ip;

  if(!adminUsername || !adminPassword)
    return res.status(400).json({message:'관리자 이름과 비밀번호를 입력해주세요.'});
  if(!ADMIN_USERNAMES.includes(adminUsername))
    return res.status(403).json({message:'허가되지 않은 관리자입니다.'});
  if(adminPassword !== ADMIN_PASSWORD) // 평문 비밀번호 비교
    return res.status(401).json({message:'관리자 비밀번호가 틀렸습니다.'});

  try{
    const settings = await AdminSetting.findOneAndUpdate(
      {key:'reservationTimes'},
      {reservationStartTime, reservationEndTime},
      {new:true, upsert:true} // 없으면 새로 생성, 있으면 업데이트
    );
    console.log(`관리자(${adminUsername}) 예약 가능 시간 설정됨: ${reservationStartTime} ~ ${reservationEndTime}. IP: ${clientIp}`);
    io.emit('settingsUpdated', settings); // 실시간 업데이트 알림
    res.json({success:true, message:'예약 가능 시간이 설정되었습니다.', settings});
  }catch(e){
    console.error('관리자 예약 시간 설정 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 일반 공지사항 조회 API
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

// 일반 공지사항 저장 API (관리자 이름+비밀번호 검증)
app.put('/api/announcement', async (req,res) => {
  const {message, active, adminUsername, adminPassword} = req.body;
  const clientIp = req.ip;

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
    console.log(`관리자(${adminUsername}) 일반 공지사항 변경. 활성: ${active}, 내용: ${message}. IP: ${clientIp}`);
    io.emit('announcementUpdated', announcement); // 실시간 업데이트 알림
    res.json({success:true, message:'공지사항이 저장되었습니다.'});
  }catch(e){
    console.error('공지사항 저장 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자 전용 공지사항 조회 API
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

// 관리자 전용 공지사항 저장 API (관리자 이름+비밀번호 검증)
app.put('/api/admin-announcement', async (req,res) => {
  const {message, active, adminUsername, adminPassword} = req.body;
  const clientIp = req.ip;

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
    console.log(`관리자(${adminUsername}) 관리자 전용 공지사항 변경. 활성: ${active}, 내용: ${message}. IP: ${clientIp}`);
    io.emit('adminAnnouncementUpdated', announcement); // 실시간 업데이트 알림
    res.json({success:true, message:'관리자 전용 공지사항이 저장되었습니다.'});
  }catch(e){
    console.error('관리자 전용 공지사항 저장 실패:', e);
    res.status(500).json({message:'서버 오류'});
  }
});

// 관리자용 예약 평문 비밀번호 열람 API (관리자 이름+비밀번호 검증)
app.post('/api/admin/reservations/:id/view-plain-password', async (req,res) => {
  const {id} = req.params;
  const {adminPassword, adminUsername} = req.body;
  const clientIp = req.ip;

  if(!adminPassword || !adminUsername) 
    return res.status(400).json({success:false, message:'관리자 이름과 비밀번호를 입력해주세요.'});
  if(adminPassword !== ADMIN_PASSWORD) 
    return res.status(401).json({success:false,message:'관리자 비밀번호가 틀렸습니다.'});
  if(!ADMIN_USERNAMES.includes(adminUsername)) 
    return res.status(403).json({message:'권한이 없습니다.'});

  try{
    const reservation = await Reservation.findById(id).select('plainPassword name roomNo dormitory floor seat');
    if(!reservation) return res.status(404).json({success:false, message:'예약을 찾을 수 없습니다.'});
    console.log(`관리자(${adminUsername}) 예약(${reservation.name}, ${reservation.roomNo}) 비밀번호 열람. IP: ${clientIp}`);
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
    socket.emit('reservationsInitial', allReservations); // 초기 예약 정보 전송
    const adminSettings = await AdminSetting.findOne({key:'reservationTimes'});
    socket.emit('adminSettingsInitial', adminSettings); // 초기 관리자 설정 전송
    const announcement = await Announcement.findOne({key:'currentAnnouncement'});
    socket.emit('announcementInitial', announcement); // 초기 일반 공지 전송
    const adminAnnouncement = await AdminOnlyAnnouncement.findOne({key:'adminOnlyAnnouncement'});
    socket.emit('adminOnlyAnnouncementInitial', adminAnnouncement); // 초기 관리자 전용 공지 전송
  }catch(e){
    console.error('초기 데이터 전송 실패:', e);
  }
  socket.on('disconnect', () => {
    console.log(`클라이언트 연결 종료: ${socket.id}`);
  });
});

// 서버 구동
server.listen(PORT, ()=>{
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});