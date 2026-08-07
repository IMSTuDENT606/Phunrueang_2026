# ตั้งค่า Firebase สำหรับเว็บพันเรือง

1. สร้างหรือเลือกโปรเจกต์ใน Firebase Console แล้วเพิ่ม **Web app**
2. เปิด **Realtime Database** และเลือกตำแหน่งฐานข้อมูล
3. เปิด **Authentication → Sign-in method → Anonymous** เพราะเว็บไซต์แบบ static นี้ใช้บัญชีนิรนามเพื่อให้ Firebase Rules แยกคำขอที่ไม่ได้ยืนยันตัวตนออกได้
4. คัดลอกค่า Web configuration ไปแทนค่า `PASTE_...` ใน [firebase-config.js](firebase-config.js)
5. ใน Realtime Database → Rules ให้วางเนื้อหาจาก [firebase-database.rules.json](firebase-database.rules.json) แล้ว Publish
6. Deploy ทั้ง `index.html`, `app.js`, `firebase-config.js` และไฟล์อื่น ๆ ใหม่พร้อมกัน

ข้อมูลที่หน้าแอดมินแก้ไขจะอยู่ใต้ `sites/phanuang/state` และทุกแท็บที่เปิดเว็บอยู่จะรับการอัปเดตแบบเรียลไทม์ โดยข้อมูลเก่าที่อยู่ในเบราว์เซอร์จะถูกย้ายขึ้น Firebase ครั้งแรกที่เชื่อมต่อกับฐานข้อมูลว่าง

ข้อควรทราบ: กฎตัวอย่างช่วยกันผู้ที่ยังไม่ได้ผ่าน Firebase Anonymous Auth แต่ยังไม่ใช่ระบบสิทธิ์แอดมินแบบสมบูรณ์ เพราะหน้าแอดมินปัจจุบันใช้รหัสผ่านฝั่งเบราว์เซอร์เท่านั้น หากเปิดใช้งานจริง ควรเปลี่ยนผู้ดูแลเป็น Firebase Authentication และกำหนด custom claims ก่อนเปิดสิทธิ์เขียนเฉพาะแอดมิน
