# ตั้งค่า Firebase สำหรับเว็บพันเรือง

1. สร้างหรือเลือกโปรเจกต์ใน Firebase Console แล้วเพิ่ม **Web app**
2. เปิด **Realtime Database** และเลือกตำแหน่งฐานข้อมูล
3. ที่ **Authentication → Sign-in method** เปิดเฉพาะ **Email/Password** แล้วสร้าง Firebase Auth user สำหรับผู้ดูแลทุกเลขประจำตัว: เลข `44447` ให้สร้างอีเมล `44447@phunrueang.admin` (รูปแบบคือ `เลขประจำตัว@FIREBASE_ADMIN_EMAIL_DOMAIN` จาก `firebase-config.js`) ส่วน Password ใน Firebase ให้ตั้งเป็น `pn_` ตามด้วยรหัสเดิมที่ผู้ใช้กรอกหน้าแอดมิน เช่น รหัสเดิม `2580` ต้องตั้ง Firebase Password เป็น `pn_2580`
4. คัดลอกค่า Web configuration ไปแทนค่า `PASTE_...` ใน [firebase-config.js](firebase-config.js)
5. ใน Realtime Database → Rules ให้วางเนื้อหาจาก [firebase-database.rules.json](firebase-database.rules.json) แล้ว Publish (จำเป็นสำหรับระบบคะแนนแบบเรียลไทม์ใหม่ที่ `sites/phanuang/electionVotes`)
6. ตั้งค่า Cloudinary ตามหัวข้อด้านล่าง แล้ว Deploy ทั้ง `index.html`, `app.js`, `cloudinary-config.js`, `firebase-config.js`, `access-data.js` และไฟล์อื่น ๆ ใหม่พร้อมกัน

## ตั้งค่า Cloudinary สำหรับรูปภาพ

1. สร้าง **Unsigned upload preset** ใน Cloudinary Console โดยจำกัดชนิดไฟล์เป็น JPG, PNG และ WebP
2. ใส่เฉพาะ Cloud name และชื่อ unsigned preset ใน `cloudinary-config.js` ห้ามใส่ API Secret
3. รูปภาพจะถูกย่อใน browser แล้วอัปโหลดไปยัง folder `phunrueang/members`, `phunrueang/gallery` หรือ `phunrueang/products`
4. Firebase Realtime Database ยังคงเป็น source of truth และเก็บเฉพาะ Cloudinary `secure_url`/URL ปกติ ไม่เก็บไฟล์ภาพ Base64 ใหม่

รูป Base64 เดิมจะยังใช้งานได้ชั่วคราว และย้ายไป Cloudinary อย่างปลอดภัยเมื่อผู้ดูแลแก้ไขแล้วกดบันทึกรายการหรือหมวดนั้นครั้งถัดไป

ข้อมูลกลางอยู่ใต้ `sites/phanuang/state` และทุกแท็บที่เปิดเว็บอยู่จะรับการอัปเดตแบบเรียลไทม์ทันทีหลัง Firebase เริ่มทำงาน โดยไม่ต้องล็อกอินและไม่ใช้ Anonymous Authentication ข้อมูลจาก Firebase จะเขียนทับ localStorage ของเครื่องเสมอ รวมถึงเมื่อ snapshot จาก Firebase ว่าง เพื่อไม่ให้ข้อมูลเก่าในเครื่องใดเครื่องหนึ่งกลายเป็นข้อมูลกลาง ผังที่นั่ง (`phanuang-stand-config`) อยู่ในข้อมูลกลางนี้ด้วย และการเช็คชื่อแต่ละที่นั่งใช้ Firebase transaction เพื่อไม่ให้แอดมินหลายเครื่องเขียนทับผลของกันและกัน

หน้าประกาศผลเลือกตั้งจะแสดงครบทุกห้องที่มีในฐานข้อมูลพันเรือง (รวมทั้งห้องที่ยังไม่มีคะแนน) และหน้าตั้งค่าเลือกตั้งจะเปิดสิทธิ์ให้ทุกห้องโดยอัตโนมัติ เพื่อป้องกันผลประกาศตกหล่นจากคอนฟิกเดิมที่มีเพียงบางห้อง

หน้าแอดมินยังคงให้ผู้ใช้กรอกเพียง **เลขประจำตัว** และ **รหัสผ่านเดิม**; เว็บไซต์จะแปลงเลขประจำตัวเป็น Firebase email ภายในเอง และแปลงรหัสผ่านเป็น `pn_` + รหัสเดิมเฉพาะก่อนส่งไปตรวจที่ Firebase เท่านั้น ผู้ใช้จะไม่เห็น Firebase email หรือรหัสผ่านที่แปลงแล้ว `access-data.js` ใช้เพียงตรวจว่าเลขประจำตัวนั้นเป็นผู้ดูแลที่อนุญาต และใช้แสดงชื่อ/role ไม่ได้ใช้ตรวจรหัสผ่านหลักอีกต่อไป

การเขียนจากหน้าแอดมินจะทำได้เมื่อ Firebase Email/Password ยืนยันตัวตนสำเร็จเท่านั้น ตาม Rules ที่กำหนดไว้ใน `firebase-database.rules.json` ห้ามเปิด Anonymous Authentication เป็นทางเลือกสำรอง

ปุ่มบันทึกการตั้งค่าเลือกตั้งจะรอการยืนยันการเขียนจาก Firebase ก่อนแสดงผลสำเร็จ หากสิทธิ์หรือการเชื่อมต่อมีปัญหา ระบบจะแสดงข้อความที่ระบุสาเหตุแทนการแจ้งว่าบันทึกสำเร็จผิดพลาด

คะแนนเลือกตั้งใหม่ถูกจัดเก็บแยกเป็นรายการต่อคนที่ `sites/phanuang/electionVotes/{electionId}/{studentId}` แทน JSON ก้อนเดียวใน `state` จึงไม่มีการอัปโหลดคะแนนเก่าทั้งหมดหรือเขียนทับกันเมื่อหลายคนลงคะแนนพร้อมกัน หน้าแอดมินฟัง path นี้แบบ Realtime โดยตรง และ Console จะแสดง `[Vote] click`, `[Vote] write start`, `[Vote] write success` และ `[Admin] snapshot received` พร้อม `performanceNow` เพื่อวัดเวลาจริงของแต่ละช่วง

สถานะ Database และสิทธิ์ผู้ดูแลแยกออกจากกัน: Database เป็น `LIVE/OFFLINE` จาก `/.info/connected`; Admin permission เป็น `READ ONLY/ADMIN WRITE` จาก Firebase Auth. การอ่านข้อมูลไม่ต้องรอ Admin Auth เสมอ

หากยังเห็น `permission_denied` ให้ตรวจสอบว่ากด Publish Rules แล้ว และบัญชีที่ใช้หน้าแอดมินมีอยู่จริงใน Firebase Authentication. Console จะมี log สำหรับ config, listener, connection, snapshot, persistence, auth state และ error code เพื่อช่วยตรวจสอบปัญหาบนอุปกรณ์ iPhone/iPad ด้วย
