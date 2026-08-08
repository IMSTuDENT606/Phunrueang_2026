const $ = (selector) => document.querySelector(selector);
const pages = ['home', 'members', 'room-login', 'classroom-113', 'classroom-13', 'classroom-21', 'classroom-25', 'classroom-36', 'classroom-38', 'classroom-42', 'classroom-43', 'classroom-511', 'classroom-512', 'classroom-64', 'classroom-65', 'election', 'shop', 'admin', 'gallery', 'sports'];
let selectedCandidate = null;
let classroomAnimationObserver = null;

/* Firebase Realtime Database bridge -------------------------------------------------
 * Existing UI code can keep using localStorage synchronously, while every shared key
 * is mirrored to Firebase and changes made by another device update this local cache.
 */
const FIREBASE_SHARED_KEYS = new Set([
  'phanuang-committee-members', 'phanuang-election-config', 'phanuang-election-votes',
  'phanuang-access-directory',
  'phanuang-store-products', 'phanuang-store-lookbook-config', 'phanuang-orders',
  'phanuang-gallery', 'phanuang-attendance-sessions', 'phanuang-attendance-records',
  'phanuang-attendance-config', 'phanuang-sports-results-v1'
]);
const isFirebaseSharedKey = (key) => FIREBASE_SHARED_KEYS.has(String(key)) || String(key).startsWith('phanuang-store-media-');
const firebaseKey = (key) => encodeURIComponent(String(key));
let firebaseReady = false;
let firebaseApplyingRemote = false;
let firebaseReadSnapshotReceived = false;
let firebaseAuthUser = null;
let firebaseSyncRoot = null;
let firebaseConnectionState = 'OFFLINE';
let firebaseConnectionDetail = '';
let firebaseAdminPermission = 'READ ONLY';
let firebaseAuthPersistenceReady = Promise.resolve();
const firebaseMemoryStorage = new Map();
function setFirebaseConnectionState(state, error = '') {
  firebaseConnectionState = state;
  firebaseConnectionDetail = error?.code || error?.message || String(error || '');
  document.documentElement.dataset.firebaseState = state === 'LIVE' ? 'connected' : 'offline';
  console[state === 'LIVE' ? 'info' : 'warn'](`[Firebase] database ${state}`, error);
  if (document.querySelector('.page.active')?.id === 'admin') window.setTimeout(renderAdmin, 0);
}
function firebaseConfigured(config) {
  return Boolean(config && config.apiKey && config.databaseURL && config.projectId) && !Object.values(config).some((value) => String(value).includes('PASTE_YOUR_'));
}
function refreshRemoteViews() {
  const active = document.querySelector('.page.active')?.id;
  if (active === 'members') void renderCommitteeMembers(true);
  if (active === 'election') renderElection();
  if (active === 'shop') void renderShop();
  if (active === 'gallery') renderGalleryPage();
  if (active === 'sports') renderSportsPage();
  if (active === 'admin') renderAdmin();
}
async function configureFirebaseAuthPersistence(auth) {
  const persistence = firebase.auth.Auth.Persistence;
  try {
    await auth.setPersistence(persistence.LOCAL);
    console.info('[Auth] persistence local');
    return 'LOCAL';
  } catch (localError) {
    console.warn('[Auth] persistence fallback', { from: 'LOCAL', to: 'SESSION', code: localError?.code, message: localError?.message });
    try {
      await auth.setPersistence(persistence.SESSION);
      return 'SESSION';
    } catch (sessionError) {
      console.warn('[Auth] persistence fallback', { from: 'SESSION', to: 'NONE', code: sessionError?.code, message: sessionError?.message });
      await auth.setPersistence(persistence.NONE);
      return 'NONE';
    }
  }
}
function waitForFirebaseAuthUser(auth, expectedUid) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const timeout = window.setTimeout(() => {
      settled = true;
      unsubscribe();
      reject(Object.assign(new Error('Firebase auth state did not provide a user'), { code: 'auth/state-timeout' }));
    }, 10000);
    unsubscribe = auth.onAuthStateChanged((user) => {
      if (!user || user.uid !== expectedUid) return;
      settled = true;
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(user);
    }, (error) => { window.clearTimeout(timeout); reject(error); });
    if (settled) unsubscribe();
  });
}
async function startFirebaseSync() {
  const config = window.FIREBASE_CONFIG;
  if (!window.firebase || !firebaseConfigured(config)) {
    setFirebaseConnectionState('OFFLINE', 'Firebase config or compat SDK is unavailable');
    return;
  }
  try {
    if (!firebase.apps.length) firebase.initializeApp(config);
    const siteId = String(window.FIREBASE_SITE_ID || 'phanuang');
    console.info('[Firebase] initialized', { projectId: config.projectId, databaseURL: config.databaseURL, siteId });
    const database = firebase.database();
    const root = database.ref(`sites/${siteId}/state`);
    firebaseSyncRoot = root;
    const auth = firebase.auth();
    firebaseAuthPersistenceReady = configureFirebaseAuthPersistence(auth);
    auth.onAuthStateChanged((user) => {
      firebaseAuthUser = user || null;
      firebaseAdminPermission = user ? 'ADMIN WRITE' : 'READ ONLY';
      console.info('[Auth] auth state user UID/email', user ? { uid: user.uid, email: user.email || null } : { user: null });
      if (document.querySelector('.page.active')?.id === 'admin') window.setTimeout(renderAdmin, 0);
    });
    database.ref('.info/connected').on('value', (snapshot) => {
      const connected = snapshot.val() === true;
      console.info(`[Firebase] connected ${connected}`);
      setFirebaseConnectionState(connected ? 'LIVE' : 'OFFLINE', connected ? '' : 'Realtime Database disconnected');
    }, (error) => { console.error('[Firebase] connected status error', error?.code, error?.message); });
    const nativeSet = Storage.prototype.setItem;
    const nativeRemove = Storage.prototype.removeItem;
    const nativeGet = Storage.prototype.getItem;
    const safeKeys = () => { try { return Object.keys(localStorage); } catch (error) { console.warn('[Firebase] localStorage keys unavailable', error?.name, error?.message); return [...firebaseMemoryStorage.keys()]; } };
    const write = (key, value) => {
      if (!firebaseAuthUser) { console.warn('[Firebase] write blocked: no authenticated admin', { key }); return Promise.resolve(); }
      return root.child(firebaseKey(key)).set({ value: String(value), updatedAt: firebase.database.ServerValue.TIMESTAMP })
        .catch((error) => { console.error('[Firebase] write error', error?.code, error?.message); });
    };
    const remove = (key) => {
      if (!firebaseAuthUser) { console.warn('[Firebase] remove blocked: no authenticated admin', { key }); return Promise.resolve(); }
      return root.child(firebaseKey(key)).remove()
        .catch((error) => { console.error('[Firebase] remove error', error?.code, error?.message); });
    };
    Storage.prototype.getItem = function(key) {
      try { return nativeGet.call(this, key); }
      catch (error) { console.warn('[Firebase] localStorage read fallback', error?.name, error?.message); return firebaseMemoryStorage.get(String(key)) || null; }
    };
    Storage.prototype.setItem = function(key, value) {
      if (this === localStorage && isFirebaseSharedKey(key) && firebaseReadSnapshotReceived && !firebaseApplyingRemote && !firebaseAuthUser) {
        console.warn('[Firebase] local write ignored: authenticated admin required', { key: String(key) });
        return;
      }
      try { nativeSet.call(this, key, value); } catch (error) { firebaseMemoryStorage.set(String(key), String(value)); console.warn('[Firebase] localStorage write fallback', error?.name, error?.message); }
      if (this === localStorage && !firebaseApplyingRemote && isFirebaseSharedKey(key)) {
        if (firebaseReady && firebaseAuthUser) write(key, value);
      }
    };
    Storage.prototype.removeItem = function(key) {
      if (this === localStorage && isFirebaseSharedKey(key) && firebaseReadSnapshotReceived && !firebaseApplyingRemote && !firebaseAuthUser) {
        console.warn('[Firebase] local remove ignored: authenticated admin required', { key: String(key) });
        return;
      }
      try { nativeRemove.call(this, key); } catch (error) { firebaseMemoryStorage.delete(String(key)); console.warn('[Firebase] localStorage remove fallback', error?.name, error?.message); }
      if (this === localStorage && !firebaseApplyingRemote && isFirebaseSharedKey(key)) {
        if (firebaseReady && firebaseAuthUser) remove(key);
      }
    };
    console.info('[Firebase] database listener attached', { path: root.toString() });
    root.on('value', (snapshot) => {
      const cloud = snapshot.val() || {};
      const currentCloudKeys = new Set(Object.keys(cloud).map(decodeURIComponent));
      console.info('[Firebase] snapshot received', { exists: snapshot.exists(), keyCount: currentCloudKeys.size });
      console.info('[Firebase] snapshot keys', [...currentCloudKeys]);
      firebaseApplyingRemote = true;
      try {
        safeKeys().filter(isFirebaseSharedKey).forEach((key) => { if (!currentCloudKeys.has(key)) { firebaseMemoryStorage.delete(key); try { nativeRemove.call(localStorage, key); } catch (_) {} } });
        Object.entries(cloud).forEach(([encodedKey, record]) => {
          const key = decodeURIComponent(encodedKey);
          if (record && typeof record.value === 'string') { firebaseMemoryStorage.set(key, record.value); try { nativeSet.call(localStorage, key, record.value); } catch (_) {} }
        });
      } finally { firebaseApplyingRemote = false; }
      firebaseReadSnapshotReceived = true;
      firebaseReady = true;
      window.dispatchEvent(new Event('phanuang-firebase-sync'));
      window.setTimeout(() => { refreshRemoteViews(); console.info('[Firebase] UI rendered from remote snapshot'); }, 0);
    }, (error) => { console.error('[Firebase] database listener error', error?.code, error?.message); setFirebaseConnectionState('OFFLINE', error); });
  } catch (error) {
    console.error('[Firebase] initialization error', error?.code, error?.message);
    setFirebaseConnectionState('OFFLINE', error);
  }
}
startFirebaseSync();

// One themed dialog system replaces browser alerts/confirms across every module.
let themedDialogReplay = false;
function currentDialogTheme(trigger) {
  const activeAdminTab=document.querySelector('.admin-tab.active')?.dataset.adminTab;
  if (trigger?.closest('.sports-admin') || document.body.classList.contains('sports-mode')) return 'sports';
  if (trigger?.closest('.attendance-panel,.attendance-history-panel,.attendance-history-empty')) return 'attendance';
  if (trigger?.closest('.gallery-admin-panel') || trigger?.classList.contains('gallery-image-delete')) return 'gallery';
  if (trigger?.closest('.store-admin') || trigger?.classList.contains('store-delete')) return 'store';
  if (trigger?.closest('.member-admin')) return 'members';
  if (trigger?.closest('.election-admin')) return 'election';
  if (!trigger && activeAdminTab==='sports') return 'sports';
  if (!trigger && ['attendance','attendance-history'].includes(activeAdminTab)) return 'attendance';
  if (!trigger && activeAdminTab==='photos') return 'gallery';
  if (!trigger && activeAdminTab==='store') return 'store';
  if (!trigger && activeAdminTab==='members') return 'members';
  if (!trigger && activeAdminTab==='election') return 'election';
  return 'admin';
}
function dialogThemeCopy(theme) {
  return {
    sports:{icon:'🏆',eyebrow:'ARENA DECISION',title:'ยืนยันคำสั่งจากสนาม'},
    attendance:{icon:'✓',eyebrow:'ATTENDANCE CONTROL',title:'ตรวจสอบก่อนดำเนินการ'},
    gallery:{icon:'◫',eyebrow:'GALLERY ARCHIVE',title:'จัดการรูปภาพกิจกรรม'},
    members:{icon:'♙',eyebrow:'MEMBER DIRECTORY',title:'จัดการข้อมูลสมาชิก'},
    election:{icon:'✦',eyebrow:'ELECTION COMMAND',title:'ยืนยันการเปลี่ยนแปลง'},
    store:{icon:'◆',eyebrow:'STORE MANAGER',title:'จัดการสินค้าหน้าร้าน'},
    admin:{icon:'◆',eyebrow:'PHUNRUEANG CONTROL',title:'ข้อความจากระบบ'}
  }[theme];
}
function showSiteDialog({message,title,theme=currentDialogTheme(),confirm=false,danger=false,confirmText='ตกลง'}) {
  return new Promise((resolve) => {
    const copy=dialogThemeCopy(theme), dialog=document.createElement('dialog');
    dialog.className=`site-dialog theme-${theme} ${danger?'is-danger':''}`;
    dialog.innerHTML=`<div class="site-dialog-orbit" aria-hidden="true"><i></i><i></i><i></i></div><div class="site-dialog-icon">${copy.icon}</div><small>${copy.eyebrow}</small><h3>${escapeHTML(title||copy.title)}</h3><p>${escapeHTML(String(message))}</p><div class="site-dialog-actions">${confirm?'<button type="button" class="dialog-cancel">ยกเลิก</button>':''}<button type="button" class="dialog-confirm">${escapeHTML(confirmText)}</button></div>`;
    document.body.appendChild(dialog);
    const finish=(answer)=>{ dialog.classList.add('is-closing'); window.setTimeout(()=>{dialog.close();dialog.remove();resolve(answer);},180); };
    dialog.querySelector('.dialog-confirm').addEventListener('click',()=>finish(true));
    dialog.querySelector('.dialog-cancel')?.addEventListener('click',()=>finish(false));
    dialog.addEventListener('cancel',(event)=>{event.preventDefault();finish(false);},{once:true});
    dialog.addEventListener('click',(event)=>{if(event.target===dialog&&confirm)finish(false);});
    dialog.showModal(); window.setTimeout(()=>dialog.classList.add('is-open'),20);
  });
}
function siteAlert(message, options={}) { return showSiteDialog({...options,message}); }
function siteConfirm(message, options={}) { return showSiteDialog({...options,message,confirm:true,danger:options.danger!==false,confirmText:options.confirmText||'ยืนยัน'}); }
window.alert=(message)=>{ void siteAlert(message); };
const nativeConfirm=window.confirm.bind(window);
window.confirm=(message)=>themedDialogReplay ? true : nativeConfirm(message);

document.addEventListener('click', async (event) => {
  const button=event.target.closest('.gallery-image-delete,.member-delete,.candidate-remove,.store-delete,.store-media-clear,[data-remove-match],[data-delete],#deleteAttendanceSession,#resetAttendanceHistory');
  if (!button || themedDialogReplay) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const theme=currentDialogTheme(button); let message='รายการนี้จะถูกลบออกจากระบบ'; let title; let confirmText='ลบรายการ';
  if (button.matches('.gallery-image-delete')) { title='ลบรูปภาพนี้หรือไม่?'; message=`รูปที่ ${Number(button.dataset.imageIndex)+1} จะถูกนำออกจากผนังรูปภาพกิจกรรม`; confirmText='ลบรูปภาพ'; }
  else if (button.matches('.member-delete')) { title='ลบสมาชิกหรือไม่?'; message=`ข้อมูลของ ${button.closest('.member-editor-row')?.querySelector('.member-name')?.value||'สมาชิกคนนี้'} จะถูกนำออกจากรายการ`; confirmText='ลบสมาชิก'; }
  else if (button.matches('.candidate-remove')) { title='ลบผู้สมัครหรือไม่?'; message=`ผู้สมัคร ${button.closest('.candidate-editor-row')?.querySelector('.candidate-name-input')?.value||'รายการนี้'} จะถูกนำออกจากการตั้งค่า`; confirmText='ลบผู้สมัคร'; }
  else if (button.matches('.store-delete')) { title='นำสินค้านี้ออกจากร้านหรือไม่?'; message=`${button.closest('.store-editor')?.querySelector('[data-field="name"]')?.value||'สินค้านี้'} จะถูกลบออกจากรายการจัดการร้านค้า`; confirmText='ลบสินค้า'; }
  else if (button.matches('.store-media-clear')) { title='ล้างไฟล์สื่อทั้งหมดหรือไม่?'; message=`รูปสินค้า วิดีโอ สไลด์ Finish Look และค่าจัดวางของ ${button.closest('.store-editor')?.querySelector('[data-field="name"]')?.value||'สินค้านี้'} จะถูกล้างทั้งหมด`; confirmText='ล้างไฟล์ทั้งหมด'; }
  else if (button.matches('[data-remove-match]')) { title='ลบคู่แข่งขันหรือไม่?'; message='คะแนน ทีมที่แข่งขัน และผลผู้ชนะของคู่นี้จะถูกนำออก'; confirmText='ลบคู่แข่งขัน'; }
  else if (button.matches('[data-delete]')) { title='ลบชนิดกีฬาหรือไม่?'; message=`${button.closest('.sport-editor')?.querySelector('[data-field="name"]')?.value||'กีฬานี้'} และผลการแข่งขันทุกคู่จะถูกลบ`; confirmText='ลบกีฬา'; }
  else if (button.id==='deleteAttendanceSession') { title='ลบรอบเช็คชื่อนี้หรือไม่?'; message='เวลาและผลเช็คชื่อทุกที่นั่งของรอบที่เลือกจะถูกลบ'; confirmText='ลบรอบนี้'; }
  else if (button.id==='resetAttendanceHistory') { title='รีเซ็ตประวัติทั้งหมดหรือไม่?'; message='รอบ เวลา และผลเช็คชื่อทั้งหมดจะถูกลบและไม่สามารถย้อนกลับได้'; confirmText='รีเซ็ตทั้งหมด'; }
  if (await siteConfirm(message,{theme,title,confirmText})) { themedDialogReplay=true; button.click(); themedDialogReplay=false; }
},true);

document.addEventListener('click',(event)=>{const button=event.target.closest('#backToStoreFromReceipt');if(!button)return;event.preventDefault();event.stopImmediatePropagation();const dialog=button.closest('.receipt-dialog');if(!dialog||dialog.classList.contains('receipt-tearing'))return;dialog.classList.add('receipt-tearing');window.setTimeout(()=>{dialog.classList.remove('open');window.setTimeout(()=>{dialog.close();dialog.remove();$('#shopContent')?.scrollIntoView({behavior:'smooth',block:'start'});},180);},950);},true);

const classroom113 = {
  room: '1/13',
  advisors: [
    { name: 'ครูทิวทอง อ่อนบาง', order: 'ครูที่ปรึกษา', image: 'assets/members/advisor-thiwthong-113-cutout.png' },
  ],
  students: [
    ['1','47728','จิรณัฐ ซื่อสัตย์','—'],['2','47729','ธวัชชัย สุกันทา','บิ๊ก'],
    ['3','47730','นภัทร โพธิ์ทอง','—'],['4','47731','ปวรปรัชญ์ ศอกกำปัง','นดล'],
    ['5','47732','พุฒิภัทร มีศรี','พีค'],['6','47733','วรเมธ กรีคงคา','เฟส'],
    ['7','47734','วรากร เปล่งศรีงาม','เจ้านาย'],['8','47735','ศิวกร พูลยิ้ม','—'],
    ['9','47736','ศุภวิชญ์ ม่วงกล่ำ','ไตตั้น'],['10','47737','เศรษฐพงศ์ ชัชพิสิฐพงษ์','ปังปอนด์'],
    ['11','47738','สิทธิโชค สมอยู่','เหม่ง'],['12','47739','อดุลวิทย์ สุวรรณรังษี','—'],
    ['13','47740','อนุภัทร ผมงาม','—'],['14','47741','กชกร แสงอรุณ','ครีม'],
    ['15','47742','กัญญาณัฐ มาดี','เอ๋ย'],['16','47743','กัญญาภัค บุญเริ่ม','—'],
    ['17','47744','กาญจน์สิตา ท่าสละ','วันใหม่'],['18','47745','จรัญพร ยี่สุ่น','—'],
    ['19','47746','จารุวรี จิตร์บำรุง','—'],['20','47747','ชนัญชิดา นวนแตง','อิวดาว'],
    ['21','47748','ชนิสษา ศรีรัตนพร','ยี่หวา'],['22','47749','ฐิตาพร วรรณทอง','แพรว'],
    ['23','47750','ณัฐณิชาพร ปิ่นทอง','ลูกหมี'],['24','47751','ณัฐธิดา อินทรัต','พั้นซ์'],
    ['25','47752','ติยาภัทร แก่นเสน','ปลื้ม'],['26','47753','ธนิกา เสนสุกรี','—'],
    ['27','47754','นราภรณ์ พูลเพิ่ม','กรีน'],['28','47755','นันทนัช บุญมาก','ใหม่'],
    ['29','47756','นิยตา สุขทน','—'],['30','47757','พัชรพร แซ่อุ่ย','—'],
    ['31','47758','พิชชาพร ม่วงงาม','เพลง'],['32','47759','พิชชาอร นุตร์วงศ์','—'],
    ['33','47760','พิชญา ประสิทธิ์','ญา'],['34','47761','ภัทรมนต์ เอี่ยมสม','ครีม'],
    ['35','47762','ภูรธิดาพร บุญมา','—'],['36','47763','ลักษิกา ผิวอ่อน','มิน'],
    ['37','47764','วีราญา อนุรัตน์','ซาเดีย'],['38','47765','สุธีธิตา แก้วกสิกิจ','—'],
    ['39','47766','สู่ขวัญ สาระบูรณ์','—'],['40','47767','อภิญญา มากเปี่ยม','—'],
  ],
};

const classroom13 = {
  room: '1/3',
  advisors: [
    { name: 'ครูฤชานนท์ อินอ่วม', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-ruechanon-13.jpg' },
    { name: 'ครูสุกัญญา คุ้ยทรัพย์', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-sukanya-13.jpg' },
  ],
  students: [
    ['1','47338','กรณพัฒน์ ชะตารัมย์','—'],['2','47339','ก่อบุญ มงคลณภัทร์','—'],
    ['3','47340','ณัฐชนน แก่นแก้ว','นนนี่/นาเดีย'],['4','47341','ติณณภพ อันสังหาร','นะโม'],
    ['5','47342','ธนวัฒน์ เลี้ยงรักษา','—'],['6','47343','ธนัช หลุมลึก','—'],
    ['7','47344','ธัญวุฒิ ทองสาม','เกล้า'],['8','47345','ปพณธีร์ รอดมีฤทธิ์','เส้นใหญ่'],
    ['9','47346','พชร หมื่นท่อง','คิม'],['10','47347','ภูมิพัฒน์ มั่งทอง','—'],
    ['11','47348','วงศธร สุขทวี','—'],['12','47349','ศิวกร แนบบุญ','ปุล'],
    ['13','47350','อชิระ สันติพูนพงศ์','—'],['14','47351','อาณุวัฒน์ วัดเมือง','น้ำ-ต้นน้ำ'],
    ['15','47352','กัญจนา จิตบำรุง','แตงกวา'],['16','47353','กัญญาพัชร หอมเนียม','มะปราง'],
    ['17','47354','กาญจนา พุ่มคำ','—'],['18','47355','ชญาดา สะกะมณี','ธันวา'],
    ['19','47356','ชวัลกร อาวรณ์','ซิน'],['20','47357','ณัฏฐิ์ธนิสต์ ไม้เลี้ยง','มะนาว'],
    ['21','47358','ณิชนันท์ พวกอิ่ม','—'],['22','47359','ธนาภา แสงดาว','กิ๊ฟ'],
    ['23','47360','ธัญจิรา ท้าวศิริกุล','—'],['24','47361','นภัสนันท์ ธนาโรจน์ปิติพร','ออกัส'],
    ['25','47362','นัทร์ชนัน  เพ็งแย้ม','ออแกรนด์'],['26','47363','ปัณณพร บุญหนุน','ปันปัน'],
    ['27','47364','พรปวีณ์ เกษี','ใบเฟิร์น'],['28','47365','วราวรรณ คุ้มครอง','โมบาย'],
    ['29','47366','ศิริอักษร แสนพันธ์','—'],['30','47367','อัยยา โพธิ์วิฑูรย์','ไอโฟน'],
  ],
};

const classroom21 = {
  room: '2/1',
  advisors: [
    { name: 'ครูดลยา ศรีทองดี', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-dolaya-21.jpg' },
    { name: 'ครูเวณิศ ธนาทรัพย์วิบูรณ์', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-wanit-21.jpg' },
  ],
  students: [
    ['1','46687','เกียรติศักดิ์ ภัชสิงห์สูง','ปลื้ม'],['2','46688','จิรัฎฐ์ ทิมรอยแก้ว','ติวเตอร์'],
    ['3','46689','ชยังกูร เอี่ยมสำอาง','โชกุน'],['4','46690','ตะวันมา วงษ์นายะ','เปา'],
    ['5','46691','นิพพิชฌน์ รังษีโรจน์สมบัติ','—'],['6','46692','ปัณณทัต ปิ่นมณี','—'],
    ['7','46693','พีราวะศุตม์ พันธ์ศิริ','ติวเตอร์'],['8','46694','ภคพล ศรีทรง','—'],
    ['9','46695','ภควัฒน์ ภู่งาม','พลีส'],['10','46696','ภัคดลธร หาญพานิช','ชิริว'],
    ['11','46697','ภูธีรัช อินทสโร','—'],['12','46698','ภูมิพัฒน์ ปิ่นแก้ว','ภู'],
    ['13','46699','ภูสิษฐ์ นินทะ','พูม'],['14','46700','ศตคุณ ศริพันธุ์','ตะวัน'],
    ['15','46701','สกลวรรธน์ พูลทรัพย์','—'],['16','46702','สุชลิตพงษ์ วรรณกุล','เจเเปน'],
    ['17','46703','อภิชัย ยอดเงิน','ทิคเกอร์'],['18','46704','อัฐพัฒน์ บุญชู','มาติน'],
    ['19','46705','อินทัช อินเอก','เจเดย์'],['20','46706','กนกวรรณ เพาะปลูก','ออม'],
    ['21','46707','กัญญาภัคศิณาธิ์ พิวัฒนวาชัยพร','หนูดี'],['22','46708','เขมิกา รัตนจันทร์','ไอโฟน'],
    ['23','46709','ชุติกานต์ เพ็ชร์นิล','ต้นข้าว'],['24','46710','ฐิรญาดา ศรีดี','เฌอแตม'],
    ['25','46711','ธัญญาภัทร บุญทอง','ซีน'],['26','46712','นิสา เทียนงาม','การ์ตูน'],
    ['27','46713','ปุณณดา นิติกุล','—'],['28','46714','พอฤทัย ใจชอบ','—'],
    ['29','46715','พัชรพรรณ ธนสารสมบัติ','ไบร์ท'],['30','46716','พิชญาวี วงษ์พจนี','วีวี่'],
  ],
};

const classroom25 = {
  room: '2/5',
  advisors: [
    { name: 'ว่าที่ร้อยตรีนิพนธ์ เทียนทอง', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-niphon-25-web.jpg' },
    { name: 'ครูอุดมศักดิ์ วัชระ', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-udomsak-25-web.jpg' },
  ],
  students: [
    ['1','46816','กวินท์ บุญยอย','—'],['2','46817','กัณภัทร ซื่อแท้','ออกัส'],
    ['3','46818','คเชนทร์ จิ๋วจู','คเชนทร์'],['4','46820','จิรดนัย บุญย้าย','—'],
    ['5','46821','ชัยภัทร บุญเลิศ','—'],['6','46822','ณัชพล จันทะคา','บอส'],
    ['7','46823','ณัฐชนน ทองทา','เฟรม'],['8','46824','ธนกฤต ธนสารพงศา','—'],
    ['9','46825','ธีรภัทร เรืองศรี','พีพี'],['10','46826','นนทพัทธ์ มาการ์วแลน','—'],
    ['11','46827','ภาณุพงศ์ นาคสุข','นอท'],['12','46828','สิทธวีร์ สุขี','เฟรม'],
    ['13','46829','สิรวิชญ์ ยงวนิช','—'],['14','46830','กวินธิดา แถวกิจการ','กอแก้ว'],
    ['15','46831','จารวี ศรีงาม','เพลง'],['16','46832','ฉัตรชนก เจียมสกุล','ม่วนใจ๋'],
    ['17','46833','ชญมญช์ สังขวร','เกี้ยว'],['18','46834','ชนม์จันทร์ ศรีพยัคฆ์','—'],
    ['19','46835','ชัญญิกา เพ็งพัฒ','เนย'],['20','46836','ณภัทศร นาคพุ่ม','เฟส'],
    ['21','46837','ณัชชากัญญ์ พำนัก','—'],['22','46838','ณัฐณิชา กล้าหาญ','—'],
    ['23','46839','ทาริกา อยู่ยง','สเจล'],['24','46840','ธนพร ช่างหล่อ','แพร'],
    ['25','46841','ธิดารัตน์ อ่อนมี','แป้ง'],['26','46842','นพรดา อินอ่อน','เฟย์'],
    ['27','46843','นิตยนันท์ ชีวะพานิชย์','ลูกปัด'],['28','46844','บุณยนุช บุญธิติ','บุณบุญ'],
    ['29','46845','ปวีณา พลอยนัด','ออม'],['30','46846','พัทธนันท์ ทรงประไพ','—'],
    ['31','46847','ภัทรธิดา สุขพัทธี','เนสท์'],['32','46849','มีนานุช เดชอยู่','มีน'],
    ['33','46850','รัญชนา วงศ์ไทย','อาย'],['34','46851','วาริ คุ้มสว่าง','น้ำขิง'],
    ['35','46852','วิภาณี ยิ่งยง','—'],['36','46853','สุวภัทร บุญผาสุข','ใบบัว'],
    ['37','46854','สุวภัทร บุญมี','น้ำหนึ่ง'],['38','46855','อุรัสยา เขียวรอด','อิ่มเอม'],
    ['39','46931','รัตนาพร เขียวรี','ฝ้าย'],['40','46954','ญาณิศา โพธิสาร','น้ำตาล'],
  ],
};

const classroom42 = {
  room: '4/2',
  advisors: [
    { name: 'ครูฆ้องชัย คงดี', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-khongchai-42.jpg' },
    { name: 'ครูวรรณวิภา สุรเมธสกุล', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-wanwipa-42.jpg' },
  ],
  students: [
    ['1','45530','ปัญณพงศ์ วารีญาติ','กัปตัน'],['2','45554','กานต์นิธิ กันทิม','—'],
    ['3','45585','กันต์กวี สอดสี','เบลล์'],['4','45592','ปณิธาน ทัพกฤษณ์','สตังค์'],
    ['5','45594','ภูริวัฒ กลับทอง','ภู'],['6','45595','วสุวัฒน์ ธนาโรจน์ปิติพร','—'],
    ['7','45624','กรวิชญ์ หายทุกข์','เเซน'],['8','45626','จิรพัทธิ์ นุวรรณ์โน','นาย'],
    ['9','45628','ฑีณพัฒน์ เสมอพันธ์','—'],['10','45636','นพเก้า คำปลอม','—'],
    ['11','45641','ภูดิศ ตั้งธงชัยวิริยะ','ดีดี'],['12','45642','ภูบดี ชาดวง','—'],
    ['13','45645','วิศรุต โสจะยะพันธ์','—'],['14','45648','ศิวกร จันวัต','มิกซ์'],
    ['15','45649','สุธินันท์ ฉาบแก้ว','—'],['16','45650','หิรัญกฤษฎิ์ ภู่ชัย','เบส'],
    ['17','45676','วริศ สุขเอี่ยม','เพิ่ม'],['18','45711','บุณยกร กุลหกุล','ออมสิน'],
    ['19','45869','ณัฏฐพล พุกาธร','ข้าวปั้น (นามแฝง เอเรน เยเกอร์)'],['20','45948','ณพวัฒน์ บุญงามทวีวงค์','ไนร์'],
    ['21','47772','กฤษดาภัทท์ คงแจ้ง','ธาม'],['22','47773','จิรภัทร ยุวะนิยม','มอส'],
    ['23','45569','ชัญญานุช ไวว่อง','ลูกปลา'],['24','45573','นรัชต์นัน รัชตะไพสิฐ','น้ำหนึ่ง'],
    ['25','45581','สัจจญาพร ช่วยเกิด','พอใจ'],['26','45603','จินต์จุฑา ทองนุ้ย','เหมย'],
    ['27','45609','นรมน มีพันธุ์','มะนาว'],['28','45610','นัชฬพร คำโต','นัช'],
    ['29','45651','จีรภา ชื่นจิตร์','—'],['30','45653','ณัชชานันท์ มีแฟง','ข้าวหอม'],
    ['31','45658','พันพัสสา พรหมผล','ซอฟท์'],['32','45700','เมญาวรรณ เมืองช้าง','—'],
    ['33','45703','สลิลดา อยู่ทรัพย์','แก้ม'],['34','45723','ชนิภรณ์ ธูปหอม','พลอย'],
    ['35','45726','ณัฐจิรา วารีรัตน์','แบม'],['36','45776','พลอยภคพร ศิลปโชติ','พลอย'],
    ['37','45778','แพรวา นาคสิงห์','โฟกัส'],['38','45862','อัยยดา พานทอง','อัย'],
    ['39','47774','ศุภิสรา มณฑา','—'],['40','47775','สุภัสสรา อ่อนนาค','อุ๊บอิ๊บ'],
  ],
};

const classroom43 = {
  room: '4/3',
  advisors: [
    { name: 'ครูอรุณศรี ศรีชัย', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-arunsri-43-web.jpg' },
    { name: 'ครูพลกฤษณ์ เข็มเพ็ชร', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-phonlakrit-43-web.jpg' },
  ],
  students: [
    ['1','45534','วฤธ สุวัตธิกะ','นาย'],['2','45562','พีรพัฒน์ รอดโฉม','ติวเตอร์'],
    ['3','45677','วสันต์ สะทิ','เคอร์ฟิวส์'],['4','45707','ธนกร รัตนงาม','คิม'],
    ['5','45709','ธัญกร พืชพันธุ์','คิว'],['6','45801','หนึ่งเทพ อยู่เลี้ยง','—'],
    ['7','45953','ภัควัฒน์ แถวเพีย','บีม'],['8','45961','สายชล จันเมือง','ปัน'],
    ['9','45963','สุกฤษฎิ์ กรขำ','ปั๊ป'],['10','47776','กรวิชญ์ สุดประเสริฐ','บอส'],
    ['11','47777','ธนภัทร ฉิมเฉิน','มาเฟีย'],['12','47778','สัณหณัฐ สมดี','—'],
    ['13','47779','เสกสรรค์ จ่ายยัง','คูณ'],['14','45618','ภาพิมล เชตพันธุ์','พรีม'],
    ['15','45619','มนต์นภา เสนาะศัพท์','เอิร์น'],['16','45662','สรัลนุช รอดพันธุ์','เนย'],
    ['17','45688','ฐิติรัตน์ เพียรพานิช','อะตอม'],['18','45692','ธัมมจารี พลอยจันทร์กุล','เเพรว'],
    ['19','45695','ปานไพลิน ฤทธิ์สวัสดิ์','กานพลู'],['20','45696','พัชรมล ศรีบัวลา','ต้นหอม'],
    ['21','45698','พิชญาภรณ์ นาคน้ำ','ไอซ์'],['22','45765','กัญญารัตน์ ประจงดี','เนย'],
    ['23','45774','ปัทมาพร คนขำ','มิ้น'],['24','45851','ณัฏฐณิชา บุษราพิทักษานนท์','เมษา'],
    ['25','45861','อริศรา อินทร์โต','ออมสิน'],['26','45884','ขวัญชนก สอจันทึก','ลูกเกด'],
    ['27','45886','ณัฐณิชา อ่างทอง','—'],['28','45899','วริศรา ผิวละออ','มุ่ย'],
    ['29','45931','นัดทิดา จันทร์มา','จิว'],['30','45936','แพรวา พงษ์นารายณ์','แพรวา'],
    ['31','46003','ชรัณยภัทร์ พลละเอียด','ข้าวฟ่าง'],['32','46012','พิมพ์มาดา พุฒิสาร','เอย'],
    ['33','47780','ธัญรดา เกงขุนทด','เฟียส'],['34','47781','ปพิชญา ปฐมทศพร','หมิงเต้า'],
    ['35','47782','ปารมี วิเศษพงษ์','นิว'],['36','47783','ปาริชาติ สุวิมล','เนย'],
    ['37','47784','พรพิมล จันทะมาตร','เเป้ง'],['38','47785','วรารัตน์ อินทร์อุดม','ข้าวหอม'],
    ['39','47786','วิชญาดา โพธิ์ทอง','พ้อย'],['40','47787','อัจจิมา ปานทอง','ปาย'],
  ],
};

const classroom65 = {
  room: '6/5',
  advisors: [
    { name: 'ครูศิวพัฒน์ โพธิ์ศรี', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-siwapat.jpg' },
    { name: 'ครูสุพิชฌาย์ นาถศิริวรโชต', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-supitchaya.jpg' },
  ],
  students: [
    ['1','44311','นาย ธีรภัทร กาญจนสุนทร','พุก'],['2','44319','นาย นราธร เหมือนเอี่ยม','เอ็มเจ'],
    ['3','44322','นาย ภานุพงษ์ ระดับ','โอม'],['4','44406','นาย คณุตม์พงศ์ ถนอมสัตย์','เอิ้น'],
    ['5','44440','นาย กิตติภพ เสนาซิว','ทัศน์'],['6','44445','นาย ธีรภัทร พูลศรี','โอ๊ต'],
    ['7','44446','นาย ปัณณวรรธ ตั้งสถิตย์','นนทรี'],['8','44448','นาย ภูวดล ปิยะมิตร','นาย'],
    ['9','44479','นาย กานต์ สิทธิ์น้อย','กานต์'],['10','44480','นาย ชาญวิทย์ ชลวิบูลย์','นะโม'],
    ['11','44485','นาย ปาราเมศ หงษ์ทอง','แกรม'],['12','44599','นาย ชนะชัย เณรน้อย','ต้นน้ำ'],
    ['13','44688','นาย พรพิพัฒน์ นิ่มทอง','เฟิร์ส'],['14','44692','นาย มหาสมุทร ด่านสุขณรงค์','ซี'],
    ['15','44695','นาย วงศกร บัวสีตัน','บิ๊ก'],['16','44720','นาย ชนะพล ตรีสุวรรณศานต์','ภูมิ'],
    ['17','44769','นาย พงษ์นรินทร์ นุวรรณโณ','เปตอง'],['18','46613','นาย จริณรัตน์ สืบยุบล','กาย'],
    ['19','46614','นาย ณฐนนท์ เพ็ชรหิน','ไอซ์'],['20','46615','นาย นิมิต เทพอาษา','อาทิตย์'],
    ['21','44400','น.ส. สุพนิตา ประสายกา','อะตอม'],['22','44427','น.ส. พลอยชมพู สมสิงห์','พลอยมน'],
    ['23','44436','น.ส. อชิรญา พรอภิชาติกุล','อิ่มเอม'],['24','44455','น.ส. ญาณิศา ชมภูพาน','ต้นหลิว'],
    ['25','44456','น.ส. ฑิตญา บุญพึ่ง','ปิ๊ง'],['26','44464','น.ส. นฤกานต์ ร่มโพธิ์','มิ๊วค์'],
    ['27','44548','น.ส. ปาลิตา มาลา','จีน'],['28','44585','น.ส. ปิ่นเพชร แสงสวย','ปิ่น'],
    ['29','44586','น.ส. ปิยะธิดา แพทย์ราช','เมจิ'],['30','44624','น.ส. นภัส ยิ้มละมัย','พัด'],
    ['31','44629','น.ส. พิมพ์รภัทร เทียมทัน','แบม'],['32','44669','น.ส. มิชชา กังผึ้ง','พลอย'],
    ['33','44705','น.ส. ณัฏฐณิชา สกุลเดช','เฟรนด์'],['34','44793','น.ส. รพัสตาภรณ์ ทองนุ้ย','ไอซ์'],
    ['35','46616','น.ส. กานดา ชำนาญหมอ','เอม'],['36','46617','น.ส. จิราพร พุ่มกล่ำ','เบนซ์'],
    ['37','46618','น.ส. จิราวรรณ โพธิ์ขำ','กุ๊ก'],['38','46619','น.ส. ศิรภัสสร หนูสุวรรณ','ปาย'],
  ],
};

const classroom64 = {
  room: '6/4',
  advisors: [
    { name: 'ครูทรรศพร พิศรูป', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-tassaporn-64-web-v3.jpg' },
    { name: 'ครูนริศ ปืนแก้ว', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-naris-64-web-v3.jpg' },
  ],
  students: [
    ['1','44304','นายปิยพัชร์ กันโต','บอส'],['2','44334','ชัยพร จำนงค์หาญ','อั่งเปา'],
    ['3','44341','ภูเบศ เขตการณ์','โอม่อน'],['4','44346','สุวิจักขณ์ ภู่ชัย','เอส'],
    ['5','44447','พีรณัฐ เกตุสวาสดิ์','บลู'],['6','44766','ปัณณทัต วราโภ','เอิร์ท'],
    ['7','46611','ธนวัฒน์ มาลัย','ต้นปาล์ม'],['8','46612','ธีรเทพ ทองประเสริฐ','บอส'],
    ['9','44305','น.ส ลภัสรดา กวีวัจน์','สมายด์'],['10','44347','กมลฉัตร สุขทอง','พอเพียง'],
    ['11','44348','กฤตยา สินมา','ไอเดีย'],['12','44351','ชลิตา ชูสวัสดิ์','น้ำชา'],
    ['13','44352','โชติกา สะมะถะ','พลอย'],['14','44356','ปรีรติ ปานเพ็ชร์','เอิง'],
    ['15','44360','ภิญญดา สักการะ','แก้ม'],['16','44362','วรัญชลี เงินอยู่','เบลล์'],
    ['17','44363','นางสาวสุชาดา แผ่ทอง','จันทร์เจ้า'],['18','44415','น.ส.กรกนก เนตรแก้ว','น้ำขิง'],
    ['19','44418','ณภัทร เพ็ชรประสิทธิ์','ดรีม'],['20','44422','เบญญาดา วีระพงษ์','โบกัส'],
    ['21','44432','น.ส.มณิวรา วิทยา','น้ำว้า'],['22','44435','น.ส.สาริศา บัวคลี่','สอง'],
    ['23','44459','น.ส.ธนภร น้อยเจริญ','ว่าน'],['24','44461','ธัญญลักษณ์ กลิ่นเกษร','เกรซ'],
    ['25','44469','น.ส.ภัทรภร พุ่มคำ','เอย'],['26','44470','นางสาวภัทรวดี พุ่มพวง','แพรรี่'],
    ['27','44472','ฤทัยรัตน์ จันทร์เกษม','เป้ย'],['28','44496','น.ส.กันต์กนิษฐ์ สว่างบุญรอด','แก้ม'],
    ['29','44554','ศรัณย์พร ศรีประเสริฐ','อิ่มเอม'],['30','44614','กฤติมา ชื่นใจ','แพท'],
  ],
};
const classroom512 = {
  room: '5/12',
  advisors: [
    { name: 'ครูกุนที กลัดสุข', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-kuntee-512.jpg' },
    { name: 'ครูอรญา บุญไทย', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-oraya-512.jpg' },
  ],
  students: [
    ['1','45005','ณัฏฐ์ฐกรณ์ วงษ์สนธิ์','ปอล'],['2','45129','นรบดี อินทร์กลิ่นพันธ์','—'],
    ['3','45132','ภูวดล สุทธิสุข','พุธ'],['4','45139','อดิศร สมบูรณ์กุล','ฟ้า'],
    ['5','45161','กฤษณกัญจน์ หมวดรุ่ง','โตโน่'],['6','45209','ภูดิศพงศ์ อวิสุ','—'],
    ['7','45240','โกศล มีสมบัติ','—'],['8','45243','นวพล เปียโชติ','ปอนฮาวดี้'],
    ['9','45248','วสุธันย์ เกล็ดจีน','—'],['10','45250','สิริศักดิ์ จี๋คีรี','—'],
    ['11','45288','ภัทรดนัย บุญมาศ','ไกด์'],['12','45292','สรวิชญ์ เชาว์สุวรรณ์','คิว'],
    ['13','45362','ติณเตโช ศรีศาสตร์','ติณ'],['14','45370','รชต ทองวิลัย','ซัน'],
    ['15','47256','ฐิติกร พระวงศ์','นิค'],['16','47257','สามัญญลักษณ์ พันธ์ทา','เป๋าตังค์'],
    ['17','44947','มนต์นภา อำภา','น้ำหวาน'],['18','45154','พิชญากร ฟักเขียว','น้ำปิง'],
    ['19','45198','วันวิสา เกษอินทร์','เอิน'],['20','45217','จริญาภรณ์ กลัดงาม','การ์ตูน'],
    ['21','45220','นิชา นวลดอกไม้','เนย'],['22','45266','ธิดารัตน์ คงเจริญ','ตูน'],
    ['23','45273','วชิรญาณ์ ชื่นกลิ่น','อิ๊ง'],['24','45298','กัญญพัชร ชมภูนุช','พะแพง'],
    ['25','45341','แก้วใจ ศุภกำเนิด','—'],['26','45373','กมลชนก มหาพงษ์','ออมสิน'],
    ['27','45379','ณัฐณิชา รอดเจิม','เบล'],['28','45383','ฐปนรรต บัวโรย','ญาได๋'],
    ['29','45385','บัณฑิตา มงคลจักรวาฬ','นิ้ง'],['30','45389','พัชรธิดา เอี่ยมพัชรวุฒิ','เวนิส'],
    ['31','47259','กัญญารัตน์ ศรีสุพรรณ','เนย'],['32','47260','กัญญารัตน์ แก่นสาร','กีต้า'],
    ['33','47261','กัญญารัตน์ ทองอุ่น','อาย'],['34','47262','ขนิษฐา พรเณร','ยี่หวา'],
    ['35','47263','จิรวรรณ สบาย','—'],['36','47264','ปัณฑารีย์ ธูปนาค','ยิ้ม'],
  ],
};
const classroom511 = {
  room: '5/11',
  advisors: [
    { name: 'ครูสิริมาส ทองมาดี', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-sirimas-511-web.jpg' },
    { name: 'ครูโยทนัท สงวนโสม', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-yothanat-511-web.jpg' },
  ],
  students: [
    ['1','45126','ธนภัทร ปิ่นแก้ว','ไอซ์'],['2','45167','ธนวัฒน์ ใจเที่ยง','—'],
    ['3','45170','ศรราม เจียมจริต','—'],['4','45176','อลงกรณ์ เกษมสุข','นาย'],
    ['5','45246','รัชภูมิ อินทุมาน','—'],['6','45285','ณัฐพงษ์ บำรุง','—'],
    ['7','45320','กิตติคุณ พูลสุข','ต้า'],['8','45332','พรชัย นีละนะวก','—'],
    ['9','45337','รัชชานนท์ เพชรรักษ์','—'],['10','45338','รัชชาวัฒน์ เลิศศิริ','ซีม'],
    ['11','45367','นฤมิตร สุรินทะ','—'],['12','47238','กรองเกียรติ ทองฤทธิ์','ข้าวกล้อง'],
    ['13','47239','กิตติพงค์ ทองเอม','—'],['14','47240','ธนกต ศรีไพโรจน์','นนท์'],
    ['15','47241','ธนภัทร พุ่มพิศ','เวฟ'],['16','47242','ยศพร ศรีแข','—'],
    ['17','47243','รชต เงินเมือง','—'],['18','47244','วรวุฒิ ฉายชูวงษ์','คิว'],
    ['19','47275','ภูตะวัน ชะเอม','ตะวัน'],['20','45151','นุสรา วิพันธุ์เงิน','แก้ม'],
    ['21','45182','ชญาดา พูลจนะกิจ','—'],['22','45195','วรวรรณ เเย้มทับ','เตย'],
    ['23','45215','กัญญาภัทร ท้วมศรี','น้ำชา'],['24','45279','อภิสรา ศรีโตนด','ฟ้า'],
    ['25','45311','วรกานต์ พิกุลสด','มะปราง'],['26','45347','ฐิติกาญจน์ ช้วนสกุล','แป้ง'],
    ['27','45348','ณิชาการณ์ ไพรน้อย','ปราย'],['28','45396','สิริยา คามรักษ์','—'],
    ['29','46107','ชาลิสา หาญศิริชัย','เอย'],['30','47245','กชพรรณ ลีวรรณ์','—'],
    ['31','47246','กนกวรรณ นาคสุนทร','แนน'],['32','47247','ชานัญธิดา พฤทธิสาริกร','ครีม'],
    ['33','47248','ฐาปนีย์ สวนมะลิ','—'],['34','47249','ณัฏฐกมล กูลเสือ','—'],
    ['35','47250','บุญญาพร แสงสี','ปลายฟ้า'],['36','47251','ภัทรวดี ภูงาม','—'],
    ['37','47252','ลัลน์ญดา โอชา','ข้าว'],['38','47253','วรางคณา บรรพตาทิ','มาย'],
    ['39','47254','สุทธิกาญจน์ เป้าสุวรรณ์','ใบบุญ'],['40','47255','อนัญญา โตสกุล','ไข่มุก'],
  ],
};
const classroom38 = {
  room: '3/8',
  advisors: [
    { name: 'ครูธารญา ธยาน์ธนาธร', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-tharaya-38.jpg' },
    { name: 'ครูกมลวรรณ ทองชื่น', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-kamonwan-38.jpg' },
  ],
  students: [
    ['1','46359','ก้องภพ จรพันธ์ชู','ปัง'],['2','46360','จิตรภาณุ สิงหเดช','ชัดเจน'],
    ['3','46361','แทนคุณ แซ่ตั้ง','แทนคุณ'],['4','46362','ธนภูมิ รวดเร็ว','เกาทัณฑ์'],
    ['5','46363','ธราเทพ วาศุกรี','เกล้า'],['6','46364','ธิติวุฒิ จันทร์ขำ','—'],
    ['7','46365','นันทชัย คงแจ้ง','พีค'],['8','46366','พีร์รัฐ ศรีสนธิพันธุ์','ลาเต้'],
    ['9','46367','ระเมฆ ปานเนียม','ปลื้ม'],['10','46368','ฤทธานุภาพ มุ่งนิมิตร','—'],
    ['11','46369','ศุภฉัตร สรรพการ','ข้าวก้อง'],['12','46370','ศุภฤกษ์ เกียรติมณีรัตน์','ออมสิน'],
    ['13','46593','ธนภัทร เอมน้อย','เจ้าคุณ'],['14','46372','กณิฐา แสงสี','ข้าวปุ้น'],
    ['15','46373','กนกวรรณ นัดดาพรหม','ไข่มุก'],['16','46374','กัญญ์นรานัทท์ ใหญ่พงษ์','กอบัว'],
    ['17','46375','กัญญาณัฐ นกจั่น','—'],['18','46376','กัญญาพัชร์ พูกันแก้ว','แจน'],
    ['19','46377','กัญญาภัค จันลา','จูน'],['20','46378','จิราพัชร ฤทธิรักษ์','มีน'],
    ['21','46379','ณัฐณิชา แจ่มกระจ่าง','ออม'],['22','46380','ณิชากานต์ เข็มงูเหลือม','—'],
    ['23','46381','ธนิษฐา ฉิมพาลี','เกรซ'],['24','46382','ธรรมธาดา หารน้อย','—'],
    ['25','46383','ธันยพร ภักดีรักษ์','ปลายฟ้า'],['26','46384','เบญญาภา ใจกล้า','ไกด์'],
    ['27','46385','เบญญาภา ไตรยศ','แพร'],['28','46386','ปนันท์ภัทร แตงฉ่ำ','ปอ'],
    ['29','46387','ปารมี เกื้อสุข','ป๊อบ'],['30','46388','ปุณยาพร เกิดแก้ว','—'],
    ['31','46389','มนัสนันท์ มีฤกษ์ใหญ่','ปิ๊ง'],['32','46391','วิชญาดา เหาะสูงเนิน','มะลิ'],
    ['33','46392','สาว','ชมดาว'],['34','46393','พราวพิชชา สุขทอง','ย้ง'],
    ['35','46394','อริสา แก้วสุพจน์','—'],['36','46395','อาภาภัทร ชมชื่น','เบล'],
    ['37','46396','อินธิญา ฉลาดดี','—'],['38','46397','อุบลวรรณ ขุนทอง','มะปราง'],
  ],
};
const classroom36 = {
  room: '3/6',
  advisors: [
    { name: 'ครูณัฐพล เชยเอม', order: 'ครูที่ปรึกษาคนที่ 1', image: 'assets/members/advisor-nattaphon-36.jpg' },
    { name: 'ครูอรรถพล มงคลพร', order: 'ครูที่ปรึกษาคนที่ 2', image: 'assets/members/advisor-atthaphon-36.jpg' },
  ],
  students: [
    ['1','46280','กิตติภัทร ศึกษากิจ','บีม'],['2','46281','คเณศ เเจ่มมณี','เบน'],
    ['3','46282','จุมพลภัทร์ โอฬาร','—'],['4','46283','ชลัณธร มีรัตน์','ไบโอ'],
    ['5','46284','ณฐพงค์ ช่างเสา','—'],['6','46285','ณัฐภัทร ม่วงมี','ไอซ์'],
    ['7','46286','ณาฏฐสิงห์ สร้อยนวม','—'],['8','46287','เดชพิภัช เชียวแสน','กังฟู'],
    ['9','46288','ธนภัทร ทองวิลัย','เวียร์'],['10','46289','พิชญะ ตระกูลสุนทรชัย','พีค'],
    ['11','46290','พิพัฒน์ ปานชูวงษ์','แฮม'],['12','46291','ภวัต แก้วมูล','ไนท์'],
    ['13','46292','เมธัส กันหะ','กัน'],['14','46293','สุพศิน ศรีวะรมย์','กำปั้น'],
    ['15','46294','อัฐกานต์ สิงห์ห่วง','—'],['16','46592','ฑีฆายุ จันรอด','ออโต้'],
    ['17','46295','กัญญาพัชร บุญเป็ง','—'],['18','46296','กัญญาภัค บัวเผือก','—'],
    ['19','46297','กาญจนา อยู่สําราญ','พลอย'],['20','46298','กิติมา เพ็งแย้ม','แอร์'],
    ['21','46299','ชญานันท์ คงขำ','แอ๋ม'],['22','46300','ชนิดาภา ฤกษ์อินทร์','เชียร์'],
    ['23','46301','ชุติมา ศรีวรรณะ','เจี๊ยบ'],['24','46302','โชณินตา ศรีศาสตร์','—'],
    ['25','46304','นลิญา อินทรทิตติ','ลิญา'],['26','46305','นันณภัชสรณ์ ภู่ปราง','อรรยา'],
    ['27','46306','นันท์ณภัทร ไกรทอง','นัท'],['28','46307','ปนิตา นิลรัตน์','เอย'],
    ['29','46308','พัสน์นันท์ จูกระจ่าง','—'],['30','46309','พิชชาพร บุญรอด','เฟรช'],
    ['31','46310','พิชญากร วิเลปะนะ','จ๋า'],['32','46312','ภิรดา เจริญพรหม','พิว'],
    ['33','46313','ยิ่งลักษณ์ เชาวน์สง่า','เค้ก'],['34','46314','วริศรา คณาฤทธิ์','สตางค์'],
    ['35','46315','ศรัณย์รัชต์ พุทธาวงษ์','กะตังค์'],['36','46316','ศิริอัปสร แก้วคง','ตันหยง'],
    ['37','46317','สิริกร ภู่ระหงษ์','น้ำเเข็ง'],['38','46318','สิริวิภา ดวงดี','เเก้ว'],
  ],
};
const CLASSROOM_DATABASE = { '1/3': classroom13, '2/1': classroom21, '2/5': classroom25, '3/6': classroom36, '3/8': classroom38, '4/2': classroom42, '4/3': classroom43, '5/11': classroom511, '5/12': classroom512, '6/4': classroom64, '6/5': classroom65 };
let roomLoginClassroom = classroom65;

function showPage(id) {
  const currentPage = document.querySelector('.page.active')?.id;
  if (id !== 'admin') window.clearInterval(attendanceStatusTimer);
  if (id !== 'election') window.clearInterval(window.voteTimer);
  if (id !== 'admin') stopAttendanceCamera();

  // Build expensive page content while it is still display:none. This avoids
  // interleaving a large DOM/layout pass with the page transition animation.
  if (id === 'election') renderElection();
  if (id === 'gallery') renderGalleryPage();
  if (id === 'sports') renderSportsPage();
  if (id === 'members') renderCommitteeMembers();
  if (id === 'classroom-113') renderClassroom113();
  if (id === 'classroom-13') renderClassroom13();
  if (id === 'classroom-21') renderClassroom21();
  if (id === 'classroom-25') renderClassroom25();
  if (id === 'classroom-36') renderClassroom36();
  if (id === 'classroom-38') renderClassroom38();
  if (id === 'classroom-42') renderClassroom42();
  if (id === 'classroom-43') renderClassroom43();
  if (id === 'classroom-511') renderClassroom511();
  if (id === 'classroom-512') renderClassroom512();
  if (id === 'classroom-64') renderClassroom64();
  if (id === 'classroom-65') renderClassroom65();
  if (id === 'shop') renderShop();

  pages.forEach((page) => $(`#${page}`).classList.toggle('active', page === id));
  document.body.classList.toggle('classroom-mode', ['classroom-113', 'classroom-13', 'classroom-21', 'classroom-25', 'classroom-36', 'classroom-38', 'classroom-42', 'classroom-43', 'classroom-511', 'classroom-512', 'classroom-64', 'classroom-65'].includes(id));
  document.body.classList.toggle('classroom-113-mode', id === 'classroom-113');
  document.body.classList.toggle('classroom-13-mode', id === 'classroom-13');
  document.body.classList.toggle('classroom-21-mode', id === 'classroom-21');
  document.body.classList.toggle('classroom-25-mode', id === 'classroom-25');
  document.body.classList.toggle('classroom-36-mode', id === 'classroom-36');
  document.body.classList.toggle('classroom-38-mode', id === 'classroom-38');
  document.body.classList.toggle('classroom-42-mode', id === 'classroom-42');
  document.body.classList.toggle('classroom-43-mode', id === 'classroom-43');
  document.body.classList.toggle('classroom-511-mode', id === 'classroom-511');
  document.body.classList.toggle('classroom-512-mode', id === 'classroom-512');
  document.body.classList.toggle('classroom-64-mode', id === 'classroom-64');
  document.body.classList.toggle('cinema-login-mode', id === 'room-login' && roomLoginClassroom.room === '5/12');
  document.body.classList.toggle('medical-login-mode', id === 'room-login' && roomLoginClassroom.room === '6/4');
  document.body.classList.toggle('geography-login-mode', id === 'room-login' && roomLoginClassroom.room === '5/11');
  document.body.classList.toggle('robotics-login-mode', id === 'room-login' && roomLoginClassroom.room === '4/3');
  document.body.classList.toggle('nature-login-mode', id === 'room-login' && roomLoginClassroom.room === '4/2');
  document.body.classList.toggle('golden-login-mode', id === 'room-login' && roomLoginClassroom.room === '6/5');
  document.body.classList.toggle('computer-login-mode', id === 'room-login' && roomLoginClassroom.room === '3/8');
  document.body.classList.toggle('art-login-mode', id === 'room-login' && roomLoginClassroom.room === '3/6');
  document.body.classList.toggle('engineering-login-mode', id === 'room-login' && roomLoginClassroom.room === '2/5');
  document.body.classList.toggle('international-login-mode', id === 'room-login' && roomLoginClassroom.room === '2/1');
  document.body.classList.toggle('dance-login-mode', id === 'room-login' && roomLoginClassroom.room === '1/13');
  document.body.classList.toggle('biology-login-mode', id === 'room-login' && roomLoginClassroom.room === '1/3');
  document.body.classList.toggle('election-mode', id === 'election');
  document.body.classList.toggle('admin-mode', id === 'admin');
  document.body.classList.toggle('sports-mode', id === 'sports');
  document.body.classList.toggle('shop-mode', id === 'shop');
  document.body.dataset.activePage = id;
  const footerContext = {
    home: 'PHUNRUEANG · WE SHINE TOGETHER',
    members: 'OUR PEOPLE · ONE YELLOW FAMILY',
    'room-login': `CLASSROOM ${roomLoginClassroom.room} · MEMBER ACCESS`,
    'classroom-113': 'CLASSROOM 1/13 · DANCE FLOOR',
    'classroom-13': 'CLASSROOM 1/3 · BIOLOGY MICROSCOPE LAB',
    'classroom-21': 'CLASSROOM 2/1 · INTERNATIONAL JOURNEY',
    'classroom-25': 'CLASSROOM 2/5 · ENGINEERING WORKSHOP',
    'classroom-36': 'CLASSROOM 3/6 · ART GALLERY',
    'classroom-38': 'CLASSROOM 3/8 · COMPUTER LAB',
    'classroom-42': 'CLASSROOM 4/2 · NATURE & ENVIRONMENT',
    'classroom-43': 'CLASSROOM 4/3 · ROBOTICS LAB',
    'classroom-511': 'CLASSROOM 5/11 · GEOGRAPHY EXPLORERS',
    'classroom-512': 'CLASSROOM 5/12 · CINEMA CREW',
    'classroom-64': 'CLASSROOM 6/4 · MEDICAL CREW',
    'classroom-65': 'CLASSROOM 6/5 · OUR CONSTELLATION',
    election: 'PHUNRUEANG ELECTION · EVERY VOICE MATTERS',
    shop: 'PHUNRUEANG · OFFICIAL STORE',
    gallery: 'PHUNRUEANG MOMENTS · MEMORY ARCHIVE',
    admin: 'PHUNRUEANG · COMMAND CENTER',
    sports: 'ONE HEART · ONE GLORY'
  };
  const creditContext = $('#siteCreditContext');
  if (creditContext) creditContext.textContent = footerContext[id] || footerContext.home;
  // A cross-page smooth scroll competes with the incoming page's animations.
  // Keep smooth scrolling inside pages, but reset immediately between pages.
  window.scrollTo({ top: 0, behavior: currentPage === id ? 'smooth' : 'auto' });
  if (id === 'room-login') window.setTimeout(() => $('#roomStudentId')?.focus(), 350);
}

const COMMITTEE_KEY = 'phanuang-committee-members';
const COMMITTEE_DB = 'phanuang-member-storage';
const COMMITTEE_STORE = 'directory';
const MEMBER_ROLES = ['ประธานสี','รองประธานสี','เหรัญญิก','เฮดขบวน','เฮดเชียร์ลีดเดอร์','เฮดแสตนด์','เฮดเปตอง','เฮดฟุตบอล','เฮดวอลเลย์บอล','เฮดแบดมินตัน','เฮดบาสเกตบอล','เฮดกรีฑา','สวัสดิการ / พยาบาล','เฮดพร็อพ','สตาฟขบวน','สตาฟแสตนด์'];
function openCommitteeDatabase() { return new Promise((resolve, reject) => { const request = indexedDB.open(COMMITTEE_DB, 1); request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(COMMITTEE_STORE)) request.result.createObjectStore(COMMITTEE_STORE); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
async function readCommitteeDatabase() { const database = await openCommitteeDatabase(); return new Promise((resolve, reject) => { const transaction = database.transaction(COMMITTEE_STORE, 'readonly'); const request = transaction.objectStore(COMMITTEE_STORE).get('members'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); transaction.oncomplete = () => database.close(); }); }
async function setCommitteeMembers(members) { const database = await openCommitteeDatabase(); await new Promise((resolve, reject) => { const transaction = database.transaction(COMMITTEE_STORE, 'readwrite'); transaction.objectStore(COMMITTEE_STORE).put(members, 'members'); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); database.close(); }
async function getCommitteeMembers() { try { const shared = JSON.parse(localStorage.getItem(COMMITTEE_KEY) || 'null'); if (Array.isArray(shared)) return shared; const saved = await readCommitteeDatabase(); if (Array.isArray(saved) && saved.length) { localStorage.setItem(COMMITTEE_KEY, JSON.stringify(saved)); return saved; } return []; } catch (_) { return []; } }
function escapeAttribute(value = '') { return escapeHTML(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
const MEMBER_CONTACTS = [
  { key:'instagram', label:'Instagram', icon:'◎', hint:'ชื่อผู้ใช้หรือ URL', base:'https://instagram.com/' },
  { key:'facebook', label:'Facebook', icon:'f', hint:'ชื่อโปรไฟล์หรือ URL', base:'https://facebook.com/' },
  { key:'line', label:'LINE', icon:'L', hint:'LINE ID หรือ URL', base:'https://line.me/ti/p/~' },
  { key:'tiktok', label:'TikTok', icon:'♪', hint:'ชื่อผู้ใช้หรือ URL', base:'https://tiktok.com/@' },
  { key:'other', label:'ช่องทางอื่น', icon:'↗', hint:'URL เว็บไซต์หรือช่องทางอื่น', base:'' },
];
function memberContactHref(contact, value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  if (/^https?:\/\//i.test(clean)) return clean;
  if (contact.key === 'other') return '';
  return contact.base + encodeURIComponent(clean.replace(/^@/, ''));
}
function closeMemberContactModal() {
  const modal = document.querySelector('.member-contact-modal');
  if (!modal) return;
  modal.classList.remove('is-open');
  document.body.classList.remove('member-modal-open');
  window.setTimeout(() => modal.remove(), 220);
}
function openMemberContactModal(member) {
  closeMemberContactModal();
  const contacts = MEMBER_CONTACTS.map((contact) => ({ ...contact, value:member.contacts?.[contact.key] || '' })).filter((contact) => contact.value);
  const modal = document.createElement('div');
  modal.className = 'member-contact-modal';
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', `ช่องทางติดต่อของ ${member.name || 'สมาชิก'}`);
  modal.innerHTML = `<button class="member-modal-backdrop" type="button" aria-label="ปิดหน้าต่าง"></button><div class="member-modal-card"><button class="member-modal-close" type="button" aria-label="ปิดหน้าต่าง">×</button><div class="member-modal-person"><div class="member-modal-avatar">${member.image ? `<img src="${member.image}" alt="">` : '<span>✦</span>'}</div><div><small>CONTACT · PHUNRUEANG</small><h3>${escapeHTML(member.name || 'สมาชิกคณะสี')}</h3><p>${escapeHTML(member.role || 'แกนนำนักเรียน')}${member.nickname ? ` · ${escapeHTML(member.nickname)}` : ''}</p></div></div><div class="member-contact-list">${contacts.length ? contacts.map((contact) => { const href = memberContactHref(contact, contact.value); const body = `<span class="contact-icon">${contact.icon}</span><span><small>${contact.label}</small><b>${escapeHTML(contact.value)}</b></span><i>↗</i>`; return href ? `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">${body}</a>` : `<div>${body}</div>`; }).join('') : '<div class="member-no-contact"><span>✦</span><p>ยังไม่ได้เพิ่มช่องทางการติดต่อ</p></div>'}</div><p class="member-contact-note">โปรดติดต่ออย่างสุภาพและเคารพความเป็นส่วนตัวของสมาชิก</p></div>`;
  document.body.appendChild(modal); document.body.classList.add('member-modal-open');
  modal.querySelectorAll('.member-modal-close,.member-modal-backdrop').forEach((button) => button.addEventListener('click', closeMemberContactModal));
  window.requestAnimationFrame(() => { modal.classList.add('is-open'); modal.querySelector('.member-modal-close').focus(); });
}
let committeeMembersRendered = false;
async function renderCommitteeMembers(force = false) {
  const host = $('#committeeMembers'); if (!host) return;
  if (committeeMembersRendered && !force && host.childElementCount) return;
  const all = (await getCommitteeMembers()).filter((item) => item.published !== false).sort((a,b) => (a.order || 0) - (b.order || 0));
  const section = (type, eyebrow, title, text) => {
    const members = all.filter((item) => item.type === type);
    return `<section class="committee-section"><header class="committee-heading"><div><small>${eyebrow}</small><h3>${title}</h3></div><p>${text}</p></header>${members.length ? `<div class="committee-grid">${members.map((member, index) => `<article class="committee-card ${type === 'student' ? 'is-clickable' : ''}" style="--member-index:${index}" ${type === 'student' ? `tabindex="0" role="button" data-member-index="${all.indexOf(member)}" aria-label="ดูช่องทางติดต่อของ ${escapeAttribute(member.name || 'สมาชิก')}"` : ''}><div class="committee-photo">${member.image ? `<img src="${member.image}" alt="${escapeHTML(member.name || member.role)}" loading="lazy" decoding="async">` : '<span aria-hidden="true">✦</span>'}<b>${String(index + 1).padStart(2,'0')}</b></div><div class="committee-info"><small>${escapeHTML(member.role || 'สมาชิกคณะสี')}</small><h4>${escapeHTML(member.name || 'รอระบุชื่อ')}</h4>${member.nickname ? `<p>ชื่อเล่น <strong>${escapeHTML(member.nickname)}</strong></p>` : '<p>ทีมพันเรือง</p>'}</div></article>`).join('')}</div>` : `<div class="leaders-empty card"><span aria-hidden="true">✦</span><p>ยังไม่มีข้อมูล${type === 'student' ? 'แกนนำนักเรียน' : 'คณะครู'} — เพิ่มได้จากหน้าแอดมิน</p></div>`}</section>`;
  };
  host.innerHTML = section('student','STUDENT LEADERS','แกนนำนักเรียน','พลังหลักเบื้องหลังทุกสนาม ทุกขบวน และทุกเสียงเชียร์') + section('teacher','OUR ADVISORS','คณะครู','ครูผู้ดูแล ให้คำปรึกษา และร่วมผลักดันชาวพันเรือง');
  committeeMembersRendered = true;
  host.querySelectorAll('.committee-card.is-clickable').forEach((card) => { const open = () => openMemberContactModal(all[Number(card.dataset.memberIndex)]); card.addEventListener('click', open); card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }); });
}
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMemberContactModal(); });

function openMemberCropStudio(imageSource, onSave) {
  const state = { x:50, y:50, zoom:1 };
  const dialog = document.createElement('dialog');
  dialog.className = 'candidate-crop-studio member-crop-studio';
  dialog.innerHTML = `<header><div><small>MEMBER PHOTO EDITOR</small><h3>ครอปรูปสำหรับการ์ดสมาชิก</h3><p>ลากรูปเพื่อจัดตำแหน่งใบหน้า และเลื่อนแถบเพื่อซูม</p></div><button type="button" data-crop-close aria-label="ปิด">×</button></header><div class="member-crop-body"><div class="member-crop-frame crop-drag-frame"><img src="${imageSource}" alt="ตัวอย่างรูปสมาชิก"></div><div class="member-crop-tools"><b>ตัวอย่างสัดส่วนที่จะแสดงบนการ์ด</b><span>พื้นที่นอกกรอบจะถูกตัดออก เพื่อให้รูปสมาชิกทุกใบเป็นระเบียบเท่ากัน</span><label class="crop-zoom-control">ซูมภาพ <input type="range" min="1" max="3" step="0.05" value="1"><output>1.00×</output></label><button class="crop-reset" type="button">คืนค่ากึ่งกลาง</button></div></div><footer><span>☝ ลากรูปภายในกรอบเพื่อจัดตำแหน่ง</span><div><button class="mini" type="button" data-crop-cancel>ยกเลิก</button><button class="save-crop-studio" type="button">ใช้รูปที่ครอปแล้ว</button></div></footer>`;
  document.body.appendChild(dialog);
  const frame = dialog.querySelector('.member-crop-frame');
  const image = frame.querySelector('img');
  const range = dialog.querySelector('input[type=range]');
  const output = dialog.querySelector('output');
  const saveButton = dialog.querySelector('.save-crop-studio');
  saveButton.disabled = !image.complete;
  image.addEventListener('load', () => { saveButton.disabled = false; });
  const render = () => { image.style.objectPosition = `${state.x}% ${state.y}%`; image.style.transform = `scale(${state.zoom})`; range.value = state.zoom; output.textContent = `${state.zoom.toFixed(2)}×`; };
  let drag = null;
  frame.addEventListener('pointerdown', (event) => { drag = { pointerX:event.clientX, pointerY:event.clientY, x:state.x, y:state.y }; frame.setPointerCapture(event.pointerId); frame.classList.add('dragging'); });
  frame.addEventListener('pointermove', (event) => { if (!drag) return; const box = frame.getBoundingClientRect(); state.x = Math.min(100, Math.max(0, drag.x - (event.clientX - drag.pointerX) / box.width * 100)); state.y = Math.min(100, Math.max(0, drag.y - (event.clientY - drag.pointerY) / box.height * 100)); render(); });
  const stopDrag = () => { drag = null; frame.classList.remove('dragging'); };
  frame.addEventListener('pointerup', stopDrag); frame.addEventListener('pointercancel', stopDrag);
  range.addEventListener('input', (event) => { state.zoom = Number(event.target.value); render(); });
  dialog.querySelector('.crop-reset').addEventListener('click', () => { state.x = 50; state.y = 50; state.zoom = 1; render(); });
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector('[data-crop-close]').addEventListener('click', close); dialog.querySelector('[data-crop-cancel]').addEventListener('click', close);
  saveButton.addEventListener('click', () => {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 1050;
    const context = canvas.getContext('2d'); context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    const coverScale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
    const baseWidth = image.naturalWidth * coverScale, baseHeight = image.naturalHeight * coverScale;
    const baseLeft = (canvas.width - baseWidth) * state.x / 100, baseTop = (canvas.height - baseHeight) * state.y / 100;
    const width = baseWidth * state.zoom, height = baseHeight * state.zoom;
    const left = canvas.width / 2 + (baseLeft - canvas.width / 2) * state.zoom;
    const top = canvas.height / 2 + (baseTop - canvas.height / 2) * state.zoom;
    context.drawImage(image, left, top, width, height);
    onSave(canvas.toDataURL('image/jpeg', .86)); close();
  });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  render(); dialog.showModal();
}

document.querySelectorAll('[data-page]').forEach((button) => {
  button.addEventListener('click', () => showPage(button.dataset.page));
});
$('#adminQuick').addEventListener('click', () => { showPage('admin'); renderAdmin(); });

function openRoomLogin(classroom) {
  roomLoginClassroom = classroom;
  const loginCopy = {
    '1/13': ['BALLROOM PASS · MEMBER ACCESS', 'ชาวห้องสิบสาม'],
    '1/3': ['BIO LAB · SPECIMEN ID SCAN', 'ชาวห้องสาม'],
    '2/5': ['ENGINEERING LAB · ID SCAN', 'ชาวห้องห้า'],
    '2/1': ['IMMIGRATION · PASSPORT CONTROL', 'ชาวห้องหนึ่ง'],
    '3/6': ['GALLERY PASS · MEMBER ACCESS', 'ชาวห้องหก'],
    '3/8': ['COMPUTER LAB · USER LOGIN', 'ชาวห้องแปด'],
    '6/5': ['COSMIC IDENTITY CHECK', 'ชาวห้องห้า'],
    '6/4': ['MEDICAL CHECK-IN', 'ชาวห้องสี่'],
    '5/12': ['ADMIT ONE · CAST ACCESS', 'ชาวห้องสิบสอง'],
    '5/11': ['FIELD LOG · MEMBER CHECK', 'ชาวห้องสิบเอ็ด'],
    '4/3': ['ROBOTICS IDENTITY SCAN', 'ชาวห้องสาม'],
    '4/2': ['CLASSMATE CHECK', 'ชาวห้องสอง'],
  }[classroom.room];
  $('.login-room-badge').textContent = `ม.${classroom.room}`;
  $('.class-login .section-label').textContent = loginCopy[0];
  $('.class-login h2').innerHTML = `ยืนยันตัวตน<br><em>${loginCopy[1]}</em>`;
  $('.class-login>p').textContent = `กรอกเลขประจำตัวนักเรียน เพื่อเข้าสู่พื้นที่สมาชิกของห้อง ม.${classroom.room}`;
  $('#roomStudentId').value = '';
  $('#roomLoginError').textContent = '';
  document.querySelector('.room-login-wrap').classList.toggle('medical-login', classroom.room === '6/4');
  document.querySelector('.room-login-wrap').classList.toggle('cinema-login', classroom.room === '5/12');
  document.querySelector('.room-login-wrap').classList.toggle('geography-login', classroom.room === '5/11');
  document.querySelector('.room-login-wrap').classList.toggle('robotics-login', classroom.room === '4/3');
  document.querySelector('.room-login-wrap').classList.toggle('nature-login', classroom.room === '4/2');
  document.querySelector('.room-login-wrap').classList.toggle('golden-login', classroom.room === '6/5');
  document.querySelector('.room-login-wrap').classList.toggle('computer-login', classroom.room === '3/8');
  document.querySelector('.room-login-wrap').classList.toggle('art-login', classroom.room === '3/6');
  document.querySelector('.room-login-wrap').classList.toggle('engineering-login', classroom.room === '2/5');
  document.querySelector('.room-login-wrap').classList.toggle('international-login', classroom.room === '2/1');
  document.querySelector('.room-login-wrap').classList.toggle('dance-login', classroom.room === '1/13');
  document.querySelector('.room-login-wrap').classList.toggle('biology-login', classroom.room === '1/3');
  showPage('room-login');
}
$('#openRoom113').addEventListener('click', () => openRoomLogin(classroom113));
$('#openRoom13').addEventListener('click', () => openRoomLogin(classroom13));
$('#openRoom21').addEventListener('click', () => openRoomLogin(classroom21));
$('#openRoom25').addEventListener('click', () => openRoomLogin(classroom25));
$('#openRoom64').addEventListener('click', () => openRoomLogin(classroom64));
$('#openRoom65').addEventListener('click', () => openRoomLogin(classroom65));
$('#openRoom512').addEventListener('click', () => openRoomLogin(classroom512));
$('#openRoom511').addEventListener('click', () => openRoomLogin(classroom511));
$('#openRoom43').addEventListener('click', () => openRoomLogin(classroom43));
$('#openRoom42').addEventListener('click', () => openRoomLogin(classroom42));
$('#openRoom38').addEventListener('click', () => openRoomLogin(classroom38));
$('#openRoom36').addEventListener('click', () => openRoomLogin(classroom36));
$('#roomStudentId').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/\D/g, '').slice(0, 5);
  $('#roomLoginError').textContent = '';
});
$('#roomLoginForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const studentId = $('#roomStudentId').value.trim();
  const student = roomLoginClassroom.students.find((item) => item[1] === studentId);
  if (!student) {
    $('#roomLoginError').textContent = `ไม่พบเลขประจำตัวนี้ในห้อง ม.${roomLoginClassroom.room} กรุณาตรวจสอบอีกครั้ง`;
    $('#roomStudentId').setAttribute('aria-invalid', 'true');
    return;
  }
  $('#roomStudentId').removeAttribute('aria-invalid');
  const roomCode = roomLoginClassroom.room.replace('/', '');
  sessionStorage.setItem(`classroom${roomCode}Student`, studentId);
  showPage(`classroom-${roomLoginClassroom.room.replace('/', '')}`);
});

function observeClassroomSections(host) {
  classroomAnimationObserver?.disconnect();
  classroomAnimationObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => entry.target.classList.toggle('is-offscreen', !entry.isIntersecting));
  }, { rootMargin: '160px 0px' });
  host.querySelectorAll('.classroom-hero,.advisor-section,.student-section').forEach((section) => classroomAnimationObserver.observe(section));
}

function renderClassroom113() {
  const studentId = sessionStorage.getItem('classroom113Student');
  const currentStudent = classroom113.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom113; openRoomLogin(classroom113); return; }
  const host = $('#classroom113Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <section class="classroom-hero dance-hero">
      <div class="dance-scene" aria-hidden="true"><i></i><i></i><i></i><span>♪</span><b>♬</b><em>LET'S DANCE</em></div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> GRAND BALLROOM · CLASS OF 2026</div>
        <h1>ก้าวไปพร้อมกัน<br><em>ม.1/13</em></h1>
        <p>ยินดีต้อนรับ <b>${escapeHTML(currentStudent[3])}</b> — นักเต้นทั้ง ${classroom113.students.length} คน เติมจังหวะ มิตรภาพ และความมั่นใจให้ฟลอร์เดียวกันเปล่งประกาย</p>
        <div class="class-stats"><span><b>${classroom113.students.length}</b> DANCERS</span><span><b>${classroom113.advisors.length}</b> DANCE MENTOR</span><span><b>1</b> BALLROOM CREW</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>BALLROOM</small>1/13</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>STEP ONTO THE FLOOR</div>
    </section>
    <section class="advisor-section dance-advisor-section">
      <div class="class-section-heading"><div><small>OUR DANCE MENTOR</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>ผู้กำกับจังหวะและคอยดูแลทุกก้าวของห้อง 1/13 ✦</span></div>
      <div class="advisor-cards single-advisor">${classroom113.advisors.map((advisor) => `
        <article class="advisor-card"><div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>DANCE MENTOR · 01</span></div><div class="advisor-name-panel"><div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div><small class="advisor-title">${advisor.order} · DANCE MENTOR</small><h3 class="advisor-name">${escapeHTML(advisor.name)}</h3><p class="advisor-role"><span>♪</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 1/13</p><div class="advisor-code">LEAD THE RHYTHM · 01</div></div></article>`).join('')}</div>
    </section>
    <section class="student-section dance-student-section">
      <div class="class-section-heading"><div><small>${classroom113.students.length} DANCERS · ONE RHYTHM</small><h2>ฐานข้อมูลสมาชิก ม.1/13</h2></div><span>ซิงค์จากไฟล์รายชื่อ · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom113.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}"><div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>♪</i></div><h3>${escapeHTML(name)}</h3><p>DANCER ${id} <b>·</b> ม.1/13 <b>·</b> เลขที่ ${number}</p><div class="nickname"><small>STAGE NAME</small><strong>${escapeHTML(nickname)}</strong></div>${id === studentId ? '<em class="you-badge">จังหวะของคุณ!</em>' : ''}</article>`).join('')}</div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom13() {
  const studentId = sessionStorage.getItem('classroom13Student');
  const currentStudent = classroom13.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom13; openRoomLogin(classroom13); return; }
  const host = $('#classroom13Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <section class="classroom-hero biology-hero">
      <div class="biology-scene" aria-hidden="true"><div class="cell cell-a"></div><div class="cell cell-b"></div><div class="dna-ribbon">⌁⌁⌁</div><span>SPECIMEN 01 · ACTIVE</span></div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> BIOLOGY LAB · MICROSCOPIC DISCOVERY · 2026</div>
        <div class="biology-welcome"><small>LAB ACCESS GRANTED</small><b>${escapeHTML(currentStudent[2])}</b><span>นักวิจัยเลขที่ ${String(currentStudent[0]).padStart(2, '0')} · ID ${escapeHTML(currentStudent[1])}</span></div>
        <h1>มองให้ลึก<br><em>ค้นพบให้ไกล</em></h1>
        <p>ยินดีต้อนรับสู่ห้อง ม.1/3 — ห้องทดลองที่ทุกคำถามคือสไลด์ชิ้นใหม่ และทุกการค้นพบเติบโตไปพร้อมกับพวกเราทั้งห้อง</p>
        <div class="class-stats"><span><b>${classroom13.students.length}</b> RESEARCHERS</span><span><b>${classroom13.advisors.length}</b> LAB MENTORS</span><span><b>40×</b> DISCOVERY</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>BIO LAB</small>1/3</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>OBSERVE THE UNSEEN</div>
    </section>
    <section class="advisor-section biology-advisor-section">
      <div class="class-section-heading"><div><small>LAB MENTORS · GUIDING DISCOVERY</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>ผู้ดูแลการทดลองและจุดประกายทุกการค้นพบของห้อง 1/3</span></div>
      <div class="advisor-cards">${classroom13.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}"><div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>LAB MENTOR · 0${index + 1}</span></div><div class="advisor-name-panel"><div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div><small class="advisor-title">${advisor.order} · BIOLOGY GUIDE</small><h3 class="advisor-name">${escapeHTML(advisor.name)}</h3><p class="advisor-role"><span>⌕</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 1/3</p><div class="advisor-code">MICROSCOPE LAB · 0${index + 1}</div></div></article>`).join('')}</div>
    </section>
    <section class="student-section biology-student-section">
      <div class="class-section-heading"><div><small>${classroom13.students.length} RESEARCHERS · ONE LAB</small><h2>ฐานข้อมูลสมาชิก ม.1/3</h2></div><span>ซิงค์จาก M.1_3 (การตอบกลับ) (2).xlsx · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom13.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}"><div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>⌕</i></div><h3>${escapeHTML(name)}</h3><p>SPECIMEN ${escapeHTML(id)} <b>·</b> ม.1/3 <b>·</b> เลขที่ ${number}</p><div class="nickname"><small>LAB NAME</small><strong>${escapeHTML(nickname)}</strong></div>${id === studentId ? '<em class="you-badge">ตัวอย่างของคุณ!</em>' : ''}</article>`).join('')}</div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom21() {
  const studentId = sessionStorage.getItem('classroom21Student');
  const currentStudent = classroom21.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom21; openRoomLogin(classroom21); return; }
  const host = $('#classroom21Content');
  if (host.dataset.rendered === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <section class="classroom-hero international-hero">
      <button class="room-back light" type="button" data-page="members">← กลับหน้าสมาชิก</button>
      <div class="international-scene" aria-hidden="true"><div class="world-orbit orbit-a"></div><div class="world-orbit orbit-b"></div><span class="landmark landmark-a">✈</span><span class="landmark landmark-b">⌖</span><span class="landmark landmark-c">◎</span><div class="language-cloud"><b>HELLO</b><span>BONJOUR</span><i>你好</i><em>こんにちは</em><strong>HOLA</strong><small>안녕하세요</small></div><div class="flight-route">BKK　·　TYO　·　LON　·　PAR　·　NYC</div></div>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> INTERNATIONAL CLASS · READY FOR DEPARTURE · 2026</div>
        <div class="international-welcome"><span>WELCOME ABOARD · ยินดีต้อนรับ</span><b>${escapeHTML(currentStudent[2])}</b><small>ผู้โดยสารเลขที่ ${String(currentStudent[0]).padStart(2, '0')} · PASSPORT ID ${escapeHTML(currentStudent[1])}</small></div>
        <h1>ห้องเรียน<br><em>ม.2/1</em></h1>
        <p>เปิดพาสปอร์ตสู่โลกกว้าง เรียนรู้ความแตกต่าง เชื่อมมิตรภาพ และออกเดินทางไปด้วยกันในฐานะพลเมืองของโลก</p>
        <div class="class-stats"><span><b>${classroom21.students.length}</b> TRAVELERS</span><span><b>${classroom21.advisors.length}</b> GUIDES</span><span><b>01</b> WORLD</span></div>
      </div><div class="classroom-big-number">2/1</div>
    </section>
    <section class="advisor-section international-advisor-section">
      <div class="class-section-heading"><div><small>TRAVEL GUIDES</small><h2>ครูที่ปรึกษา</h2></div><span>ผู้พาชาว ม.2/1 ออกสำรวจโลกแห่งการเรียนรู้</span></div>
      <div class="advisor-cards">${classroom21.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}" data-country="${index ? 'UNITED KINGDOM' : 'FRANCE'}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>GUIDE · 0${index + 1}</span></div>
          <div class="advisor-name-panel"><div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div><small class="advisor-title">${advisor.order} · TRAVEL GUIDE</small><h3 class="advisor-name">${escapeHTML(advisor.name)}</h3><p class="advisor-role"><span>✈</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 2/1</p><div class="advisor-code">WORLD GUIDE · 0${index + 1}</div></div>
        </article>`).join('')}</div>
    </section>
    <section class="student-section international-student-section">
      <div class="student-travel-scene" aria-hidden="true"><div class="sky-cloud cloud-one"></div><div class="sky-cloud cloud-two"></div><div class="world-map-mark">WORLD LANGUAGE ROUTE</div><div class="student-flight-path"><i></i><i></i><i></i><span>✈</span></div><div class="airport-code code-bkk">BKK</div><div class="airport-code code-lon">LON</div><div class="airport-code code-tyo">TYO</div></div>
      <div class="class-section-heading"><div><small>PASSENGER MANIFEST</small><h2>รายชื่อนักเรียน</h2></div><span>${classroom21.students.length} คน · ปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom21.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}" data-language="${['EN','FR','JP','CN'][Number(number) % 4]}"><div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><b>✈</b></div><h3>${escapeHTML(name)}</h3><p>PASSPORT ID · <b>${id}</b></p><div class="nickname"><small>CALL SIGN</small><strong>${escapeHTML(nickname)}</strong></div>${id === studentId ? '<em class="you-badge">YOU ARE HERE</em>' : ''}</article>`).join('')}</div>
    </section>`;
  host.dataset.rendered = studentId;
  host.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
  observeClassroomSections(host);
}

function renderClassroom25() {
  const studentId = sessionStorage.getItem('classroom25Student');
  const currentStudent = classroom25.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom25; openRoomLogin(classroom25); return; }
  const host = $('#classroom25Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <section class="classroom-hero engineering-hero">
      <div class="engineering-blueprint" aria-hidden="true"><div class="blueprint-grid"></div><div class="gear gear-a">⚙</div><div class="gear gear-b">⚙</div><div class="draft-line line-a"></div><div class="draft-line line-b"></div><b>2/5</b><small>ENGINEERING · DESIGN · BUILD</small></div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="engineering-hero-copy">
        <div class="classroom-kicker"><span></span> ENGINEERING WORKSHOP · SYSTEM READY · 2026</div>
        <p class="hello">ยินดีต้อนรับ <b>${escapeHTML(currentStudent[2])}</b> · เลขที่ ${escapeHTML(currentStudent[0])}</p>
        <h1>คิดให้เป็นระบบ<br><em>สร้างให้เป็นจริง</em></h1>
        <p class="classroom-lead">จากแบบร่างสู่ชิ้นงาน — ห้อง ม.2/5 รวมทุกความคิด ทุกแรงบันดาลใจ และทุกคนไว้ในทีมเดียวกัน</p>
        <div class="class-stats"><span><b>${classroom25.students.length}</b> ENGINEERS</span><span><b>${classroom25.advisors.length}</b> MENTORS</span><span><b>01</b> WORKSHOP</span></div>
      </div>
      <div class="scroll-signal" aria-hidden="true"><span></span>SCROLL TO OPEN BLUEPRINT</div>
    </section>
    <section class="advisor-section engineering-advisor-section">
      <div class="class-section-heading"><div><small>PROJECT MENTORS</small><h2>ครูที่ปรึกษา</h2></div><span>ผู้ช่วยวางรากฐาน ดูแลทุกขั้นตอน และพาทีม 2/5 ไปถึงเป้าหมาย</span></div>
      <div class="advisor-cards">${classroom25.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>MENTOR · 0${index + 1}</span></div>
          <div class="advisor-name-panel"><div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div><small class="advisor-title">${advisor.order} · PROJECT MENTOR</small><h3 class="advisor-name">${escapeHTML(advisor.name)}</h3><p class="advisor-role"><span>⚙</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 2/5</p><div class="advisor-code">ENGINEERING GUIDE · 0${index + 1}</div></div>
        </article>`).join('')}</div>
    </section>
    <section class="student-section engineering-student-section">
      <div class="class-section-heading"><div><small>TEAM DIRECTORY · 40 MEMBERS</small><h2>รายชื่อนักเรียน</h2></div><span>สมาชิกทุกคนคือชิ้นส่วนสำคัญของระบบห้อง 2/5</span></div>
      <div class="student-card-grid">${classroom25.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}" data-part="${String(number).padStart(2, '0')}"><div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>${escapeHTML(id)}</i></div><h3>${escapeHTML(name)}</h3><p>ENGINEERING CREW · M.2/5</p><div class="nickname"><small>ชื่อเล่น</small><strong>${nickname === '—' ? '—' : escapeHTML(nickname)}</strong></div>${id === studentId ? '<em class="you-badge">YOU</em>' : ''}</article>`).join('')}</div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom42() {
  const studentId = sessionStorage.getItem('classroom42Student');
  const currentStudent = classroom42.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom42; openRoomLogin(classroom42); return; }
  const host = $('#classroom42Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <div class="classroom-hero nature-hero">
      <div class="nature-scene" aria-hidden="true"><div class="nature-sun"></div><div class="nature-hill hill-back"></div><div class="nature-hill hill-front"></div><div class="nature-leaves">☘　⌁　☘</div><div class="nature-orbit">EARTH · AIR · WATER · LIFE</div></div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> NATURE & ENVIRONMENT · GROW TOGETHER · 2026</div>
        <h1>เติบโตไปด้วยกัน<br><em>ม.4/2</em></h1>
        <p>ยินดีต้อนรับ <b>${escapeHTML(currentStudent[3])}</b> — พลังสีเขียวทั้ง 40 คน ร่วมเรียนรู้ ดูแลโลก และสร้างห้องเรียนที่สดใสไปด้วยกัน</p>
        <div class="class-stats"><span><b>40</b> นักเรียน</span><span><b>2</b> ครูที่ปรึกษา</span><span><b>1</b> GREEN COMMUNITY</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>GREEN</small>4/2</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>DISCOVER OUR ECOSYSTEM</div>
    </div>
    <section class="advisor-section nature-advisor-section">
      <div class="class-section-heading"><div><small>OUR GREEN GUIDES</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>ผู้ดูแลและหล่อเลี้ยงทุกการเติบโตของชาวห้อง 4/2 🌿</span></div>
      <div class="advisor-cards">${classroom42.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>GREEN GUIDE · 0${index + 1}</span></div>
          <div class="advisor-name-panel"><div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div><small class="advisor-title">${advisor.order} · GREEN GUIDE</small><h3 class="advisor-name">${escapeHTML(advisor.name)}</h3><p class="advisor-role"><span>☘</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 4/2</p><div class="advisor-code">ECOSYSTEM GUIDE · 0${index + 1}</div></div>
        </article>`).join('')}</div>
    </section>
    <section class="student-section nature-student-section">
      <div class="class-section-heading"><div><small>40 SEEDS · ONE ECOSYSTEM</small><h2>สมาชิกห้อง ม.4/2</h2></div><span>เรียงตามเลขที่ · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom42.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}"><div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>☘</i></div><h3>${escapeHTML(name)}</h3><p>รหัส ${id} <b>·</b> ม.4/2 <b>·</b> เลขที่ ${number}</p><div class="nickname"><small>ชื่อเล่น</small><strong>${escapeHTML(nickname)}</strong></div>${id === studentId ? '<em class="you-badge">ต้นกล้าของคุณ!</em>' : ''}</article>`).join('')}</div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom38() {
  const studentId = sessionStorage.getItem('classroom38Student');
  const currentStudent = classroom38.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom38; openRoomLogin(classroom38); return; }
  const host = $('#classroom38Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <div class="classroom-hero computer-hero">
      <div class="computer-scene" aria-hidden="true"><div class="pixel-grid"></div><div class="code-window"><span>COMPUTER_CLASSROOM.exe</span><code>&gt; boot class_3/8<br>&gt; users: 38<br>&gt; mentors: 2<br>&gt; status: <b>ONLINE</b></code></div><div class="cursor-block"></div><div class="binary-stream">01001100 · 00111000 · CONNECTED · 2569</div></div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> COMPUTER CLASSROOM · SYSTEM ONLINE · 2026</div>
        <h1>เชื่อมต่อทุกไอเดีย<br><em>ม.3/8</em></h1>
        <p>ยินดีต้อนรับ <b>${escapeHTML(currentStudent[3])}</b> — ผู้ใช้งานทั้ง 38 คน พร้อมเรียนรู้ สร้างสรรค์ และเติบโตไปด้วยกันในห้องเรียนดิจิทัลของเรา</p>
        <div class="class-stats"><span><b>38</b> USERS</span><span><b>2</b> LAB MENTORS</span><span><b>1</b> CONNECTED CLASS</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>LAB</small>3/8</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>SCROLL TO ACCESS DATABASE</div>
    </div>
    <section class="advisor-section computer-advisor-section">
      <div class="class-section-heading"><div><small>SYSTEM ADMINISTRATORS</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>ผู้ดูแลระบบการเรียนรู้และคอยสนับสนุนชาวห้อง 3/8 ทุกคน 🖥️</span></div>
      <div class="advisor-cards">${classroom38.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>ADMIN · 0${index + 1}</span></div>
          <div class="advisor-name-panel"><div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div><small class="advisor-title">${advisor.order} · SYSTEM ADMIN</small><h3 class="advisor-name">${escapeHTML(advisor.name)}</h3><p class="advisor-role"><span>&gt;_</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 3/8</p><div class="advisor-code">ACCESS LEVEL · ADMIN 0${index + 1}</div></div>
        </article>`).join('')}</div>
    </section>
    <section class="student-section computer-student-section">
      <div class="class-section-heading"><div><small>38 USERS · ONE NETWORK</small><h2>ฐานข้อมูลสมาชิก ม.3/8</h2></div><span>ซิงค์จากไฟล์รายชื่อ · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom38.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}"><div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>&gt;_</i></div><h3>${escapeHTML(name)}</h3><p>USER ${id} <b>·</b> ม.3/8 <b>·</b> เลขที่ ${number}</p><div class="nickname"><small>DISPLAY NAME</small><strong>${escapeHTML(nickname)}</strong></div>${id === studentId ? '<em class="you-badge">บัญชีของคุณ!</em>' : ''}</article>`).join('')}</div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom36() {
  const studentId = sessionStorage.getItem('classroom36Student');
  const currentStudent = classroom36.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom36; openRoomLogin(classroom36); return; }
  const host = $('#classroom36Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <div class="classroom-hero art-hero">
      <div class="art-scene" aria-hidden="true"><div class="gallery-frame frame-a"><i></i></div><div class="gallery-frame frame-b"><i></i></div><div class="gallery-frame frame-c"><i></i></div><div class="art-sun"></div><div class="paint-stroke stroke-a"></div><div class="paint-stroke stroke-b"></div><div class="gallery-caption">ROOM 3/6 · LIVING GALLERY · 2569</div></div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> ART CLASSROOM · LIVING GALLERY · 2026</div>
        <h1>ทุกคนคือผลงาน<br><em>ม.3/6</em></h1>
        <p>ยินดีต้อนรับ <b>${escapeHTML(currentStudent[3])}</b> — ศิลปินทั้ง 38 คนร่วมแต่งแต้มไอเดีย เรื่องราว และความทรงจำให้ห้องเรียนของเราเป็นหอศิลป์ที่มีชีวิต</p>
        <div class="class-stats"><span><b>38</b> ARTISTS</span><span><b>2</b> CURATORS</span><span><b>1</b> LIVING GALLERY</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>GALLERY</small>3/6</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>ENTER THE EXHIBITION</div>
    </div>
    <section class="advisor-section art-advisor-section">
      <div class="class-section-heading"><div><small>OUR GALLERY CURATORS</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>ผู้ดูแลพื้นที่แห่งจินตนาการของชาวห้อง 3/6 ทุกคน 🎨</span></div>
      <div class="advisor-cards">${classroom36.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>CURATOR · 0${index + 1}</span></div>
          <div class="advisor-name-panel"><div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div><small class="advisor-title">${advisor.order} · GALLERY CURATOR</small><h3 class="advisor-name">${escapeHTML(advisor.name)}</h3><p class="advisor-role"><span>✦</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 3/6</p><div class="advisor-code">EXHIBITION GUIDE · 0${index + 1}</div></div>
        </article>`).join('')}</div>
    </section>
    <section class="student-section art-student-section">
      <div class="class-section-heading"><div><small>38 ARTISTS · ONE COLLECTION</small><h2>ฐานข้อมูลสมาชิก ม.3/6</h2></div><span>ซิงค์จากไฟล์รายชื่อ · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom36.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}"><div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>✦</i></div><h3>${escapeHTML(name)}</h3><p>ARTIST ${id} <b>·</b> ม.3/6 <b>·</b> เลขที่ ${number}</p><div class="nickname"><small>ARTIST NAME</small><strong>${escapeHTML(nickname)}</strong></div>${id === studentId ? '<em class="you-badge">ผลงานของคุณ!</em>' : ''}</article>`).join('')}</div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom43() {
  const studentId = sessionStorage.getItem('classroom43Student');
  const currentStudent = classroom43.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom43; openRoomLogin(classroom43); return; }
  const host = $('#classroom43Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <div class="classroom-hero robotics-hero">
      <div class="robotics-scene" aria-hidden="true">
        <div class="circuit-grid"></div><div class="robot-core"><i></i><span>AI</span></div>
        <div class="circuit-node node-one"></div><div class="circuit-node node-two"></div><div class="circuit-node node-three"></div>
        <div class="data-stream">0100 · 0011 · 4/3 · ONLINE</div>
      </div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> ROBOTICS LAB · SYSTEM ONLINE · 2026</div>
        <h1>ประกอบอนาคต<br><em>ม.4/3</em></h1>
        <p>ยินดีต้อนรับ <b>${escapeHTML(currentStudent[3])}</b> — วิศวกรรุ่นใหม่ 40 คน เชื่อมความคิดสร้างสรรค์ เทคโนโลยี และมิตรภาพเป็นทีมเดียวกัน</p>
        <div class="class-stats"><span><b>40</b> นักเรียน</span><span><b>2</b> LAB MENTORS</span><span><b>1</b> ROBOTICS CREW</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>UNIT</small>4/3</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>INITIALIZE CREW</div>
    </div>
    <section class="advisor-section robotics-advisor-section">
      <div class="class-section-heading"><div><small>OUR LAB MENTORS</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>ผู้ควบคุมภารกิจ ที่คอยเชื่อมทุกไอเดียให้กลายเป็นความสำเร็จ 🤖</span></div>
      <div class="advisor-cards">${classroom43.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>MENTOR · 0${index + 1}</span></div>
          <div class="advisor-name-panel">
            <div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div>
            <small class="advisor-title">${advisor.order} · LAB MENTOR</small>
            <h3 class="advisor-name">${escapeHTML(advisor.name)}</h3>
            <p class="advisor-role"><span>⌬</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 4/3</p>
            <div class="advisor-code">SYSTEM GUIDE · 0${index + 1}</div>
          </div>
        </article>`).join('')}
      </div>
    </section>
    <section class="student-section robotics-student-section">
      <div class="class-section-heading"><div><small>40 CONNECTED UNITS</small><h2>สมาชิกห้อง ม.4/3</h2></div><span>เรียงตามเลขที่ · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom43.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}">
          <div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>⌬</i></div>
          <h3>${escapeHTML(name)}</h3>
          <p>รหัส ${id} <b>·</b> ม.4/3 <b>·</b> เลขที่ ${number}</p>
          <div class="nickname"><small>ชื่อเล่น</small><strong>${escapeHTML(nickname)}</strong></div>
          ${id === studentId ? '<em class="you-badge">ยูนิตของคุณ!</em>' : ''}
        </article>`).join('')}
      </div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom511() {
  const studentId = sessionStorage.getItem('classroom511Student');
  const currentStudent = classroom511.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom511; openRoomLogin(classroom511); return; }
  const host = $('#classroom511Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <div class="classroom-hero geography-hero">
      <div class="geography-scene" aria-hidden="true">
        <div class="map-grid"></div><div class="topographic-lines topo-one"></div><div class="topographic-lines topo-two"></div>
        <div class="map-route"><i></i><i></i><i></i></div><div class="geo-compass">N<span>✦</span></div>
        <div class="geo-coordinate coordinate-one">15°N · 101°E</div><div class="geo-coordinate coordinate-two">EXPLORE · LEARN · GROW</div>
      </div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> OUR WORLD · OUR CLASS · 2026</div>
        <h1>ออกเดินทางไปด้วยกัน<br><em>ม.5/11</em></h1>
        <p>ยินดีต้อนรับ <b>${escapeHTML(currentStudent[3])}</b> — นักสำรวจทั้ง 40 คน บนแผนที่การเรียนรู้ผืนเดียวกัน พร้อมค้นพบโลกและสร้างความทรงจำไปด้วยกัน</p>
        <div class="class-stats"><span><b>40</b> นักเรียน</span><span><b>2</b> ครูที่ปรึกษา</span><span><b>1</b> EXPLORER TEAM</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>MAP</small>5/11</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>FOLLOW THE ROUTE</div>
    </div>
    <section class="advisor-section geography-advisor-section">
      <div class="class-section-heading"><div><small>OUR GUIDES</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>ผู้นำทางคนสำคัญ ที่คอยชี้พิกัดและดูแลทุกก้าวของห้อง 5/11 🧭</span></div>
      <div class="advisor-cards">${classroom511.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>FIELD GUIDE · ${String(index + 1).padStart(2, '0')}</span></div>
          <div class="advisor-name-panel">
            <div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div>
            <small class="advisor-title">${advisor.order} · FIELD GUIDE</small>
            <h3 class="advisor-name">${escapeHTML(advisor.name)}</h3>
            <p class="advisor-role"><span>⌖</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 5/11</p>
            <div class="advisor-code">MAP GUIDE · 0${index + 1}</div>
          </div>
        </article>`).join('')}
      </div>
    </section>
    <section class="student-section geography-student-section">
      <div class="class-section-heading"><div><small>40 WORLD EXPLORERS</small><h2>สมาชิกห้อง ม.5/11</h2></div><span>เรียงตามเลขที่ · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom511.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}">
          <div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>⌖</i></div>
          <h3>${escapeHTML(name)}</h3>
          <p>รหัส ${id} <b>·</b> ม.5/11 <b>·</b> เลขที่ ${number}</p>
          <div class="nickname"><small>ชื่อเล่น</small><strong>${escapeHTML(nickname)}</strong></div>
          ${id === studentId ? '<em class="you-badge">พิกัดของคุณ!</em>' : ''}
        </article>`).join('')}
      </div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom512() {
  const studentId = sessionStorage.getItem('classroom512Student');
  const currentStudent = classroom512.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom512; openRoomLogin(classroom512); return; }
  const host = $('#classroom512Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <div class="classroom-hero cinema-hero">
      <div class="cinema-scene" aria-hidden="true">
        <div class="cinema-curtain curtain-left"></div><div class="cinema-curtain curtain-right"></div>
        <div class="projector-beam"></div><div class="film-reel reel-one">◉</div><div class="film-reel reel-two">◉</div>
        <div class="film-strip"><i></i><i></i><i></i><i></i><i></i></div>
        <div class="cinema-stars">★　✦　★</div>
      </div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> NOW SHOWING · CLASS OF 2026</div>
        <h1>เรื่องราวของเรา<br><em>ม.5/12</em></h1>
        <p>ยินดีต้อนรับ <b>${escapeHTML(currentStudent[3])}</b> — นักแสดง 36 คนในภาพยนตร์เรื่องเดียวกัน พร้อมสร้างทุกฉากแห่งความทรงจำไปด้วยกัน</p>
        <div class="class-stats"><span><b>36</b> นักเรียน</span><span><b>2</b> ผู้กำกับดูแล</span><span><b>1</b> CINEMA CREW</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>SCREEN</small>5/12</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>ROLL THE CREDITS</div>
    </div>
    <section class="advisor-section cinema-advisor-section">
      <div class="class-section-heading"><div><small>OUR DIRECTORS</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>ผู้กำกับคนสำคัญ ที่คอยดูแลทุกฉากของห้อง 5/12 🎬</span></div>
      <div class="advisor-cards">${classroom512.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>TAKE ${String(index + 1).padStart(2, '0')}</span></div>
          <div class="advisor-name-panel">
            <div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div>
            <small class="advisor-title">${advisor.order} · DIRECTOR</small>
            <h3 class="advisor-name">${escapeHTML(advisor.name)}</h3>
            <p class="advisor-role"><span>★</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 5/12</p>
            <div class="advisor-code">DIRECTOR'S CREDIT · 0${index + 1}</div>
          </div>
        </article>`).join('')}
      </div>
    </section>
    <section class="student-section cinema-student-section">
      <div class="class-section-heading"><div><small>36 CAST MEMBERS</small><h2>สมาชิกห้อง ม.5/12</h2></div><span>เรียงตามเลขที่ · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom512.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}">
          <div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>★</i></div>
          <h3>${escapeHTML(name)}</h3>
          <p>รหัส ${id} <b>·</b> ม.5/12 <b>·</b> เลขที่ ${number}</p>
          <div class="nickname"><small>ชื่อเล่น</small><strong>${escapeHTML(nickname)}</strong></div>
          ${id === studentId ? '<em class="you-badge">บทนี้คือคุณ!</em>' : ''}
        </article>`).join('')}
      </div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom65() {
  const studentId = sessionStorage.getItem('classroom65Student');
  const currentStudent = classroom65.students.find((item) => item[1] === studentId);
  if (!currentStudent) { showPage('room-login'); return; }
  const host = $('#classroom65Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <div class="classroom-hero">
      <div class="space-scene" aria-hidden="true">
        <div class="stars stars-near"></div><div class="stars stars-far"></div>
        <div class="nebula nebula-one"></div><div class="nebula nebula-two"></div>
        <div class="planet planet-main"><i></i></div>
        <div class="planet planet-small"></div>
        <div class="orbit orbit-a"><span></span></div><div class="orbit orbit-b"><span></span></div>
        <div class="shooting-star shooting-one"></div><div class="shooting-star shooting-two"></div>
      </div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> WELCOME TO OUR CLASS · 2026</div>
        <h1>ห้องของเรา<br><em>ม.6/5</em></h1>
        <p>ยินดีต้อนรับ <b>${currentStudent[3]}</b> — พื้นที่รวมสมาชิกทั้ง 38 คน ที่เติบโต สนุก และสร้างความทรงจำไปด้วยกัน</p>
        <div class="class-stats"><span><b>38</b> นักเรียน</span><span><b>2</b> ครูที่ปรึกษา</span><span><b>1</b> ห้องของเรา</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>MISSION</small>6/5</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>EXPLORE THE CREW</div>
    </div>
    <section class="advisor-section">
      <div class="class-section-heading"><div><small>OUR ADVISORS</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>คนสำคัญที่คอยดูแลทุกก้าวของห้องห้า ✦</span></div>
      <div class="advisor-cards">${classroom65.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${advisor.name}" loading="lazy" decoding="async"><span>${String(index + 1).padStart(2, '0')}</span></div>
          <div class="advisor-name-panel">
            <div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div>
            <small class="advisor-title">${advisor.order}</small>
            <h3 class="advisor-name">${advisor.name}</h3>
            <p class="advisor-role"><span>✦</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 6/5</p>
            <div class="advisor-code">ADVISOR · 0${index + 1}</div>
          </div>
        </article>`).join('')}
      </div>
    </section>
    <section class="student-section">
      <div class="class-section-heading"><div><small>38 BRIGHT PEOPLE</small><h2>สมาชิกห้อง ม.6/5</h2></div><span>เรียงตามเลขที่ · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom65.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}">
          <div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>✦</i></div>
          <h3>${name}</h3>
          <p>รหัส ${id} <b>·</b> ม.6/5 <b>·</b> เลขที่ ${number}</p>
          <div class="nickname"><small>ชื่อเล่น</small><strong>${nickname}</strong></div>
          ${id === studentId ? '<em class="you-badge">คุณอยู่ตรงนี้!</em>' : ''}
        </article>`).join('')}
      </div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

function renderClassroom64() {
  const studentId = sessionStorage.getItem('classroom64Student');
  const currentStudent = classroom64.students.find((item) => item[1] === studentId);
  if (!currentStudent) { roomLoginClassroom = classroom64; openRoomLogin(classroom64); return; }
  const host = $('#classroom64Content');
  if (host.dataset.studentId === studentId && host.childElementCount) { observeClassroomSections(host); return; }
  host.innerHTML = `
    <div class="classroom-hero medical-hero">
      <div class="medical-scene" aria-hidden="true">
        <div class="medical-grid"></div><div class="medical-orb orb-one">+</div><div class="medical-orb orb-two">♡</div>
        <div class="ecg-line"><i></i></div><div class="dna-helix">●<br>╲╱<br>●<br>╱╲<br>●</div>
        <div class="medical-bubble bubble-one">Rx</div><div class="medical-bubble bubble-two">O₂</div>
      </div>
      <button class="room-back light" type="button" data-classroom-back>← กลับหน้าสมาชิก</button>
      <div class="classroom-hero-copy">
        <div class="classroom-kicker"><span></span> WELCOME TO OUR MEDICAL CREW · 2026</div>
        <h1>ห้องของเรา<br><em>ม.6/4</em></h1>
        <p>ยินดีต้อนรับ <b>${escapeHTML(currentStudent[3])}</b> — ทีมดูแลหัวใจ 30 คน ที่พร้อมเรียนรู้ เติบโต และรักษาความทรงจำดี ๆ ไปด้วยกัน</p>
        <div class="class-stats"><span><b>30</b> นักเรียน</span><span><b>2</b> ครูที่ปรึกษา</span><span><b>1</b> MEDICAL CREW</span></div>
      </div>
      <div class="classroom-big-number" aria-hidden="true"><small>WARD</small>6/4</div>
      <div class="scroll-signal" aria-hidden="true"><span></span>MEET THE CARE TEAM</div>
    </div>
    <section class="advisor-section medical-advisor-section">
      <div class="class-section-heading"><div><small>OUR CONSULTANTS</small><h2>ครูที่ปรึกษาของเรา</h2></div><span>คุณหมอประจำวอร์ด ผู้คอยดูแลทุกจังหวะการเติบโต ✚</span></div>
      <div class="advisor-cards">${classroom64.advisors.map((advisor, index) => `
        <article class="advisor-card advisor-card-${index + 1}">
          <div class="advisor-photo"><img src="${advisor.image}" alt="${escapeAttribute(advisor.name)}" loading="lazy" decoding="async"><span>DR ${String(index + 1).padStart(2, '0')}</span></div>
          <div class="advisor-name-panel">
            <div class="advisor-signal" aria-hidden="true"><i></i><i></i><i></i></div>
            <small class="advisor-title">${advisor.order} · CONSULTANT</small>
            <h3 class="advisor-name">${advisor.name}</h3>
            <p class="advisor-role"><span>✚</span> ครูที่ปรึกษาประจำชั้นมัธยมศึกษาปีที่ 6/4</p>
            <div class="advisor-code">MEDICAL ADVISOR · 0${index + 1}</div>
          </div>
        </article>`).join('')}
      </div>
    </section>
    <section class="student-section medical-student-section">
      <div class="class-section-heading"><div><small>30 CARE TEAM MEMBERS</small><h2>สมาชิกห้อง ม.6/4</h2></div><span>เรียงตามเลขที่ · ข้อมูลปีการศึกษา 2569</span></div>
      <div class="student-card-grid">${classroom64.students.map(([number, id, name, nickname]) => `
        <article class="student-card ${id === studentId ? 'is-current' : ''}">
          <div class="student-card-top"><span>${String(number).padStart(2, '0')}</span><i>✚</i></div>
          <h3>${escapeHTML(name)}</h3>
          <p>รหัส ${id} <b>·</b> ม.6/4 <b>·</b> เลขที่ ${number}</p>
          <div class="nickname"><small>ชื่อเล่น</small><strong>${escapeHTML(nickname)}</strong></div>
          ${id === studentId ? '<em class="you-badge">คุณอยู่ตรงนี้!</em>' : ''}
        </article>`).join('')}
      </div>
    </section>`;
  host.dataset.studentId = studentId;
  host.querySelector('[data-classroom-back]').addEventListener('click', () => showPage('members'));
  observeClassroomSections(host);
}

const heroArt = document.querySelector('.hero-art');
if (heroArt && window.matchMedia('(pointer:fine)').matches && !window.matchMedia('(prefers-reduced-motion:reduce)').matches) {
  let heroPointerFrame = 0;
  let heroPointerX = 0;
  let heroPointerY = 0;
  let heroPointerBounds = null;
  const heroFloaters = [...heroArt.querySelectorAll('.spark,.sticker')];
  heroArt.addEventListener('pointermove', (event) => {
    heroPointerX = event.clientX;
    heroPointerY = event.clientY;
    if (heroPointerFrame) return;
    heroPointerFrame = requestAnimationFrame(() => {
      heroPointerFrame = 0;
      if (!heroPointerBounds) heroPointerBounds = heroArt.getBoundingClientRect();
      const mx = ((heroPointerX - heroPointerBounds.left) / heroPointerBounds.width - .5) * 12;
      const my = ((heroPointerY - heroPointerBounds.top) / heroPointerBounds.height - .5) * 12;
      heroArt.style.setProperty('--mx', `${mx}px`);
      heroArt.style.setProperty('--my', `${my}px`);
      heroFloaters.forEach((item, index) => {
        item.style.marginLeft = `calc(var(--mx) * ${index % 2 ? -1 : 1})`;
        item.style.marginTop = `calc(var(--my) * ${index < 2 ? 1 : -.7})`;
      });
    });
  }, { passive: true });
  heroArt.addEventListener('pointerenter', () => { heroPointerBounds = heroArt.getBoundingClientRect(); }, { passive: true });
  heroArt.addEventListener('pointerleave', () => heroFloaters.forEach((item) => {
    item.style.marginLeft = '';
    item.style.marginTop = '';
  }));
  window.addEventListener('resize', () => { heroPointerBounds = null; }, { passive: true });
}

function renderElection() {
  const host = $('#electionContent');
  const electionConfig = getElectionConfig();
  const now = Date.now();
  const vote = getCurrentStudentVote();
  if (!electionConfig.enabled || !electionConfig.open || !electionConfig.close || !electionConfig.candidates.length) {
    host.innerHTML = electionNotice('ระบบเลือกตั้งยังไม่เปิดใช้งาน', 'ผู้ดูแลยังตั้งค่าผู้มีสิทธิ์ ผู้สมัคร หรือกำหนดการไม่ครบถ้วน');
    return;
  }
  if (now < new Date(electionConfig.open).getTime()) {
    host.innerHTML = electionNotice('ยังไม่เปิดหีบเลือกตั้ง', `เปิดให้ลงทะเบียนในวันที่ ${formatThaiDate(electionConfig.open)}`, 'waiting');
    startElectionRefresh(new Date(electionConfig.open).getTime());
    return;
  }
  if (now >= new Date(electionConfig.close).getTime() && !vote) {
    const resultAt = getResultTime(electionConfig);
    host.innerHTML = thanksHTML(resultAt, false);
    startTimer(resultAt);
    return;
  }
  if (vote) {
    host.innerHTML = thanksHTML();
    startTimer(getResultTime(electionConfig));
    return;
  }
  host.innerHTML = `<div class="election-register">
    <div class="register-visual"><span class="register-kicker">ELECTION 2026</span><div class="register-orbit"><i>✦</i><b>หนึ่งสิทธิ<br>หนึ่งเสียง</b></div><h3>เสียงของคุณ<br><em>กำหนดอนาคต</em></h3><p>ลงทะเบียนและยืนยันตัวตนก่อนเข้าสู่พื้นที่แนะนำผู้สมัคร</p></div>
    <div class="card login-shell election-login"><div class="step-chip">ขั้นตอน 1 จาก 3 · ลงทะเบียน</div><h3>ลงทะเบียนใช้สิทธิ</h3><p>ระบบจะตรวจสอบข้อมูลกับฐานรายชื่อนักเรียนและสิทธิ์ที่ผู้ดูแลกำหนด</p><form id="loginForm"><div class="field"><label>เลขประจำตัวนักเรียน</label><input id="studentId" required inputmode="numeric" maxlength="5" autocomplete="off" placeholder="เลขประจำตัว 5 หลัก"></div><div class="field"><label>รหัสผ่าน</label><input id="password" required type="password" inputmode="numeric" autocomplete="off" placeholder="เลขที่ 2 หลัก + ชั้น/ห้อง"></div><div class="note">ตัวอย่าง นักเรียนเลขที่ 01 ห้อง 6/5 ใช้รหัส <b>0165</b></div><div class="error" id="loginError" aria-live="polite"></div><button class="primary election-action">ตรวจสอบสิทธิ์และลงทะเบียน <b>→</b></button></form></div>
  </div>`;
  $('#loginForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const student = findElectionStudent($('#studentId').value.trim());
    const error = $('#loginError');
    if (!student || $('#password').value !== student.password) { error.textContent = 'เลขประจำตัวนักเรียนหรือรหัสผ่านไม่ถูกต้อง'; return; }
    if (!isStudentEligible(student, electionConfig)) { error.textContent = `ขออภัย นักเรียนชั้น ม.${student.grade}/${student.classroom} ไม่มีสิทธิ์ในการเลือกตั้งครั้งนี้`; return; }
    if (getVotes().some((item) => item.studentId === student.studentId)) { error.textContent = 'เลขประจำตัวนี้ใช้สิทธิ์เลือกตั้งแล้ว'; return; }
    sessionStorage.setItem('phanuang-election-student', JSON.stringify(student));
    renderCandidates();
  });
}

function renderCandidates() {
  const config = getElectionConfig();
  if (!getElectionStudent()) { renderElection(); return; }
  $('#electionContent').innerHTML = `<div class="candidate-showcase"><div class="showcase-stars" aria-hidden="true">✦ ✧ ✦ ✧ ✦</div><div class="step-chip light">ขั้นตอน 2 จาก 3 · ทำความรู้จักผู้สมัคร</div><h3>THE NEXT<br><em>PHUNRUEANG</em> LEADER</h3><p class="showcase-lead">รู้จักวิสัยทัศน์ของทุกคนให้ชัด ก่อนตัดสินใจด้วยเสียงของคุณ</p><div class="candidate-stage">${config.candidates.map((candidate, index) => candidateCard(candidate, index)).join('')}</div><button class="showcase-next" id="openBallot">ฉันพร้อมเลือกแล้ว <b>เข้าสู่คูหา →</b></button></div>`;
  $('#openBallot').addEventListener('click', renderBallot);
}

function candidateCard(candidate, index) {
  const photo = candidate.image ? `<img src="${candidate.image}" style="${candidateImageStyle(candidate, 'intro')}" alt="ภาพ ${escapeHTML(candidate.name)}">` : `<span class="candidate-initial">${escapeHTML(candidate.name).charAt(0)}</span>`;
  return `<article class="candidate-hero" style="--candidate-index:${index};--candidate-color:${candidate.color || '#d6a84f'}"><div class="candidate-number">0${escapeHTML(candidate.number)}</div><div class="candidate-photo">${photo}<i></i></div><div class="candidate-copy"><small>ผู้สมัครหมายเลข ${escapeHTML(candidate.number)}</small><h4>${escapeHTML(candidate.name)}</h4><p>${escapeHTML(candidate.vision || 'พร้อมรับฟังทุกเสียง และพาคณะพันเรืองก้าวไปด้วยกัน')}</p></div></article>`;
}
function renderBallot() {
  const config = getElectionConfig();
  selectedCandidate = null;
  $('#electionContent').innerHTML = `<div class="ballot-room"><div class="step-chip">ขั้นตอน 3 จาก 3 · บัตรเลือกตั้ง</div><div class="paper official-ballot"><div class="ballot-watermark">พันเรือง</div><header><span>บัตรเลือกตั้งประธานคณะสี</span><b>เลือกได้เพียงหมายเลขเดียว</b></header>${config.candidates.map((candidate) => `<button class="ballot-option" data-candidate="${escapeHTML(candidate.number)}"><span class="ballot-box"><i class="ink-one"></i><i class="ink-two"></i></span><span class="ballot-no">${escapeHTML(candidate.number)}</span><span class="ballot-name"><small>ผู้สมัครหมายเลข ${escapeHTML(candidate.number)}</small><b>${escapeHTML(candidate.name)}</b></span><span class="animated-pen" aria-hidden="true">✒</span></button>`).join('')}<button class="primary election-action" id="submitVote">พับบัตรและหย่อนลงหีบ <b>→</b></button><div class="error" id="voteError" aria-live="polite"></div></div></div>`;
  document.querySelectorAll('.ballot-option').forEach((option) => option.addEventListener('click', () => selectCandidate(option)));
  $('#submitVote').addEventListener('click', submitVote);
}
function selectCandidate(option) { document.querySelectorAll('.ballot-option').forEach((item) => item.classList.remove('selected')); option.classList.add('selected'); selectedCandidate = option.dataset.candidate; }
function submitVote() {
  if (!selectedCandidate) { $('#voteError').textContent = 'กรุณากากบาทเลือกผู้สมัคร 1 คนก่อนส่งบัตร'; return; }
  const student = getElectionStudent();
  const config = getElectionConfig();
  if (!student || Date.now() >= new Date(config.close).getTime()) { renderElection(); return; }
  const votes = getVotes();
  if (votes.some((item) => item.studentId === student.studentId)) { renderElection(); return; }
  votes.push({ electionId: config.electionId, studentId: student.studentId, room: `${student.grade}/${student.classroom}`, candidate: selectedCandidate, time: Date.now() });
  localStorage.setItem('phanuang-election-votes', JSON.stringify(votes));
  localStorage.setItem('phanuang-vote', JSON.stringify({ electionId: config.electionId, studentId: student.studentId, candidate: selectedCandidate, time: Date.now() }));
  renderBallotCasting(config, selectedCandidate);
}
function renderBallotCasting(config, candidateNumber) {
  const candidate = config.candidates.find((item) => String(item.number) === String(candidateNumber));
  $('#electionContent').innerHTML = `<div class="ballot-casting-ceremony" role="status" aria-live="polite"><div class="casting-cosmos"><i></i><i></i><i></i></div><div class="casting-title"><small>THE SACRED BALLOT RITUAL</small><h3>กำลังผนึกดวงเสียงของคุณ</h3><p>โปรดรอสักครู่ ขณะบัตรถูกพับและหย่อนลงสู่หีบ</p></div><div class="casting-stage"><div class="casting-ballot-wrap"><div class="casting-ballot"><div class="casting-ballot-face"><header><span>✦</span><b>บัตรเลือกตั้งพันเรือง</b><span>☾</span></header><div class="casting-choice"><i>×</i><span><small>ผู้สมัครหมายเลข ${escapeHTML(candidateNumber)}</small><b>${escapeHTML(candidate?.name || '')}</b></span></div><footer>หนึ่งสิทธิ · หนึ่งเสียง · หนึ่งคำพยากรณ์</footer></div><div class="fold-crease crease-h"></div><div class="fold-crease crease-v"></div><div class="fold-panel fold-top"></div><div class="fold-panel fold-left"></div></div></div><div class="sacred-ballot-box"><div class="box-aura"></div><div class="ballot-slot"><i></i></div><div class="box-face"><span>☉</span><b>หีบผนึกดวงเสียง</b><small>PHUNRUEANG ELECTION</small></div></div><div class="cast-confirmation"><span>✦</span><b>บันทึกดวงเสียงเรียบร้อย</b></div></div></div>`;
  window.setTimeout(() => { if (!$('#electionContent .ballot-casting-ceremony')) return; $('#electionContent').innerHTML = thanksHTML(); startTimer(getResultTime(config)); }, 4700);
}
function thanksHTML(resultAt = getResultTime(getElectionConfig()), didVote = true) { return `<div class="thanks result-wait"><div class="thank-spark">✦</div><div class="section-label">${didVote ? 'YOUR VOTE IS RECORDED' : 'THE POLL IS CLOSED'}</div><div class="big">${didVote ? 'ขอบคุณที่มาใช้สิทธิ' : 'ปิดหีบเลือกตั้งแล้ว'}</div><p>${didVote ? 'เสียงของคุณถูกเก็บเป็นความลับและบันทึกเรียบร้อยแล้ว' : 'กำลังตรวจสอบและนับคะแนนจากทุกห้อง'}</p><div class="countdown-card"><small>COUNTDOWN TO THE REVEAL</small><b>ประกาศผลในอีก</b><div class="countdown" id="countdown">00:00:00</div><p id="countText">ปิดหีบแล้ว · กำลังนับคะแนนอย่างเป็นทางการ</p><time>${formatThaiDate(resultAt)}</time></div><div id="results"></div></div>`; }
function startTimer(end) {
  clearInterval(window.voteTimer);
  const update = () => {
    const diff = Math.max(0, end - Date.now());
    const values = [Math.floor(diff / 36e5), Math.floor(diff % 36e5 / 6e4), Math.floor(diff % 6e4 / 1e3)];
    const clock = $('#countdown');
    if (!clock) { clearInterval(window.voteTimer); return; }
    clock.textContent = values.map((value) => String(value).padStart(2, '0')).join(':');
    if (!diff) { clearInterval(window.voteTimer); renderResults(); }
  };
  update();
  window.voteTimer = setInterval(update, 1000);
}
function renderResults() {
  const config = getElectionConfig();
  const votes = getVotes();
  const rooms = [...new Set(getElectionStudents().map((student) => `${student.grade}/${student.classroom}`))].slice(0, 6);
  const totals = config.candidates.map((candidate) => ({ ...candidate, votes: votes.filter((vote) => vote.candidate === String(candidate.number)).length })).sort((a, b) => b.votes - a.votes || Number(a.number) - Number(b.number));
  $('#electionContent').innerHTML = `<div class="results-universe results-dashboard">
    <div class="result-cinematic" aria-hidden="true"><div class="cinematic-stars"></div><div class="cinematic-zodiac">♈　♉　♊　♋　♌　♍　♎　♏　♐　♑　♒　♓</div><div class="cinematic-portal"><i></i><i></i><i></i><span>✦</span></div><div class="cinematic-copy"><small>THE CELESTIAL VERDICT</small><b>บทบัญชาแห่งดวงดาว</b><em>ชะตาได้ถูกเปิดเผยแล้ว</em></div></div>
    <div class="occult-corners" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <header class="results-header"><div><small>THE CELESTIAL VERDICT · OFFICIAL RESULT</small><h3>บัญชาดวงดาว</h3><p>ผลการเลือกตั้งประธานคณะสีพันเรือง</p></div><div class="result-status"><i></i><span>นับคะแนนเสร็จสิ้น</span><b>${votes.length} เสียง</b></div></header>
    <nav class="result-tabs" aria-label="รูปแบบผลการเลือกตั้ง"><button class="active" data-result-tab="overview">✦ ภาพรวม</button><button data-result-tab="rooms">☾ ผลรายห้อง</button></nav>
    <main class="result-panel" id="resultPanel"></main>
  </div>`;
  document.querySelectorAll('.result-tabs button').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.result-tabs button').forEach((item) => item.classList.toggle('active', item === button));
    if (button.dataset.resultTab === 'overview') renderResultOverview(totals, rooms, config, votes);
    else renderRoomDashboard(rooms, config, votes);
  }));
  renderResultOverview(totals, rooms, config, votes);
  // The reveal has already faded to visibility:hidden at this point. Pause its
  // nested infinite animations so they do not consume frames behind the page.
  window.setTimeout(() => document.querySelector('.result-cinematic')?.classList.add('is-finished'), 5500);
}
function renderResultOverview(totals, rooms, config, votes) {
  const maxVotes = Math.max(1, ...totals.map((item) => item.votes));
  $('#resultPanel').innerHTML = `<section class="overview-layout"><div class="prophecy-stage"><div class="celestial-rays" aria-hidden="true"></div><div class="prophecy-title"><span>♆</span><small>THE CARDS HAVE SPOKEN</small><h4>ไพ่แห่งผลลัพธ์</h4></div><div class="result-card-deck">${totals.map((candidate, index) => resultCandidateCard(candidate, index)).join('')}</div><div class="winner-prophecy">${totals[0] ? `<span>✦ คำพยากรณ์ลำดับที่หนึ่ง ✦</span><b>${escapeHTML(totals[0].name)}</b><small>ได้รับความไว้วางใจ ${totals[0].votes} คะแนน</small>` : 'ยังไม่มีคะแนน'}</div></div><aside class="room-summary"><header><div><small>CONSTELLATION TABLE</small><h4>สรุปคะแนนรายห้อง</h4></div><span>☽</span></header><div class="summary-table" style="--candidate-count:${config.candidates.length}"><div class="summary-row summary-head"><b>ห้อง</b>${config.candidates.map((candidate) => `<span style="--candidate-color:${candidate.color || '#d6a84f'}">เบอร์ ${escapeHTML(candidate.number)}</span>`).join('')}<strong>ใช้สิทธิ์</strong></div>${rooms.map((room) => { const roomVotes = votes.filter((vote) => vote.room === room); return `<button class="summary-row" data-summary-room="${room}"><b>ม.${room}</b>${config.candidates.map((candidate) => `<span style="--candidate-color:${candidate.color || '#d6a84f'}">${roomVotes.filter((vote) => vote.candidate === String(candidate.number)).length}</span>`).join('')}<strong>${roomVotes.length}</strong></button>`; }).join('')}</div><div class="candidate-legend">${totals.map((item, index) => `<div><i style="--candidate-color:${item.color || '#d6a84f'}"></i><span>อันดับ ${index + 1} · เบอร์ ${escapeHTML(item.number)}</span><b>${item.votes}</b><progress value="${item.votes}" max="${maxVotes}"></progress></div>`).join('')}</div></aside></section>`;
  document.querySelectorAll('[data-summary-room]').forEach((button) => button.addEventListener('click', () => {
    document.querySelector('[data-result-tab="rooms"]').click();
    renderRoomDashboard(rooms, config, votes, button.dataset.summaryRoom);
  }));
  window.setTimeout(() => document.querySelectorAll('.prophecy-card').forEach((card) => card.classList.add('revealed')), 700);
}
function resultCandidateCard(candidate, index) {
  const photo = candidate.image ? `<img src="${candidate.image}" style="${candidateImageStyle(candidate, 'result')}" alt="ภาพ ${escapeHTML(candidate.name)}">` : `<span class="card-initial">${escapeHTML(candidate.name).charAt(0)}</span>`;
  return `<article class="prophecy-card ${index === 0 ? 'first-place' : ''}" style="--rank-shift:${index * 8}px;--rank-angle:${(index - 1) * 4}deg;--rank-delay:${index * .22}s;--candidate-color:${candidate.color || '#d6a84f'}"><div class="card-divine-rays"></div><div class="prophecy-card-inner"><div class="card-back"><i class="tarot-corner c1"></i><i class="tarot-corner c2"></i><i class="tarot-corner c3"></i><i class="tarot-corner c4"></i><div class="tarot-sigil"><span>☾</span>✦<span>☽</span></div><b>พันเรือง</b><span>PHUNRUEANG</span><small>THE ELECTION ARCANA</small></div><div class="card-front"><i class="tarot-corner c1"></i><i class="tarot-corner c2"></i><i class="tarot-corner c3"></i><i class="tarot-corner c4"></i><div class="arcana-number">${String(index + 1).padStart(2, '0')}</div><div class="card-rank">${index === 0 ? '✦ THE CHOSEN ONE ✦' : `ARCANA · RANK ${index + 1}`}</div><div class="card-portrait">${photo}<b>หมายเลข ${escapeHTML(candidate.number)}</b><span class="portrait-moon">☽</span></div><div class="card-result"><small>คำพยากรณ์แห่งเสียงประชาชน</small><h5>${escapeHTML(candidate.name)}</h5><div><strong>${candidate.votes}</strong><span>คะแนน</span></div></div><div class="card-oracle-mark">☉　✦　☾</div></div></div></article>`;
}
function renderRoomDashboard(rooms, config, votes, selectedRoom = rooms[0]) {
  const room = selectedRoom || rooms[0];
  $('#resultPanel').innerHTML = `<section class="room-dashboard sacred-room-dashboard"><div class="chamber-title"><span>☾</span><div><small>THE SIX CELESTIAL CHAMBERS</small><h4>มหาสภาแห่งดวงเสียง</h4><p>เลือกกลุ่มดาวประจำห้อง เพื่อเปิดผนึกผลคะแนนและชะตาของสมาชิก</p></div><span>☽</span></div><aside class="room-selector constellation-gates">${rooms.map((item, index) => `<button class="${item === room ? 'active' : ''}" data-room-map="${item}" style="--gate-index:${index}"><i class="gate-orbit"></i><span>${['♈','♉','♊','♋','♌','♍'][index] || '✦'}</span><small>CELESTIAL CHAMBER ${String(index + 1).padStart(2,'0')}</small><b>ม.${item}</b><em>เปิดคำพยากรณ์</em></button>`).join('')}</aside><div class="room-map-host" id="roomMapHost"></div></section>`;
  document.querySelectorAll('[data-room-map]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-room-map]').forEach((item) => item.classList.toggle('active', item === button));
    renderRoomSeatMap(button.dataset.roomMap, config, votes);
  }));
  renderRoomSeatMap(room, config, votes);
}
function renderRoomSeatMap(room, config, votes) {
  const students = getElectionStudents().filter((student) => `${student.grade}/${student.classroom}` === room);
  const roomVotes = votes.filter((vote) => vote.room === room);
  const candidateCounts = config.candidates.map((candidate) => ({ ...candidate, votes: roomVotes.filter((vote) => vote.candidate === String(candidate.number)).length }));
  const seats = students.map((student, index) => {
    const vote = roomVotes.find((item) => item.studentId === student.studentId);
    const candidate = vote && config.candidates.find((item) => String(item.number) === vote.candidate);
    const angle = -78 + (index % 13) * 13;
    const row = Math.floor(index / 13);
    return `<i class="parliament-seat ${candidate ? 'voted' : ''}" style="--seat-color:${candidate?.color || '#26324b'};--seat-angle:${angle}deg;--seat-radius:${215 + row * 68}px;--seat-delay:${index * .025}s" title="${candidate ? `คะแนนของผู้สมัครหมายเลข ${candidate.number}` : 'ยังไม่ใช้สิทธิ์'}"></i>`;
  }).join('');
  const roomIndex = Math.max(0, [...new Set(getElectionStudents().map((student) => `${student.grade}/${student.classroom}`))].indexOf(room));
  const zodiac = ['♈','♉','♊','♋','♌','♍'][roomIndex] || '✦';
  $('#roomMapHost').innerHTML = `<div class="room-revelation"><header class="room-map-head"><div class="room-sacred-seal"><i></i><span>${zodiac}</span></div><div><small>CELESTIAL CHAMBER ${String(roomIndex + 1).padStart(2,'0')} · THE ORACLE IS OPEN</small><h4>สภาดวงเสียงแห่งห้อง ม.${room}</h4><p>ทุกอัญมณีคือหนึ่งเสียงที่ถูกจารึกไว้ในวงโคจรแห่งพันเรือง</p></div><div class="turnout-orb"><strong>${roomVotes.length}</strong><span>จาก ${students.length}</span><small>ดวงเสียง</small></div></header><div class="sacred-map-frame"><i class="frame-wing left"></i><i class="frame-wing right"></i><div class="parliament-map"><div class="chamber-zodiac-ring" aria-hidden="true">♈　♉　♊　♋　♌　♍　♎　♏　♐　♑　♒　♓</div><div class="map-stars" aria-hidden="true">✦　·　✧　·　☾　·　✦　·　☽　·　✧　·　✦</div><div class="seat-orbit-line orbit-line-one"></div><div class="seat-orbit-line orbit-line-two"></div><div class="seat-orbit-line orbit-line-three"></div><div class="seat-orbits">${seats}</div><div class="speaker-oracle"><i></i><span>☉</span><b>แท่นผนึกดวงเสียง</b><small>THE SACRED BALLOT</small></div><div class="floor-sigil">✦</div></div></div><div class="room-candidate-summary sacred-tallies">${candidateCounts.map((candidate, index) => `<div style="--candidate-color:${candidate.color || '#d6a84f'}"><span class="tally-arcana">${String(index + 1).padStart(2,'0')}</span><i></i><span>ผู้สมัครหมายเลข ${escapeHTML(candidate.number)}<small>${escapeHTML(candidate.name)}</small></span><b>${candidate.votes}<small>ดวงเสียง</small></b></div>`).join('')}<div class="not-voted"><span class="tally-arcana">☾</span><i></i><span>ดวงเสียงที่ยังไม่ถูกจารึก<small>ยังไม่ใช้สิทธิ์</small></span><b>${Math.max(0, students.length - roomVotes.length)}<small>คน</small></b></div></div></div>`;
}
function getElectionConfig() {
  const saved = JSON.parse(localStorage.getItem('phanuang-election-config') || '{}');
  return { electionId: 'election-2026-initial', enabled: false, open: '', close: '', countMinutes: 15, grades: [4, 5, 6], rooms: ['4/2', '4/3', '5/11', '5/12', '6/4', '6/5'], studentOverrides: [], candidates: [], ...saved };
}
function getElectionStudents() {
  return Object.values(CLASSROOM_DATABASE).flatMap((classroom) => {
    const [grade, roomNumber] = classroom.room.split('/').map(Number);
    return classroom.students.map(([number, studentId, name]) => ({ studentId, name, number: String(number).padStart(2, '0'), grade, classroom: roomNumber, room: classroom.room, password: `${String(number).padStart(2, '0')}${grade}${roomNumber}` }));
  });
}
function findElectionStudent(studentId) { return getElectionStudents().find((student) => student.studentId === studentId); }
function isStudentEligible(student, config) { const override = config.studentOverrides.find((item) => item.studentId === student.studentId); if (override) return override.allowed; return config.grades.includes(student.grade) && (!config.rooms.length || config.rooms.includes(student.room)); }
function getElectionStudent() { return JSON.parse(sessionStorage.getItem('phanuang-election-student') || 'null'); }
function getVotes() { const electionId = getElectionConfig().electionId; return JSON.parse(localStorage.getItem('phanuang-election-votes') || '[]').filter((vote) => vote.electionId === electionId); }
function getCurrentStudentVote() { const config = getElectionConfig(); const localVote = JSON.parse(localStorage.getItem('phanuang-vote') || 'null'); return localVote?.electionId === config.electionId ? localVote : null; }
function getResultTime(config) { return new Date(config.close).getTime() + Math.max(0, Number(config.countMinutes) || 0) * 60000; }
function formatThaiDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); }
function escapeHTML(value = '') { const node = document.createElement('div'); node.textContent = String(value); return node.innerHTML; }
function candidateImageStyle(candidate, context = 'intro') { const prefix = context === 'result' ? 'result' : 'intro'; const x = Math.min(100, Math.max(0, Number(candidate[`${prefix}ImageX`] ?? candidate.imageX ?? 50))); const y = Math.min(100, Math.max(0, Number(candidate[`${prefix}ImageY`] ?? candidate.imageY ?? 50))); const zoom = Math.min(2.5, Math.max(1, Number(candidate[`${prefix}ImageZoom`] ?? candidate.imageZoom ?? 1))); return `object-position:${x}% ${y}%;transform:scale(${zoom})`; }
function electionNotice(title, message, tone = '') { return `<div class="election-notice ${tone}"><div class="notice-icon">✦</div><small>ELECTION CONTROL</small><h3>${title}</h3><p>${message}</p><span>สถานะนี้ควบคุมจากศูนย์ ADMIN</span></div>`; }
function startElectionRefresh(at) { clearTimeout(window.electionRefresh); window.electionRefresh = setTimeout(() => { if ($('#election').classList.contains('active')) renderElection(); }, Math.min(Math.max(1000, at - Date.now()), 60000)); }

const STORE_KEY = 'phanuang-store-products';
const STORE_MEDIA_DB = 'phanuang-store-media-db';
const STORE_MEDIA_TABLE = 'product-media';
let storeProductsRuntime = [];
function openStoreMediaDatabase(){return new Promise((resolve,reject)=>{const request=indexedDB.open(STORE_MEDIA_DB,1);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE_MEDIA_TABLE))request.result.createObjectStore(STORE_MEDIA_TABLE);};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function readStoreMedia(productId){try{const shared=JSON.parse(localStorage.getItem(`phanuang-store-media-${productId}`)||'null');if(shared)return shared;}catch(_){}const database=await openStoreMediaDatabase();return new Promise((resolve,reject)=>{const transaction=database.transaction(STORE_MEDIA_TABLE,'readonly'),request=transaction.objectStore(STORE_MEDIA_TABLE).get(productId);request.onsuccess=()=>resolve(request.result||{});request.onerror=()=>reject(request.error);transaction.oncomplete=()=>database.close();});}
async function writeStoreMedia(productId,media){localStorage.setItem(`phanuang-store-media-${productId}`,JSON.stringify(media));const database=await openStoreMediaDatabase();return new Promise((resolve,reject)=>{const transaction=database.transaction(STORE_MEDIA_TABLE,'readwrite');transaction.objectStore(STORE_MEDIA_TABLE).put(media,productId);transaction.oncomplete=()=>{database.close();resolve();};transaction.onerror=()=>reject(transaction.error);});}
async function hydrateStoreProducts(products){const hydrated=await Promise.all(products.map(async product=>({...product,...await readStoreMedia(product.id)})));storeProductsRuntime=hydrated;return hydrated;}
const STORE_LOOKBOOK_KEY='phanuang-store-lookbook-config';
async function getStoreLookbook(){let config={sourceProductId:'',finishProductId:'',tolerance:42};try{config={...config,...JSON.parse(localStorage.getItem(STORE_LOOKBOOK_KEY)||'{}')};}catch(_){}return {...config,...await readStoreMedia('__lookbook_model__')};}
async function saveStoreLookbook(config){await writeStoreMedia('__lookbook_model__',{image:config.image||''});localStorage.setItem(STORE_LOOKBOOK_KEY,JSON.stringify({sourceProductId:config.sourceProductId||'',finishProductId:config.finishProductId||config.sourceProductId||'',tolerance:Number(config.tolerance)||42}));}
function removeImageBackground(source,tolerance=42){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{try{const canvas=document.createElement('canvas'),max=1400,scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight));canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,canvas.width,canvas.height);const frame=context.getImageData(0,0,canvas.width,canvas.height),data=frame.data,corners=[[0,0],[canvas.width-1,0],[0,canvas.height-1],[canvas.width-1,canvas.height-1]],colors=corners.map(([x,y])=>{const index=(y*canvas.width+x)*4;return [data[index],data[index+1],data[index+2]];}),background=colors.reduce((sum,color)=>sum.map((value,index)=>value+color[index]),[0,0,0]).map(value=>value/colors.length),soft=Math.max(8,tolerance*.35);for(let index=0;index<data.length;index+=4){const distance=Math.sqrt((data[index]-background[0])**2+(data[index+1]-background[1])**2+(data[index+2]-background[2])**2);if(distance<tolerance)data[index+3]=0;else if(distance<tolerance+soft)data[index+3]=Math.round(255*(distance-tolerance)/soft);}context.putImageData(frame,0,0);resolve(canvas.toDataURL('image/png'));}catch(error){reject(error);}};image.onerror=()=>reject(new Error('อ่านรูปไม่ได้'));image.src=source;});}
function removeImageBackgroundSmart(source,tolerance=42){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{try{const canvas=document.createElement('canvas'),max=1600,scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight)),width=Math.max(1,Math.round(image.naturalWidth*scale)),height=Math.max(1,Math.round(image.naturalHeight*scale));canvas.width=width;canvas.height=height;const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0,width,height);const frame=context.getImageData(0,0,width,height),data=frame.data,total=width*height,removed=new Uint8Array(total),queued=new Uint8Array(total),queue=new Int32Array(total),border=[];const sampleStep=Math.max(1,Math.floor(Math.min(width,height)/35)),colorAt=pixel=>{const offset=pixel*4;return [data[offset],data[offset+1],data[offset+2]];};for(let x=0;x<width;x+=sampleStep){border.push(colorAt(x),colorAt((height-1)*width+x));}for(let y=0;y<height;y+=sampleStep){border.push(colorAt(y*width),colorAt(y*width+width-1));}const clusters=[];border.forEach(color=>{let best=null,bestDistance=Infinity;clusters.forEach(cluster=>{const distance=Math.hypot(color[0]-cluster.r,color[1]-cluster.g,color[2]-cluster.b);if(distance<bestDistance){bestDistance=distance;best=cluster;}});if(!best||bestDistance>Math.max(18,tolerance*.55)){clusters.push({r:color[0],g:color[1],b:color[2],n:1});}else{best.n++;best.r+=(color[0]-best.r)/best.n;best.g+=(color[1]-best.g)/best.n;best.b+=(color[2]-best.b)/best.n;}});clusters.sort((a,b)=>b.n-a.n);const palette=clusters.slice(0,10),weightedDistance=(r,g,b,color)=>Math.sqrt(.28*(r-color.r)**2+.58*(g-color.g)**2+.14*(b-color.b)**2),backgroundDistance=pixel=>{const offset=pixel*4,r=data[offset],g=data[offset+1],b=data[offset+2];let minimum=Infinity;for(const color of palette)minimum=Math.min(minimum,weightedDistance(r,g,b,color));return minimum;},threshold=Math.max(12,Number(tolerance)),soft=Math.max(7,threshold*.45);let head=0,tail=0;const enqueue=pixel=>{if(pixel<0||pixel>=total||queued[pixel])return;queued[pixel]=1;queue[tail++]=pixel;};for(let x=0;x<width;x++){enqueue(x);enqueue((height-1)*width+x);}for(let y=1;y<height-1;y++){enqueue(y*width);enqueue(y*width+width-1);}while(head<tail){const pixel=queue[head++],distance=backgroundDistance(pixel);if(distance>threshold+soft)continue;removed[pixel]=distance<=threshold?255:Math.round(255*(1-(distance-threshold)/soft));const x=pixel%width,y=Math.floor(pixel/width);if(x>0)enqueue(pixel-1);if(x<width-1)enqueue(pixel+1);if(y>0)enqueue(pixel-width);if(y<height-1)enqueue(pixel+width);}const refined=new Uint8Array(removed);for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){const pixel=y*width+x;if(removed[pixel]===255)continue;let neighbors=0;for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++)neighbors+=removed[pixel+yy*width+xx]>180?1:0;if(neighbors>=6)refined[pixel]=Math.max(refined[pixel],190);}for(let pixel=0;pixel<total;pixel++){const alpha=refined[pixel];if(!alpha)continue;const offset=pixel*4;data[offset+3]=Math.round(data[offset+3]*(1-alpha/255));if(data[offset+3]>0&&data[offset+3]<220){const spill=Math.min(1,alpha/255);data[offset]=Math.round(data[offset]*(1-spill*.08));data[offset+1]=Math.round(data[offset+1]*(1-spill*.08));data[offset+2]=Math.round(data[offset+2]*(1-spill*.08));}}/* เก็บเฉพาะวัตถุหลัก ตัดเงาและเศษพื้นหลังที่ลอยแยกจากเสื้อ */const visited=new Uint8Array(total),componentQueue=new Int32Array(total),components=[];for(let seed=0;seed<total;seed++){if(visited[seed]||data[seed*4+3]<28)continue;let qh=0,qt=0,sumX=0,sumY=0;visited[seed]=1;componentQueue[qt++]=seed;const pixels=[];while(qh<qt){const pixel=componentQueue[qh++],x=pixel%width,y=Math.floor(pixel/width);pixels.push(pixel);sumX+=x;sumY+=y;const candidates=[x?pixel-1:-1,x<width-1?pixel+1:-1,y?pixel-width:-1,y<height-1?pixel+width:-1];for(const next of candidates)if(next>=0&&!visited[next]&&data[next*4+3]>=28){visited[next]=1;componentQueue[qt++]=next;}}components.push({pixels,size:pixels.length,cx:sumX/pixels.length,cy:sumY/pixels.length});}if(components.length>1){components.sort((a,b)=>{const score=item=>item.size/(1+Math.hypot(item.cx-width/2,item.cy-height/2)/Math.max(width,height));return score(b)-score(a);});const keep=components[0],minimum=Math.max(16,keep.size*.035);components.slice(1).forEach(component=>{if(component.size<minimum||component.cy>keep.cy+height*.16)component.pixels.forEach(pixel=>data[pixel*4+3]=0);});}context.putImageData(frame,0,0);resolve(canvas.toDataURL('image/png'));}catch(error){reject(error);}};image.onerror=()=>reject(new Error('อ่านรูปไม่ได้'));image.src=source;});}
const ORDER_ROOM_DATABASE = {
  '2/1': classroom21.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name})),
  '2/5': classroom25.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name})),
  '3/6': classroom36.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name})),
  '3/8': classroom38.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name})),
  '4/2': classroom42.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name})),
  '4/3': classroom43.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name})),
  '5/11': classroom511.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name})),
  '5/12': classroom512.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name})),
  '6/4': classroom64.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name})),
  '6/5': classroom65.students.map(([number,studentId,name])=>({number:String(number).padStart(2,'0'),studentId,name}))
};
const DEFAULT_PRODUCTS = [
  {id:'cheer-tee',name:'เสื้อเชียร์พันเรือง',category:'เสื้อผ้า',price:199,comparePrice:249,badge:'BEST SELLER',stock:84,published:true,sizes:['S','M','L','XL','2XL'],color:'#e8b21e',description:'เสื้อเชียร์ผ้านุ่ม ใส่สบาย พร้อมลายเอกลักษณ์ของพันเรือง',image:'',video:'',lookImage:'',lookTitle:'Everyday Cheer',lookText:'จับคู่กับกางเกงยีนส์หรือกางเกงกีฬาสีเข้ม ได้ลุคคล่องตัวที่ใส่ได้ทั้งวัน'},
  {id:'sport-jersey',name:'เสื้อกีฬาคณะสี',category:'เสื้อผ้า',price:259,comparePrice:299,badge:'NEW DROP',stock:46,published:true,sizes:['S','M','L','XL'],color:'#356b54',description:'เสื้อกีฬาเนื้อเบา ระบายอากาศดี ตัดต่อสีเหลือง–เขียวโดดเด่น',image:'',video:'',lookImage:'',lookTitle:'Match Day Ready',lookText:'ใส่กับกางเกงวอร์มสีดำและรองเท้าผ้าใบ เพิ่มถุงเท้าข้อยาวให้ลุคสปอร์ตเต็มตัว'},
  {id:'spirit-tote',name:'กระเป๋าผ้าพันเรือง',category:'ของที่ระลึก',price:129,comparePrice:0,badge:'LIMITED',stock:30,published:true,sizes:['FREE SIZE'],color:'#bd7b24',description:'กระเป๋าผ้าแคนวาสพิมพ์ลาย ใช้สะพายไปเรียนหรือวันแข่งกีฬา',image:'',video:'',lookImage:'',lookTitle:'Campus Carry',lookText:'สะพายคู่กับเสื้อสีพื้นโทนอุ่น ช่วยเติมสีของคณะโดยไม่ต้องแต่งเยอะ'}
];
function getStoreProducts(){ try { const saved=JSON.parse(localStorage.getItem(STORE_KEY)||'null'); return Array.isArray(saved)?saved:DEFAULT_PRODUCTS; } catch(_){ return DEFAULT_PRODUCTS; } }
async function saveStoreProducts(products){await Promise.all(products.map(product=>writeStoreMedia(product.id,{image:product.image||'',video:product.video||'',lookImage:product.lookImage||'',lookImages:product.lookImages||[]})));const metadata=products.map(({image,video,lookImage,lookImages,...product})=>product);localStorage.setItem(STORE_KEY,JSON.stringify(metadata));storeProductsRuntime=products;if(navigator.storage?.persist)try{await navigator.storage.persist();}catch(_){} }
const STORE_SIZE_OPTIONS=['XXS','XS','S','M','L','XL','2XL','3XL','4XL','5XL','FREE SIZE'];
function productVisual(product,extra=''){ return product.image?`<img src="${escapeAttribute(product.image)}" style="${mediaCropStyle(product.mediaCrops?.image)}" alt="${escapeAttribute(product.name)}">`:`<div class="merch-art ${extra}" style="--merch:${escapeAttribute(product.color||'#e8b21e')}"><span>PR</span><b>${product.category==='ของที่ระลึก'?'TOTE':'26'}</b><i>WE SHINE TOGETHER</i></div>`; }
async function renderShop(){
  const host=$('#shopContent'); if(!host)return;
  const products=(await hydrateStoreProducts(getStoreProducts())).filter(p=>p.published!==false);
  const lookbook=await getStoreLookbook();
  const linkedLookProduct=products.find(product=>product.id===(lookbook.finishProductId||lookbook.sourceProductId)),finishLookSource=linkedLookProduct?[linkedLookProduct]:products;
  const finishLookHighlights=finishLookSource.flatMap(product=>{const images=product.lookImages?.length?product.lookImages:product.lookImage?[product.lookImage]:[];return images.map((src,index)=>({src,title:product.lookTitle||product.name||'Finish Look',crop:product.mediaCrops?.[`look${index}`]}));}).slice(0,2);
  host.innerHTML=`<section class="store-hero"><div><small>PHUNRUEANG · OFFICIAL STORE</small><h1>ใส่พลังของเรา<br><em>ไปด้วยกัน</em></h1><p>คอลเลกชันสำหรับวันธรรมดาและวันแห่งชัยชนะ เลือกดูสินค้า ลองจับคู่ลุค และสั่งได้ทันที</p><div class="store-pills"><span>✓ รับสินค้าที่โรงเรียน</span><span>✦ รุ่นพิเศษจำนวนจำกัด</span></div></div><div class="store-hero-art"><div class="hero-shirt">PR<small>WE SHINE</small></div><i>NEW<br>DROP</i></div></section><div class="store-toolbar"><div><small>SHOP THE COLLECTION</small><h2>สินค้าที่วางขาย</h2></div><label><span>⌕</span><input id="storeSearch" placeholder="ค้นหาสินค้า..."></label></div><div class="store-grid" id="storeGrid">${products.length?products.map(productCard).join(''):'<div class="store-empty">ร้านค้ายังไม่มีสินค้าที่เปิดขาย</div>'}</div><section class="store-service"><div><b>01</b><span>เลือกสินค้า<small>ดูภาพ วิดีโอ และไอเดียแต่งตัว</small></span></div><i>→</i><div><b>02</b><span>เลือกไซซ์<small>ตรวจสอบตัวเลือกก่อนสั่ง</small></span></div><i>→</i><div><b>03</b><span>สั่งทันที<small>กรอกข้อมูลในขั้นตอนเดียว</small></span></div></section>`;
  host.insertAdjacentHTML('afterbegin',`<div class="store-announcement"><div><span>✦ OFFICIAL PHUNRUEANG STORE</span><span>NEW COLLECTION 2026</span><span>รับสินค้าที่โรงเรียน</span><span>WE SHINE TOGETHER</span><span>✦ OFFICIAL PHUNRUEANG STORE</span><span>NEW COLLECTION 2026</span><span>รับสินค้าที่โรงเรียน</span><span>WE SHINE TOGETHER</span></div></div>`);
  host.querySelector('.store-hero').insertAdjacentHTML('beforeend',`<div class="store-hero-world" aria-hidden="true"><i></i><i></i><i></i><span>✦</span><span>✦</span><b>PR · 26</b></div>`);
  host.querySelector('.store-pills').insertAdjacentHTML('afterend',`<div class="store-hero-actions"><button type="button" id="shopCollectionNow">เลือกซื้อคอลเลกชัน <b>→</b></button><button type="button" id="openStyleEdit">สำรวจ Finish Look <b>↗</b></button></div><div class="store-hero-proof"><span><b>${String(products.length).padStart(2,'0')}</b> DESIGNS</span><i></i><span><b>2026</b> COLLECTION</span><i></i><span><b>PR</b> EXCLUSIVE</span></div>`);
  host.querySelector('.store-toolbar').insertAdjacentHTML('afterend',`<nav class="store-categories" aria-label="หมวดสินค้า"><button class="active" data-store-category="all">ทั้งหมด</button>${[...new Set(products.map(product=>product.category).filter(Boolean))].map(category=>`<button data-store-category="${escapeAttribute(category)}">${escapeHTML(category)}</button>`).join('')}<span>${products.length} ITEMS</span></nav>`);
  host.querySelector('.store-categories').insertAdjacentHTML('afterend',`<section class="store-signature"><div class="signature-seal"><i>✦</i><b>PR</b><span>EST. 2026</span></div><div><small>THE SIGNATURE COLLECTION</small><h2>Crafted for<br><em>our brightest moments.</em></h2></div><p>ทุกรายละเอียดถูกเลือกเพื่อสะท้อนตัวตน ความภาคภูมิใจ และช่วงเวลาที่เราจะเปล่งประกายไปด้วยกัน</p><span class="signature-index">COLLECTION<br><b>№ 01</b></span></section>`);
  const lookbookCard=(item,index,fallback)=>`<div class="lookbook-card card-${index?'b':'a'} ${item?'has-finish-image':''}">${item?`<img src="${escapeAttribute(item.src)}" style="${mediaCropStyle(item.crop)}" alt="${escapeAttribute(item.title)}">`:''}<span>0${index+1}</span><b>${item?escapeHTML(item.title):fallback}</b></div>`;host.querySelector('.store-service').insertAdjacentHTML('beforebegin',`<section class="store-lookbook"><div class="lookbook-type"><small>PHUNRUEANG · STYLE EDIT</small><h2>YOUR TEAM.<br><em>YOUR LOOK.</em></h2><p>แต่งลุคให้เป็นตัวเอง แล้วพกพลังของพันเรืองไปทุกที่</p><button type="button" id="exploreLooks">ดู Finish Look <b>↗</b></button></div><div class="lookbook-stage"><div aria-hidden="true">${lookbookCard(finishLookHighlights[0],0,'เพิ่มภาพ<br>FINISH LOOK')}</div><div class="lookbook-model" aria-hidden="true">PR<small>WE SHINE</small></div><div aria-hidden="true">${lookbookCard(finishLookHighlights[1],1,'เพิ่มภาพ<br>FINISH LOOK')}</div><i aria-hidden="true">LIMITED<br>EDITION</i></div></section>`);
  if(lookbook.image){const model=host.querySelector('.lookbook-model');model.classList.add('has-custom-model');model.innerHTML=`<img src="${escapeAttribute(lookbook.image)}" alt="โมเดลเสื้อคอลเลกชัน">`;}
  host.querySelector('.store-service').insertAdjacentHTML('afterend',`<section class="store-concierge"><header><small>THE PHUNRUEANG EXPERIENCE</small><h2>บริการที่ใส่ใจ<br><em>ในทุกรายละเอียด</em></h2></header><div class="concierge-grid"><article><span>01</span><i>◇</i><h3>Signature Packaging</h3><p>จัดเตรียมสินค้าอย่างประณีต พร้อมบรรจุภัณฑ์ในธีมพันเรือง</p></article><article><span>02</span><i>⌁</i><h3>Personal Styling</h3><p>Finish Look ช่วยเลือกวิธีสวมใส่ที่เข้ากับสไตล์ของคุณ</p></article><article><span>03</span><i>♙</i><h3>Room Concierge</h3><p>รวบรวมไซซ์และคำสั่งซื้อทั้งห้อง พร้อมผู้ประสานงานคนเดียว</p></article><article><span>04</span><i>✓</i><h3>School Pickup</h3><p>ตรวจสอบรายการและรับสินค้าที่โรงเรียนอย่างเป็นระบบ</p></article></div><footer><span>PHUNRUEANG OFFICIAL</span><b>WE SHINE TOGETHER</b><span>COLLECTION 2026</span></footer></section>`);
  host.querySelectorAll('[data-view-product]').forEach(btn=>btn.addEventListener('click',()=>openProduct(btn.dataset.viewProduct)));
  $('#shopCollectionNow').addEventListener('click',()=>host.querySelector('.store-toolbar').scrollIntoView({behavior:'smooth',block:'start'}));$('#openStyleEdit').addEventListener('click',()=>host.querySelector('.store-lookbook').scrollIntoView({behavior:'smooth',block:'center'}));
  $('#storeSearch').addEventListener('input',e=>{const q=e.target.value.trim().toLowerCase();host.querySelectorAll('.store-product').forEach(card=>card.hidden=!card.dataset.search.includes(q));});
  host.querySelectorAll('[data-store-category]').forEach(button=>button.addEventListener('click',()=>{host.querySelectorAll('[data-store-category]').forEach(item=>item.classList.toggle('active',item===button));const category=button.dataset.storeCategory;host.querySelectorAll('.store-product').forEach(card=>card.hidden=category!=='all'&&!card.dataset.search.includes(category.toLowerCase()));}));
  $('#exploreLooks').addEventListener('click',()=>host.querySelector('[data-view-product]')?.click());
  const revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('store-revealed');revealObserver.unobserve(entry.target);}}),{threshold:.12});host.querySelectorAll('.store-signature,.store-product,.store-lookbook,.store-service,.store-concierge').forEach((element,index)=>{element.style.setProperty('--reveal-delay',`${index*.07}s`);revealObserver.observe(element);});
  const hero=host.querySelector('.store-hero');hero.addEventListener('pointermove',event=>{const bounds=hero.getBoundingClientRect();hero.style.setProperty('--shop-x',`${(event.clientX-bounds.left)/bounds.width-.5}`);hero.style.setProperty('--shop-y',`${(event.clientY-bounds.top)/bounds.height-.5}`);},{passive:true});
}
function productCard(product){return `<article class="store-product" data-search="${escapeAttribute((product.name+' '+product.category).toLowerCase())}"><button class="store-product-media" data-view-product="${escapeAttribute(product.id)}" aria-label="ดูรายละเอียด ${escapeAttribute(product.name)}">${productVisual(product)}<span class="media-hint">◉ ดูภาพ / วิดีโอ</span>${product.badge?`<strong>${escapeHTML(product.badge)}</strong>`:''}</button><div class="store-product-info"><small>${escapeHTML(product.category||'MERCHANDISE')}</small><h3>${escapeHTML(product.name)}</h3><p>${escapeHTML(product.description||'')}</p><div><span class="store-price">฿${Number(product.price).toLocaleString('th-TH')}</span>${product.comparePrice?`<del>฿${Number(product.comparePrice).toLocaleString('th-TH')}</del>`:''}<button data-view-product="${escapeAttribute(product.id)}">เลือกซื้อ <b>→</b></button></div></div></article>`;}
function finishLookVisual(product){const slides=product.lookImages?.length?product.lookImages:product.lookImage?[product.lookImage]:[];return slides.length?`<div class="finish-look-slider" data-slide="0"><div>${slides.map((image,index)=>`<img src="${escapeAttribute(image)}" style="${mediaCropStyle(product.mediaCrops?.[`look${index}`])}" alt="Finish Look ${index+1}" ${index?'hidden':''}>`).join('')}</div>${slides.length>1?`<button type="button" data-slide-prev aria-label="ภาพก่อนหน้า">‹</button><button type="button" data-slide-next aria-label="ภาพถัดไป">›</button><span>${slides.map((_,index)=>`<i class="${index?'':'active'}"></i>`).join('')}</span>`:''}</div>`:`<div class="finish-look-demo" style="--merch:${escapeAttribute(product.color||'#e8b21e')}"><span>FINISH</span><div>PR</div><b>${escapeHTML(product.lookTitle||'YOUR LOOK')}</b><small>${escapeHTML(product.lookText||'')}</small></div>`;}
function bindFinishLookSlider(host){const slider=host.querySelector('.finish-look-slider');if(!slider)return;const images=[...slider.querySelectorAll('img')],dots=[...slider.querySelectorAll('span i')],show=index=>{const current=(index+images.length)%images.length;slider.dataset.slide=current;images.forEach((image,i)=>image.hidden=i!==current);dots.forEach((dot,i)=>dot.classList.toggle('active',i===current));};slider.querySelector('[data-slide-prev]')?.addEventListener('click',()=>show(Number(slider.dataset.slide)-1));slider.querySelector('[data-slide-next]')?.addEventListener('click',()=>show(Number(slider.dataset.slide)+1));}
function showAnimatedReceipt(dialog,order,close){const orderCode=String(order.id||`order-${Date.now()}`).replace('order-','PR').slice(-12),money=value=>`฿${Number(value||0).toLocaleString('th-TH')}`;dialog.classList.add('receipt-dialog');dialog.innerHTML=`<div class="receipt-machine"><div class="machine-light"><i></i> PAYMENT RECORDED</div><div class="receipt-slot"><span></span></div><article class="store-receipt"><header><div class="receipt-logo">PR</div><small>PHUNRUEANG OFFICIAL STORE</small><h2>ใบยืนยันคำสั่งซื้อ</h2><p>ORDER · ${escapeHTML(orderCode)}</p></header><div class="receipt-dash"></div><section class="receipt-customer"><span>ประเภท</span><b>${escapeHTML(order.orderType||'สั่งส่วนตัว')}</b><span>ผู้สั่ง / ผู้ประสานงาน</span><b>${escapeHTML(order.name||'-')}</b><span>ห้อง</span><b>ม.${escapeHTML(order.room||'-')}</b></section><div class="receipt-dash"></div><section class="receipt-product"><div><b>${escapeHTML(order.product||'-')}</b><small>${escapeHTML(order.size||'-')}</small></div><span>${order.quantity} ชิ้น</span></section><section class="receipt-money"><div><span>ราคาต่อชิ้น</span><b>${money(order.price)}</b></div><div class="grand-total"><span>ยอดรวมสุทธิ</span><b>${money(order.total)}</b></div></section><div class="receipt-barcode"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><footer><b>ขอบคุณที่เป็นพลังของพันเรือง</b><span>WE SHINE TOGETHER · 2026</span></footer></article><div class="receipt-actions"><button type="button" id="backToStoreFromReceipt">กลับไปหน้าสั่งซื้อสินค้า <b>→</b></button><small>ทีมงานจะตรวจสอบและแจ้งรายละเอียดการรับสินค้า</small></div></div>`;requestAnimationFrame(()=>dialog.classList.add('receipt-printing'));dialog.querySelector('#backToStoreFromReceipt').addEventListener('click',()=>{close();setTimeout(()=>{$('#shopContent')?.scrollIntoView({behavior:'smooth',block:'start'});},220);});}
function mediaCropStyle(crop={}){const x=Math.min(100,Math.max(0,Number(crop.x??50))),y=Math.min(100,Math.max(0,Number(crop.y??50))),zoom=Math.min(3,Math.max(1,Number(crop.zoom??1)));return `object-position:${x}% ${y}%;transform:scale(${zoom})`;}
function openStoreCropStudio(product,onSave){const slides=product.lookImages?.length?product.lookImages:product.lookImage?[product.lookImage]:[],media=[...(product.image?[{key:'image',label:'รูปสินค้า',type:'image',src:product.image}]:[]),...(product.video?[{key:'video',label:'วิดีโอ',type:'video',src:product.video}]:[]),...slides.map((src,index)=>({key:`look${index}`,label:`Finish Look ${index+1}`,type:'image',src}))];if(!media.length){siteAlert('กรุณาอัปโหลดรูปภาพ วิดีโอ หรือภาพสไลด์ก่อนเปิด Crop Studio',{theme:'store'});return;}const crops=structuredClone(product.mediaCrops||{}),dialog=document.createElement('dialog');dialog.className='crop-studio-dialog';dialog.innerHTML=`<header><div><small>STORE · CROP STUDIO</small><h3>จัดวางสื่อสินค้า</h3><p>เลื่อนตำแหน่งและซูมให้พอดีกับกรอบหน้าร้าน</p></div><button type="button" data-crop-close>×</button></header><div class="crop-studio-body"><aside>${media.map((item,index)=>`<button type="button" data-crop-media="${index}" class="${index?'':'active'}"><span>${item.type==='video'?'▶':'▧'}</span><b>${escapeHTML(item.label)}</b></button>`).join('')}</aside><main><div class="crop-canvas" id="cropCanvas"></div><div class="crop-safe-area"><span>พื้นที่แสดงผลหน้าร้าน</span></div></main><section class="crop-controls"><label><span>เลื่อนแนวนอน</span><b id="cropXValue">50%</b><input id="cropX" type="range" min="0" max="100" value="50"></label><label><span>เลื่อนแนวตั้ง</span><b id="cropYValue">50%</b><input id="cropY" type="range" min="0" max="100" value="50"></label><label><span>ซูมภาพ</span><b id="cropZoomValue">1.00×</b><input id="cropZoom" type="range" min="1" max="3" step=".05" value="1"></label><button type="button" class="crop-reset" id="cropReset">↻ คืนค่ากลาง</button></section></div><footer><span>ค่าครอปไม่ทำลายไฟล์ต้นฉบับ สามารถกลับมาแก้ได้เสมอ</span><div><button type="button" data-crop-close>ยกเลิก</button><button type="button" id="saveCropStudio">บันทึกการจัดวาง →</button></div></footer>`;document.body.appendChild(dialog);dialog.showModal();requestAnimationFrame(()=>dialog.classList.add('open'));let active=0;const inputs={x:dialog.querySelector('#cropX'),y:dialog.querySelector('#cropY'),zoom:dialog.querySelector('#cropZoom')},render=()=>{const item=media[active],crop=crops[item.key]||{x:50,y:50,zoom:1},canvas=dialog.querySelector('#cropCanvas');inputs.x.value=crop.x??50;inputs.y.value=crop.y??50;inputs.zoom.value=crop.zoom??1;canvas.innerHTML=item.type==='video'?`<video src="${escapeAttribute(item.src)}" autoplay loop muted playsinline></video>`:`<img src="${escapeAttribute(item.src)}" alt="${escapeAttribute(item.label)}">`;canvas.firstElementChild.style.cssText=mediaCropStyle(crop);dialog.querySelector('#cropXValue').textContent=`${inputs.x.value}%`;dialog.querySelector('#cropYValue').textContent=`${inputs.y.value}%`;dialog.querySelector('#cropZoomValue').textContent=`${Number(inputs.zoom.value).toFixed(2)}×`;},update=()=>{const item=media[active];crops[item.key]={x:Number(inputs.x.value),y:Number(inputs.y.value),zoom:Number(inputs.zoom.value)};render();},close=()=>{dialog.classList.remove('open');setTimeout(()=>{dialog.close();dialog.remove();},180)};dialog.querySelectorAll('[data-crop-media]').forEach(button=>button.addEventListener('click',()=>{active=Number(button.dataset.cropMedia);dialog.querySelectorAll('[data-crop-media]').forEach(item=>item.classList.toggle('active',item===button));render();}));Object.values(inputs).forEach(input=>input.addEventListener('input',update));dialog.querySelector('#cropReset').addEventListener('click',()=>{crops[media[active].key]={x:50,y:50,zoom:1};render();});dialog.querySelectorAll('[data-crop-close]').forEach(button=>button.addEventListener('click',close));dialog.querySelector('#saveCropStudio').addEventListener('click',()=>{product.mediaCrops=crops;onSave?.();close();});render();}
function openProduct(id){
  const product=storeProductsRuntime.find(p=>p.id===id)||getStoreProducts().find(p=>p.id===id); if(!product)return;
  const dialog=document.createElement('dialog'); dialog.className='product-dialog';
  dialog.innerHTML=`<button class="product-close" aria-label="ปิด">×</button><div class="product-gallery"><div class="product-main-media" id="productMainMedia">${productVisual(product,'large')}</div><div class="media-tabs"><button class="active" data-media="image">▧ ภาพสินค้า</button><button data-media="video" ${product.video?'':'disabled'}>▶ วิดีโอนายแบบ/นางแบบ</button><button data-media="look">✦ Finish Look</button></div></div><div class="product-detail"><small>${escapeHTML(product.category)} · ${Math.max(0,Number(product.stock)||0)} ชิ้นพร้อมสั่ง</small><h2>${escapeHTML(product.name)}</h2><div class="detail-price">฿${Number(product.price).toLocaleString('th-TH')} ${product.comparePrice?`<del>฿${Number(product.comparePrice).toLocaleString('th-TH')}</del>`:''}</div><p>${escapeHTML(product.description||'')}</p><section class="look-note"><i>✦</i><div><small>STYLIST'S NOTE</small><b>${escapeHTML(product.lookTitle||'Finish Look')}</b><span>${escapeHTML(product.lookText||'เลือกสวมใส่ในแบบที่เป็นคุณ')}</span></div></section><form id="quickOrderForm"><label>เลือกไซซ์<div class="size-options">${(product.sizes||['FREE SIZE']).map((s,i)=>`<input type="radio" name="quickSize" id="quickSize${i}" value="${escapeAttribute(s)}" ${i===0?'checked':''}><label for="quickSize${i}">${escapeHTML(s)}</label>`).join('')}</div></label><div class="quantity-line"><label>จำนวน<input id="quickQuantity" type="number" min="1" max="${Math.max(1,Number(product.stock)||99)}" value="1"></label><button class="buy-now">สั่งซื้อทันที <b>→</b></button></div></form><div class="product-trust"><span>✓ ไม่ต้องสร้างบัญชี</span><span>⌂ รับสินค้าที่โรงเรียน</span></div></div>`;
  document.body.appendChild(dialog); dialog.showModal(); requestAnimationFrame(()=>dialog.classList.add('open'));
  const close=()=>{dialog.classList.remove('open');setTimeout(()=>{dialog.close();dialog.remove();},180)}; dialog.querySelector('.product-close').addEventListener('click',close); dialog.addEventListener('click',e=>{if(e.target===dialog)close()});
  dialog.querySelectorAll('[data-media]').forEach(btn=>btn.addEventListener('click',()=>{dialog.querySelectorAll('[data-media]').forEach(b=>b.classList.toggle('active',b===btn));const host=dialog.querySelector('#productMainMedia');if(btn.dataset.media==='video')host.innerHTML=`<video controls autoplay muted playsinline src="${escapeAttribute(product.video)}" style="${mediaCropStyle(product.mediaCrops?.video)}"></video>`;else if(btn.dataset.media==='look'){host.innerHTML=finishLookVisual(product);bindFinishLookSlider(host);}else host.innerHTML=productVisual(product,'large');}));
  dialog.querySelector('#quickOrderForm').addEventListener('submit',e=>{e.preventDefault();const size=new FormData(e.target).get('quickSize');const quantity=dialog.querySelector('#quickQuantity').value;close();setTimeout(()=>openCheckout(product,size,quantity),190);});
}
function openCheckout(product,size,quantity){
  const sizes=product.sizes?.length?product.sizes:['FREE SIZE'];
  const roomOptions=Object.keys(ORDER_ROOM_DATABASE);
  const dialog=document.createElement('dialog');dialog.className='checkout-dialog';dialog.innerHTML=`<button class="product-close" aria-label="ปิด">×</button><header><small>QUICK CHECKOUT · ขั้นตอนเดียว</small><h2>เลือกรูปแบบการสั่ง</h2><p>สั่งให้ตัวเอง หรือเลือกรายชื่อและไซซ์ให้ทั้งห้องได้ในครั้งเดียว</p></header><div class="checkout-mode" role="tablist"><button type="button" class="active" data-checkout-mode="person"><i>♙</i><span>สั่งส่วนตัว<small>สำหรับผู้สั่ง 1 คน</small></span></button><button type="button" data-checkout-mode="room"><i>♟</i><span>สั่งเป็นห้อง<small>เลือกรายชื่อและไซซ์รายคน</small></span></button></div><div class="checkout-item">${productVisual(product)}<div><small>รายการสั่งซื้อ</small><b>${escapeHTML(product.name)}</b><span id="checkoutItemMeta">ไซซ์ ${escapeHTML(size)} · ${quantity} ชิ้น</span></div><strong id="checkoutTotal">฿${(Number(product.price)*Number(quantity)).toLocaleString('th-TH')}</strong></div><form id="checkoutForm"><section id="personCheckoutFields"><div class="field"><label>ชื่อ–นามสกุล</label><input name="name" required placeholder="ชื่อผู้สั่งซื้อ"></div><div class="two"><div class="field"><label>ชั้น / ห้อง</label><input name="room" required placeholder="เช่น 6/5"></div><div class="field"><label>เลขที่</label><input name="number" required inputmode="numeric" placeholder="เช่น 01"></div></div></section><section id="roomCheckoutFields" hidden><div class="two coordinator-fields"><div class="field"><label>เลขประจำตัวผู้ประสานงานประจำห้อง</label><input name="coordinatorId" id="coordinatorStudentId" inputmode="numeric" maxlength="5" autocomplete="off" placeholder="กรอกเลขประจำตัว 5 หลัก"><div class="coordinator-validation" id="coordinatorValidation">กรอกเลขประจำตัวที่อยู่ในห้องนี้</div></div><div class="field"><label>เลือกห้อง</label><select name="groupRoom" id="checkoutRoomSelect">${roomOptions.map(room=>`<option value="${escapeAttribute(room)}">ม.${escapeHTML(room)} · ${ORDER_ROOM_DATABASE[room].length} คน</option>`).join('')}</select></div></div><div class="room-student-order"><header><div><b>รายชื่อนักเรียน</b><small>เลือก “เอา” แล้วระบุไซซ์ให้แต่ละคน</small></div><span>เลือกแล้ว <b id="roomQuantityTotal">0</b> คน</span></header><div class="room-student-head"><span>เลขที่ / ชื่อ–นามสกุล</span><span>รับสินค้า</span><span>ไซซ์</span></div><div id="roomStudentOrderList"></div><footer id="roomSizeSummary">ยังไม่มีผู้สั่งสินค้า</footer></div><div class="field"><label>หมายเหตุของห้อง (ถ้ามี)</label><textarea name="note" placeholder="เช่น ขอรับสินค้าพร้อมกันทั้งห้อง"></textarea></div></section><div class="field"><label>ช่องทางติดต่อ</label><input name="contact" required placeholder="LINE ID หรือเบอร์โทร"></div><div class="checkout-error" id="checkoutError"></div><button class="buy-now checkout-submit">ยืนยันสั่งซื้อ · <span id="checkoutButtonTotal">฿${(Number(product.price)*Number(quantity)).toLocaleString('th-TH')}</span> <b>→</b></button><small class="checkout-consent">ทีมงานจะตรวจสอบรายการและแจ้งรายละเอียดการรับสินค้า</small></form>`;
  document.body.appendChild(dialog);dialog.querySelector('#personCheckoutFields').innerHTML=`<div class="field"><label>เลขประจำตัวนักเรียน</label><input name="personalStudentId" id="personalStudentId" required inputmode="numeric" maxlength="5" autocomplete="off" placeholder="กรอกเลขประจำตัว 5 หลัก"><div class="coordinator-validation" id="personalStudentValidation">ระบบจะค้นหาชื่อ ห้อง และเลขที่ให้อัตโนมัติ</div></div><div class="personal-student-card" id="personalStudentCard" hidden><i>✓</i><div><small>ยืนยันข้อมูลผู้สั่งซื้อแล้ว</small><b id="personalStudentName"></b><span id="personalStudentMeta"></span></div></div>`;dialog.showModal();requestAnimationFrame(()=>dialog.classList.add('open'));let checkoutMode='person';const close=()=>{dialog.classList.remove('open');setTimeout(()=>{dialog.close();dialog.remove()},180)};
  const receiptObserver=new MutationObserver(()=>{if(!dialog.querySelector('.order-complete'))return;receiptObserver.disconnect();const orders=JSON.parse(localStorage.getItem('phanuang-orders')||'[]'),latest=orders[orders.length-1];if(latest)showAnimatedReceipt(dialog,latest,close);});receiptObserver.observe(dialog,{childList:true});
  const renderRoomStudents=()=>{const room=dialog.querySelector('#checkoutRoomSelect').value,students=ORDER_ROOM_DATABASE[room]||[],list=dialog.querySelector('#roomStudentOrderList');list.innerHTML=students.map((student,index)=>`<div class="room-student-row" data-student-id="${escapeAttribute(student.studentId)}" data-name="${escapeAttribute(student.name)}" data-number="${escapeAttribute(student.number)}"><span><b>${escapeHTML(student.number)}</b><span>${escapeHTML(student.name)}</span></span><select class="student-order-choice" aria-label="เลือกว่าจะรับสินค้าหรือไม่ของ ${escapeAttribute(student.name)}"><option value="no">ไม่เอา</option><option value="yes">เอา</option></select><select class="student-order-size" aria-label="เลือกไซซ์ของ ${escapeAttribute(student.name)}" disabled>${sizes.map(item=>`<option value="${escapeAttribute(item)}" ${item===size?'selected':''}>${escapeHTML(item)}</option>`).join('')}</select></div>`).join('');list.querySelectorAll('.student-order-choice').forEach(select=>select.addEventListener('change',()=>{const row=select.closest('.room-student-row'),sizeSelect=row.querySelector('.student-order-size'),ordering=select.value==='yes';row.classList.toggle('is-ordering',ordering);sizeSelect.disabled=!ordering;updateRoomTotal();}));list.querySelectorAll('.student-order-size').forEach(select=>select.addEventListener('change',updateRoomTotal));updateRoomTotal();};
  const getRoomSelections=()=>[...dialog.querySelectorAll('.room-student-row')].map(row=>({studentId:row.dataset.studentId,number:row.dataset.number,name:row.dataset.name,ordering:row.querySelector('.student-order-choice').value==='yes',size:row.querySelector('.student-order-choice').value==='yes'?row.querySelector('.student-order-size').value:'ไม่เอา'}));
  const validateCoordinator=()=>{const room=dialog.querySelector('#checkoutRoomSelect').value,id=dialog.querySelector('#coordinatorStudentId').value.trim(),student=(ORDER_ROOM_DATABASE[room]||[]).find(item=>item.studentId===id),status=dialog.querySelector('#coordinatorValidation'),input=dialog.querySelector('#coordinatorStudentId');input.classList.toggle('is-valid',Boolean(student));input.classList.toggle('is-invalid',Boolean(id)&&!student);status.className=`coordinator-validation ${student?'valid':id?'invalid':''}`;status.textContent=student?`✓ ยืนยันตัวตนแล้ว: เลขที่ ${student.number} · ${student.name}`:id?`ไม่พบเลขประจำตัว ${id} ในห้อง ม.${room}`:'กรอกเลขประจำตัวที่อยู่ในห้องนี้';return student||null;};
  const validatePersonalStudent=()=>{const id=dialog.querySelector('#personalStudentId').value.trim(),match=Object.entries(ORDER_ROOM_DATABASE).flatMap(([room,students])=>students.map(student=>({...student,room}))).find(student=>student.studentId===id),status=dialog.querySelector('#personalStudentValidation'),input=dialog.querySelector('#personalStudentId'),card=dialog.querySelector('#personalStudentCard');input.classList.toggle('is-valid',Boolean(match));input.classList.toggle('is-invalid',Boolean(id)&&!match);status.className=`coordinator-validation ${match?'valid':id?'invalid':''}`;status.textContent=match?'✓ พบข้อมูลนักเรียนในฐานข้อมูล':id?`ไม่พบเลขประจำตัว ${id} ในฐานข้อมูล`:'ระบบจะค้นหาชื่อ ห้อง และเลขที่ให้อัตโนมัติ';card.hidden=!match;if(match){dialog.querySelector('#personalStudentName').textContent=match.name;dialog.querySelector('#personalStudentMeta').textContent=`ม.${match.room} · เลขที่ ${match.number} · ${match.studentId}`;}return match||null;};
  const updateRoomTotal=()=>{const selected=getRoomSelections().filter(item=>item.ordering),total=selected.length,price=total*Number(product.price),counts=selected.reduce((result,item)=>(result[item.size]=(result[item.size]||0)+1,result),{});dialog.querySelector('#roomQuantityTotal').textContent=total;dialog.querySelector('#roomSizeSummary').textContent=total?Object.entries(counts).map(([label,count])=>`${label} × ${count}`).join(' · '):'ยังไม่มีผู้สั่งสินค้า';dialog.querySelector('#checkoutItemMeta').textContent=checkoutMode==='room'?`สั่งเป็นห้อง · ${total} คน`:`ไซซ์ ${size} · ${quantity} ชิ้น`;dialog.querySelector('#checkoutTotal').textContent=`฿${(checkoutMode==='room'?price:Number(product.price)*Number(quantity)).toLocaleString('th-TH')}`;dialog.querySelector('#checkoutButtonTotal').textContent=dialog.querySelector('#checkoutTotal').textContent;};
  dialog.querySelector('.product-close').addEventListener('click',close);dialog.querySelector('#personalStudentId').addEventListener('input',validatePersonalStudent);dialog.querySelector('#coordinatorStudentId').addEventListener('input',validateCoordinator);dialog.querySelector('#checkoutRoomSelect').addEventListener('change',()=>{renderRoomStudents();validateCoordinator();});dialog.querySelectorAll('[data-checkout-mode]').forEach(button=>button.addEventListener('click',()=>{checkoutMode=button.dataset.checkoutMode;dialog.querySelectorAll('[data-checkout-mode]').forEach(item=>item.classList.toggle('active',item===button));const person=dialog.querySelector('#personCheckoutFields'),room=dialog.querySelector('#roomCheckoutFields');person.hidden=checkoutMode!=='person';room.hidden=checkoutMode!=='room';person.querySelectorAll('input').forEach(input=>input.required=checkoutMode==='person');room.querySelector('#coordinatorStudentId').required=checkoutMode==='room';dialog.querySelector('#checkoutError').textContent='';updateRoomTotal();}));renderRoomStudents();
  dialog.querySelector('#checkoutForm').addEventListener('submit',event=>{if(checkoutMode!=='person')return;const student=validatePersonalStudent();if(!student){event.preventDefault();event.stopImmediatePropagation();dialog.querySelector('#checkoutError').textContent='เลขประจำตัวนักเรียนไม่ตรงกับข้อมูลในฐานข้อมูล';dialog.querySelector('#personalStudentId').focus();return;}['name','room','number'].forEach(name=>event.currentTarget.querySelector(`input[data-personal-field="${name}"]`)?.remove());[['name',student.name],['room',student.room],['number',student.number]].forEach(([name,value])=>{const input=document.createElement('input');input.type='hidden';input.name=name;input.value=value;input.dataset.personalField=name;event.currentTarget.appendChild(input);});},true);
  dialog.querySelector('#checkoutForm').addEventListener('submit',e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.target)),orders=JSON.parse(localStorage.getItem('phanuang-orders')||'[]');let savedQuantity=Number(quantity),savedSize=size,sizeBreakdown='',studentOrders=[],coordinator=null;if(checkoutMode==='room'){coordinator=validateCoordinator();if(!coordinator){dialog.querySelector('#checkoutError').textContent='เลขประจำตัวผู้ประสานงานไม่ตรงกับรายชื่อของห้องที่เลือก';dialog.querySelector('#coordinatorStudentId').focus();return;}studentOrders=getRoomSelections();const selected=studentOrders.filter(item=>item.ordering);savedQuantity=selected.length;if(!savedQuantity){dialog.querySelector('#checkoutError').textContent='กรุณาเลือก “เอา” อย่างน้อย 1 คน';return;}const counts=selected.reduce((result,item)=>(result[item.size]=(result[item.size]||0)+1,result),{});savedSize=Object.entries(counts).map(([label,count])=>`${label} × ${count}`).join(', ');sizeBreakdown=savedSize;}orders.push({id:`order-${Date.now()}`,time:Date.now(),status:'ใหม่',orderType:checkoutMode==='room'?'สั่งซื้อเป็นห้อง':'สั่งส่วนตัว',name:checkoutMode==='room'?coordinator.name:data.name,coordinatorId:checkoutMode==='room'?coordinator.studentId:'',room:checkoutMode==='room'?data.groupRoom:data.room,number:checkoutMode==='room'?coordinator.number:data.number,contact:data.contact,note:data.note||'',product:product.name,productId:product.id,size:savedSize,sizeBreakdown,studentOrders,quantity:String(savedQuantity),price:Number(product.price),total:Number(product.price)*savedQuantity});localStorage.setItem('phanuang-orders',JSON.stringify(orders));dialog.innerHTML=`<div class="order-complete"><i>✓</i><small>ORDER RECEIVED</small><h2>${checkoutMode==='room'?'ส่งยอดสั่งของห้องแล้ว':'สั่งซื้อเรียบร้อยแล้ว'}</h2><p>เราได้รับรายการ <b>${escapeHTML(product.name)}</b> จำนวน ${savedQuantity} ชิ้น<br>ทีมงานจะตรวจสอบและติดต่อกลับ</p><button class="buy-now">กลับไปเลือกสินค้า</button></div>`;dialog.querySelector('button').addEventListener('click',close);});}
function downloadOrders(type='personal') {
  const products=getStoreProducts(),all=JSON.parse(localStorage.getItem('phanuang-orders')||'[]').sort((a,b)=>String(a.room).localeCompare(String(b.room),'th')||Number(a.number)-Number(b.number));
  const quote=value=>`"${String(value??'').replaceAll('"','""')}"`,priceOf=order=>Number(order.price??products.find(item=>item.id===order.productId||item.name===order.product)?.price??0),excelRoom=value=>`="${String(value||'').replaceAll('"','""')}"`;
  let header=[],rows=[],filename='';
  if(type==='room'){
    const orders=all.filter(order=>String(order.orderType||'').includes('ห้อง'));
    header=['ห้อง','ชื่อผู้ประสานงาน','เลขประจำตัวผู้ประสานงาน','เลขที่ผู้ประสานงาน','ชื่อผู้สั่ง','เลขประจำตัวผู้สั่ง','เลขที่ผู้สั่ง','สินค้า','ไซซ์','ราคาต่อชิ้น','สถานะ'];
    const groups=orders.reduce((result,order)=>{const room=String(order.room||'ไม่ระบุห้อง');(result[room]??=[]).push(order);return result;},{});
    Object.keys(groups).sort((a,b)=>a.localeCompare(b,'th',{numeric:true})).forEach((room,groupIndex)=>{if(groupIndex)rows.push([]);rows.push([`ห้อง ม.${room} · ${groups[room].length} คำสั่งซื้อ`]);rows.push(header);groups[room].forEach(order=>{const students=(order.studentOrders||[]).filter(student=>student.ordering);if(students.length)students.forEach(student=>rows.push([excelRoom(room),order.name,order.coordinatorId||'',order.number||'',student.name,student.studentId,student.number,order.product,student.size,priceOf(order),'เอา']));else rows.push([excelRoom(room),order.name,order.coordinatorId||'',order.number||'','ไม่มีรายละเอียดรายคน','','',order.product,order.size||'',priceOf(order),'รายการเก่า']);});rows.push([`สรุปห้อง ม.${room}`,`${groups[room].length} คำสั่งซื้อ`,`${groups[room].reduce((sum,order)=>sum+(Number(order.quantity)||0),0)} ชิ้น`]);});
    filename='คำสั่งซื้อรายห้อง-พันเรือง.csv';
  }else{
    const orders=all.filter(order=>!String(order.orderType||'').includes('ห้อง'));
    header=['ชื่อ–นามสกุล','เลขประจำตัวนักเรียน','ชั้น/ห้อง','เลขที่','สินค้า','ไซซ์','จำนวน','ราคาต่อชิ้น','ยอดรวม','ช่องทางติดต่อ'];
    rows=orders.map(order=>[order.name,order.personalStudentId||'',excelRoom(order.room),order.number,order.product,order.size||'',order.quantity,priceOf(order),Number(order.total??priceOf(order)*(Number(order.quantity)||0)),order.contact||'']);
    filename='คำสั่งซื้อส่วนตัว-พันเรือง.csv';
  }
  const output=type==='room'?rows:[header,...rows],csv=output.map(row=>row.map(quote).join(',')).join('\n'),link=document.createElement('a');link.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));link.download=filename;link.click();URL.revokeObjectURL(link.href);
}
async function renderStoreAdmin(host){
  host.innerHTML='<div class="admin-gallery-empty">กำลังโหลดคลังรูปภาพและวิดีโอ…</div>';
  let products=(await hydrateStoreProducts(getStoreProducts())).map(p=>({...p,sizes:[...(p.sizes||[])]}));
  let lookbookConfig=await getStoreLookbook();
  host.innerHTML=`<div class="admin-panel store-admin"><div class="panel-heading"><div><small>STORE MANAGER · COMMERCE</small><h3>ควบคุมหน้าร้าน</h3><p>เพิ่มสินค้า ราคา สต็อก สื่อของนายแบบ/นางแบบ และ Finish Look ได้จากที่นี่</p></div><button class="primary" id="addStoreProduct">＋ เพิ่มสินค้า</button></div><div class="store-admin-summary"><span><b>${products.length}</b> สินค้าทั้งหมด</span><span><b>${products.filter(p=>p.published!==false).length}</b> กำลังวางขาย</span><span><b>${products.reduce((n,p)=>n+(Number(p.stock)||0),0)}</b> สต็อกรวม</span></div><div id="storeAdminList"></div><div class="store-admin-save"><span id="storeSaveState">พร้อมแก้ไขข้อมูลร้านค้า</span><button class="primary" id="saveStoreProducts">บันทึกและเผยแพร่หน้าร้าน <b>→</b></button></div></div>`;
  const updateStoreSummary=()=>{const values=[products.length,products.filter(product=>product.published!==false).length,products.reduce((total,product)=>total+(Number(product.stock)||0),0)];host.querySelectorAll('.store-admin-summary b').forEach((element,index)=>{const next=String(values[index]??0);if(element.textContent!==next){element.textContent=next;element.classList.remove('summary-pop');void element.offsetWidth;element.classList.add('summary-pop');}});};
  const summary=host.querySelector('.store-admin-summary');summary.insertAdjacentHTML('afterend',`<section class="lookbook-model-admin"><div class="lookbook-admin-copy"><small>LOOKBOOK MODEL STUDIO</small><h4>โมเดลเสื้อหน้า Luxury Lookbook</h4><p>เลือกจากรูปสินค้าที่ออกแบบไว้ หรืออัปโหลดภาพใหม่ แล้วตัดพื้นหลังได้ทันที</p><div class="lookbook-source"><select id="lookbookProductSource"><option value="">เลือกโมเดลจากสินค้า</option>${products.filter(product=>product.image).map(product=>`<option value="${escapeAttribute(product.id)}" ${lookbookConfig.sourceProductId===product.id?'selected':''}>${escapeHTML(product.name)}</option>`).join('')}</select><button type="button" id="useProductModel">ใช้รูปสินค้านี้</button><button type="button" id="uploadLookbookModel">↑ อัปโหลดโมเดล</button><input id="lookbookModelFile" type="file" accept="image/*" hidden></div><div class="background-removal-controls"><label>ความละเอียดการตัดพื้นหลัง <input id="backgroundTolerance" type="range" min="10" max="110" value="${Number(lookbookConfig.tolerance)||42}"><b id="backgroundToleranceValue">${Number(lookbookConfig.tolerance)||42}</b></label><button type="button" id="removeModelBackground">✦ ตัดพื้นหลัง</button><button type="button" id="resetLookbookModel">ล้างโมเดล</button></div></div><div class="lookbook-model-preview" id="lookbookModelPreview">${lookbookConfig.image?`<img src="${escapeAttribute(lookbookConfig.image)}" alt="ตัวอย่างโมเดล">`:'<span>ยังไม่ได้เลือกโมเดล<small>รูป PNG พื้นหลังโปร่งใสจะแสดงผลดีที่สุด</small></span>'}</div><button type="button" class="save-lookbook-model" id="saveLookbookModel">บันทึกโมเดลไปหน้าร้าน →</button></section>`);
  let originalLookbookImage=lookbookConfig.image||'';const previewLookbook=()=>{$('#lookbookModelPreview').innerHTML=lookbookConfig.image?`<img src="${escapeAttribute(lookbookConfig.image)}" alt="ตัวอย่างโมเดล">`:'<span>ยังไม่ได้เลือกโมเดล<small>เลือกภาพจากสินค้า หรืออัปโหลดไฟล์ใหม่</small></span>';},readLookbookFile=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
  $('#removeModelBackground').textContent='✦ ตัดพื้นหลังอัจฉริยะ';
  $('.lookbook-admin-copy p').textContent='ขั้นตอนง่าย ๆ: เลือกสินค้า หรืออัปโหลดภาพ → ตัดพื้นหลัง → ตรวจสอบตัวอย่าง → บันทึก';$('#lookbookProductSource').setAttribute('aria-label','เลือกสินค้าแล้วระบบจะแสดงรูปทันที');
  $('.lookbook-source').insertAdjacentHTML('afterend',`<div class="lookbook-finish-link"><div><b>เชื่อม Finish Look กับสินค้า</b><small>การ์ด 01–02 บนหน้าร้านจะใช้ภาพจากสินค้านี้เท่านั้น</small></div><select id="lookbookFinishProductSource"><option value="">ยังไม่เชื่อมสินค้า</option>${products.map(product=>`<option value="${escapeAttribute(product.id)}" ${(lookbookConfig.finishProductId||lookbookConfig.sourceProductId)===product.id?'selected':''}>${escapeHTML(product.name)} · ${(product.lookImages?.length||Number(Boolean(product.lookImage)))} ภาพ</option>`).join('')}</select><span id="lookbookFinishLinkState"></span></div>`);const updateFinishLinkState=()=>{const product=products.find(item=>item.id===$('#lookbookFinishProductSource').value),count=product?(product.lookImages?.length||Number(Boolean(product.lookImage))):0,state=$('#lookbookFinishLinkState');state.textContent=product?(count?`✓ เชื่อมแล้ว · มี Finish Look ${count} ภาพ`:'! เชื่อมแล้ว แต่สินค้านี้ยังไม่มีภาพ Finish Look'):'ยังไม่ได้เลือกสินค้าเจ้าของ Finish Look';state.className=count?'ready':product?'warning':'';};$('#lookbookFinishProductSource').addEventListener('change',event=>{lookbookConfig.finishProductId=event.target.value;updateFinishLinkState();$('#storeSaveState').textContent='เปลี่ยนการเชื่อม Finish Look แล้ว กรุณาบันทึก';});$('#lookbookProductSource').addEventListener('change',event=>{if(!event.target.value)return;lookbookConfig.finishProductId=event.target.value;$('#lookbookFinishProductSource').value=event.target.value;updateFinishLinkState();});updateFinishLinkState();
  $('#useProductModel').hidden=true;$('#lookbookProductSource').addEventListener('change',event=>{const product=products.find(item=>item.id===event.target.value);lookbookConfig.sourceProductId=event.target.value;if(!product?.image){lookbookConfig.image='';originalLookbookImage='';previewLookbook();return;}lookbookConfig.image=product.image;originalLookbookImage=product.image;previewLookbook();$('#storeSaveState').textContent='เลือกโมเดลใหม่แล้ว กรุณาบันทึก';});$('#uploadLookbookModel').addEventListener('click',()=>$('#lookbookModelFile').click());$('#lookbookModelFile').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;lookbookConfig.image=await readLookbookFile(file);originalLookbookImage=lookbookConfig.image;lookbookConfig.sourceProductId='';$('#lookbookProductSource').value='';previewLookbook();});$('#backgroundTolerance').addEventListener('input',event=>{$('#backgroundToleranceValue').textContent=event.target.value;lookbookConfig.tolerance=Number(event.target.value);});$('#removeModelBackground').addEventListener('click',async()=>{if(!originalLookbookImage){siteAlert('กรุณาเลือกสินค้า หรืออัปโหลดภาพก่อนตัดพื้นหลัง',{theme:'store'});return;}const button=$('#removeModelBackground');button.disabled=true;button.textContent='กำลังแยกเสื้อออกจากพื้นหลัง…';try{lookbookConfig.image=await removeImageBackgroundSmart(originalLookbookImage,lookbookConfig.tolerance);previewLookbook();$('#storeSaveState').textContent='ตัดพื้นหลังแล้ว กรุณาตรวจสอบและบันทึก';showAdminToast('ตัดพื้นหลังและเงารบกวนแล้ว','หากขอบหาย ให้ลดค่าความละเอียดแล้วกดตัดใหม่');}catch(_){siteAlert('ไม่สามารถตัดพื้นหลังรูปนี้ได้ หากเป็น URL ภายนอกให้ดาวน์โหลดแล้วอัปโหลดไฟล์แทน',{theme:'store'});}finally{button.disabled=false;button.textContent='✦ ตัดพื้นหลังและเงา';}});$('#resetLookbookModel').addEventListener('click',async()=>{if(!lookbookConfig.image)return;if(!await siteConfirm('ต้องการลบโมเดล Lookbook ที่เลือกอยู่หรือไม่?',{theme:'store',title:'ลบโมเดล Lookbook',confirmText:'ลบโมเดล'}))return;lookbookConfig.image='';originalLookbookImage='';lookbookConfig.sourceProductId='';$('#lookbookProductSource').value='';previewLookbook();$('#storeSaveState').textContent='ลบโมเดลแล้ว กรุณาบันทึกการเปลี่ยนแปลง';});$('#saveLookbookModel').addEventListener('click',async()=>{await saveStoreLookbook(lookbookConfig);showAdminToast('บันทึกโมเดล Lookbook แล้ว','หน้าร้านจะใช้โมเดลที่เลือกทันทีเมื่อเปิดใหม่');});
  const modelStudio=host.querySelector('.lookbook-model-admin');modelStudio.insertAdjacentHTML('beforebegin',`<button type="button" class="lookbook-studio-toggle" id="lookbookStudioToggle"><span>✦ LOOKBOOK MODEL STUDIO</span><b>ตั้งค่าโมเดลแบนเนอร์</b><i>⌄</i></button>`);modelStudio.hidden=true;$('#lookbookStudioToggle').addEventListener('click',()=>{modelStudio.hidden=!modelStudio.hidden;$('#lookbookStudioToggle').classList.toggle('open',!modelStudio.hidden);});
  const listHost=$('#storeAdminList');listHost.insertAdjacentHTML('beforebegin',`<div class="store-manager-layout"><aside class="store-product-sidebar"><header><small>PRODUCT CATALOG</small><b>รายการสินค้า</b></header><div id="storeProductNavigation"></div><footer><span>เลือกสินค้าเพื่อแก้ไข</span></footer></aside><main class="store-editor-stage" id="storeEditorStage"></main></div>`);$('#storeEditorStage').appendChild(listHost);let selectedStoreIndex=0,activeStoreSection='basic';
  const renderManagerNavigation=()=>{const navigation=$('#storeProductNavigation');navigation.innerHTML=products.length?products.map((product,index)=>`<button type="button" data-select-store-product="${index}" class="${index===selectedStoreIndex?'active':''}"><span>${product.image?`<img src="${escapeAttribute(product.image)}" alt="">`:`<i style="--product-color:${escapeAttribute(product.color||'#e8b21e')}">PR</i>`}</span><span><b>${escapeHTML(product.name||'สินค้าใหม่')}</b><small>${product.published!==false?'● วางขาย':'○ แบบร่าง'} · ${Number(product.stock)||0} ชิ้น</small></span><em>›</em></button>`).join(''):'<div class="store-sidebar-empty">ยังไม่มีสินค้า</div>';navigation.querySelectorAll('[data-select-store-product]').forEach(button=>button.addEventListener('click',()=>{selectedStoreIndex=Number(button.dataset.selectStoreProduct);activeStoreSection='basic';renderManagerNavigation();}));const editors=[...$('#storeAdminList').querySelectorAll('.store-editor')];editors.forEach((editor,index)=>editor.hidden=index!==selectedStoreIndex);const editor=editors[selectedStoreIndex];if(!editor)return;const fields=editor.querySelector('.store-editor-fields');if(!fields.querySelector('.store-editor-steps'))fields.querySelector('.store-editor-head').insertAdjacentHTML('afterend',`<nav class="store-editor-steps"><button type="button" data-store-section="basic"><b>1</b><span>ข้อมูลสินค้า<small>ชื่อ ราคา และสต็อก</small></span></button><button type="button" data-store-section="media"><b>2</b><span>รูปและวิดีโอ<small>อัปโหลดและจัดวาง</small></span></button><button type="button" data-store-section="look"><b>3</b><span>Finish Look<small>ลุคและคำแนะนำ</small></span></button></nav>`);const applySection=()=>{fields.querySelectorAll('[data-store-section]').forEach(button=>button.classList.toggle('active',button.dataset.storeSection===activeStoreSection));fields.querySelector('.store-field-grid').hidden=activeStoreSection!=='basic';const description=[...fields.children].find(child=>child.tagName==='LABEL');if(description)description.hidden=activeStoreSection!=='basic';const mediaGuide=fields.querySelector('.store-media-guide');if(mediaGuide)mediaGuide.hidden=activeStoreSection!=='media';fields.querySelector('.store-media-fields').hidden=activeStoreSection!=='media';const mediaStatus=fields.querySelector('.store-media-status');if(mediaStatus)mediaStatus.hidden=activeStoreSection!=='media';fields.querySelector('.store-look-fields').hidden=activeStoreSection!=='look';};fields.querySelectorAll('[data-store-section]').forEach(button=>button.addEventListener('click',()=>{activeStoreSection=button.dataset.storeSection;applySection();}));applySection();};
  const draw=()=>{const list=$('#storeAdminList');list.innerHTML=products.map((p,i)=>`<article class="store-editor" data-index="${i}"><div class="store-editor-preview">${productVisual(p)}<span>${p.published!==false?'กำลังขาย':'แบบร่าง'}</span></div><div class="store-editor-fields"><div class="store-editor-head"><div><small>PRODUCT ${String(i+1).padStart(2,'0')}</small><h4>${escapeHTML(p.name||'สินค้าใหม่')}</h4></div><label class="publish-switch"><input type="checkbox" data-field="published" ${p.published!==false?'checked':''}><i></i> เผยแพร่</label><button class="store-delete" data-store-delete="${i}">ลบ</button></div><div class="store-field-grid"><label>ชื่อสินค้า<input data-field="name" value="${escapeAttribute(p.name||'')}"></label><label>หมวดหมู่<input data-field="category" value="${escapeAttribute(p.category||'')}"></label><label>ราคาขาย<input type="number" min="0" data-field="price" value="${Number(p.price)||0}"></label><label>ราคาเดิม<input type="number" min="0" data-field="comparePrice" value="${Number(p.comparePrice)||0}"></label><label>สต็อก<input type="number" min="0" data-field="stock" value="${Number(p.stock)||0}"></label><label>ป้ายสินค้า<input data-field="badge" value="${escapeAttribute(p.badge||'')}"></label><label>ไซซ์ (คั่นด้วย ,)<input data-field="sizes" value="${escapeAttribute((p.sizes||[]).join(', '))}"></label><label>สีหลัก<input type="color" data-field="color" value="${escapeAttribute(p.color||'#e8b21e')}"></label></div><label>รายละเอียด<textarea data-field="description">${escapeHTML(p.description||'')}</textarea></label><div class="store-media-fields"><label>URL รูปสินค้า<input data-field="image" value="${escapeAttribute(p.image||'')}" placeholder="https://..."></label><label>URL วิดีโอนายแบบ/นางแบบ<input data-field="video" value="${escapeAttribute(p.video||'')}" placeholder="https://...mp4"></label><label>URL ภาพ Finish Look<input data-field="lookImage" value="${escapeAttribute(p.lookImage||'')}" placeholder="https://..."></label></div><div class="store-look-fields"><label>ชื่อ Finish Look<input data-field="lookTitle" value="${escapeAttribute(p.lookTitle||'')}"></label><label>คำแนะนำการแต่งตัว<input data-field="lookText" value="${escapeAttribute(p.lookText||'')}"></label></div></div></article>`).join('')||'<div class="admin-gallery-empty">ยังไม่มีสินค้า กด “เพิ่มสินค้า” เพื่อเริ่มจัดหน้าร้าน</div>';bind();};
  const bind=()=>{
    const fileData=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
    $('#storeAdminList').querySelectorAll('input[data-field="sizes"]').forEach(input=>{const editor=input.closest('.store-editor'),product=products[Number(editor.dataset.index)],picker=document.createElement('fieldset');picker.className='store-size-picker';picker.innerHTML=`<legend>ไซซ์ที่วางขาย</legend><div>${STORE_SIZE_OPTIONS.map(size=>`<label><input type="checkbox" data-size-option="${escapeAttribute(size)}" ${(product.sizes||[]).includes(size)?'checked':''}><span>${escapeHTML(size)}</span></label>`).join('')}</div><small>เลือกได้หลายไซซ์ · ลูกค้าจะเห็นเฉพาะไซซ์ที่เลือก</small>`;input.parentElement.replaceWith(picker);picker.querySelectorAll('[data-size-option]').forEach(option=>option.addEventListener('change',()=>{product.sizes=[...picker.querySelectorAll('[data-size-option]:checked')].map(item=>item.dataset.sizeOption);$('#storeSaveState').textContent='มีการแก้ไขไซซ์ที่ยังไม่ได้บันทึก';}));});
    $('#storeAdminList').querySelectorAll('.store-editor').forEach(editor=>{const product=products[Number(editor.dataset.index)];[['image','รูปสินค้าที่อัปโหลด'],['video','วิดีโอที่อัปโหลด'],['lookImage','สไลด์ที่อัปโหลด']].forEach(([field,label])=>{const input=editor.querySelector(`[data-field="${field}"]`);if(input&&String(product[field]||'').startsWith('data:')){input.value='';input.placeholder=`✓ มี${label}แล้ว · หรือวาง URL เพื่อเปลี่ยน`;}});});
    $('#storeAdminList').querySelectorAll('.store-editor').forEach(editor=>{const index=Number(editor.dataset.index),product=products[index],media=editor.querySelector('.store-media-fields'),labels=[...media.querySelectorAll('label')];media.insertAdjacentHTML('beforebegin','<div class="store-media-guide"><b>คลังสื่อสินค้า</b><span>อัปโหลดไฟล์จากเครื่อง หรือวาง URL อย่างใดอย่างหนึ่ง</span></div>');labels.forEach((label,mediaIndex)=>{const config=[{accept:'image/*',multiple:false,text:'เลือกรูปสินค้า'},{accept:'video/*',multiple:false,text:'เลือกวิดีโอ'},{accept:'image/*',multiple:true,text:'เลือกภาพสไลด์'}][mediaIndex],input=document.createElement('input'),button=document.createElement('button');input.type='file';input.accept=config.accept;input.multiple=config.multiple;input.hidden=true;button.type='button';button.className='store-file-button';button.textContent=`＋ ${config.text}`;label.append(button,input);button.addEventListener('click',()=>input.click());input.addEventListener('change',async()=>{const files=[...input.files];if(!files.length)return;button.textContent='กำลังเตรียมไฟล์…';try{const values=await Promise.all(files.map(fileData));if(mediaIndex===0){product.image=values[0];product.mediaCrops={...(product.mediaCrops||{}),image:{x:50,y:50,zoom:1}};}else if(mediaIndex===1)product.video=values[0];else{product.lookImages=[...(product.lookImages||[]),...values].slice(0,10);product.lookImage=product.lookImages[0]||product.lookImage;}$('#storeSaveState').textContent='มีไฟล์ใหม่ที่ยังไม่ได้บันทึก';draw();}catch(_){siteAlert('ไม่สามารถอ่านไฟล์นี้ได้ กรุณาเลือกไฟล์ใหม่',{theme:'store'});}});});const count=(product.lookImages||[]).length;if(product.image||product.video||count){const status=document.createElement('div');status.className='store-media-status';status.innerHTML=`<b>ไฟล์พร้อมใช้งาน</b>${product.image?'<span>✓ รูปสินค้า</span>':''}${product.video?'<span>✓ วิดีโอ</span>':''}${count?`<span>✓ Finish Look ${count} ภาพ</span>`:''}<button type="button">ล้างไฟล์</button>`;media.after(status);status.querySelector('button').addEventListener('click',async()=>{if(!await siteConfirm('ต้องการล้างรูปสินค้า วิดีโอ และภาพ Finish Look ทั้งหมดหรือไม่?',{theme:'store',title:'ล้างไฟล์สินค้านี้',confirmText:'ล้างไฟล์ทั้งหมด'}))return;product.image='';product.video='';product.lookImage='';product.lookImages=[];product.mediaCrops={};draw();});}});
    $('#storeAdminList').querySelectorAll('.store-editor').forEach(editor=>{const status=editor.querySelector('.store-media-status');if(!status)return;status.lastElementChild.classList.add('store-media-clear');const product=products[Number(editor.dataset.index)],button=document.createElement('button');button.type='button';button.className='open-crop-studio';button.textContent='✦ จัดตำแหน่งรูป';status.insertBefore(button,status.lastElementChild);button.addEventListener('click',()=>openStoreCropStudio(product,()=>{$('#storeSaveState').textContent='มีการจัดวางสื่อที่ยังไม่ได้บันทึก';draw();}));});
    $('#storeAdminList').querySelectorAll('[data-field]').forEach(input=>input.addEventListener('input',()=>{const p=products[Number(input.closest('.store-editor').dataset.index)];p[input.dataset.field]=input.dataset.field==='published'?input.checked:input.dataset.field==='sizes'?input.value.split(',').map(v=>v.trim()).filter(Boolean):['price','comparePrice','stock'].includes(input.dataset.field)?Number(input.value):input.value;$('#storeSaveState').textContent='มีการแก้ไขที่ยังไม่ได้บันทึก';updateStoreSummary();if(['published','color'].includes(input.dataset.field))draw();}));
    $('#storeAdminList').querySelectorAll('[data-store-delete]').forEach(btn=>btn.addEventListener('click',async()=>{const index=Number(btn.dataset.storeDelete),product=products[index];if(!await siteConfirm(`ต้องการลบสินค้า “${product?.name||'รายการนี้'}” หรือไม่?`,{theme:'store',title:'ยืนยันการลบสินค้า',confirmText:'ลบสินค้า'}))return;products.splice(index,1);selectedStoreIndex=Math.max(0,Math.min(selectedStoreIndex,products.length-1));updateStoreSummary();draw();}));
    renderManagerNavigation();
  };
  $('#addStoreProduct').addEventListener('click',()=>{products.push({id:`product-${Date.now()}`,name:'สินค้าใหม่',category:'สินค้าแฟนคลับ',price:0,comparePrice:0,badge:'NEW',stock:0,published:false,sizes:['FREE SIZE'],color:'#e8b21e',description:'',image:'',video:'',lookImage:'',lookTitle:'Your Style',lookText:''});selectedStoreIndex=products.length-1;activeStoreSection='basic';updateStoreSummary();draw();setTimeout(()=>$('#storeEditorStage').scrollIntoView({behavior:'smooth',block:'start'}),50);});
  $('#saveStoreProducts').addEventListener('click',async()=>{const button=$('#saveStoreProducts');button.disabled=true;button.textContent='กำลังบันทึกไฟล์…';try{await saveStoreProducts(products);updateStoreSummary();$('#storeSaveState').textContent='บันทึกและเผยแพร่หน้าร้านแล้ว';showAdminToast('อัปเดตหน้าร้านสำเร็จ','สินค้า สต็อก รูป วิดีโอ และสไลด์ถูกซิงค์แล้ว');}catch(_){siteAlert('เบราว์เซอร์ไม่สามารถบันทึกไฟล์ได้ กรุณาตรวจสอบพื้นที่ว่างของอุปกรณ์แล้วลองใหม่',{theme:'store',title:'บันทึกไฟล์ไม่สำเร็จ'});}finally{button.disabled=false;button.innerHTML='บันทึกและเผยแพร่หน้าร้าน <b>→</b>';}});updateStoreSummary();draw();
}

const STAFF_ACCOUNTS = Array.isArray(window.PHANUANG_ACCESS_ACCOUNTS) ? window.PHANUANG_ACCESS_ACCOUNTS : [];
const TEACHER_ACCOUNTS = STAFF_ACCOUNTS.filter((account) => account.role === 'teacher');
const STUDENT_ADMIN_ACCOUNTS = STAFF_ACCOUNTS.filter((account) => account.role === 'student-admin');
// access-data.js only identifies an allowed admin and their display role. Firebase
// Authentication is the only authority that verifies the password.
function findStaffAccount(username) { return STAFF_ACCOUNTS.find((account) => String(account.username) === String(username).trim()); }
function firebaseAdminEmail(account) {
  const domain = String(window.FIREBASE_ADMIN_EMAIL_DOMAIN || 'phunrueang.admin').replace(/^@/, '');
  return account.firebaseEmail || `${account.username}@${domain}`;
}
function firebaseAdminPassword(password) {
  return `pn_${String(password)}`;
}
async function signInFirebaseAdmin(account, password) {
  if (!window.firebase || !firebaseConfigured(window.FIREBASE_CONFIG)) throw Object.assign(new Error('Firebase is not configured'), { code: 'firebase/not-configured' });
  const auth = firebase.auth();
  console.info('[Auth] login requested', { studentId: account.username, email: firebaseAdminEmail(account) });
  try {
    await firebaseAuthPersistenceReady;
    const credential = await auth.signInWithEmailAndPassword(firebaseAdminEmail(account), firebaseAdminPassword(password));
    console.info('[Auth] signIn success', { uid: credential.user.uid, email: credential.user.email || null });
    return await waitForFirebaseAuthUser(auth, credential.user.uid);
  } catch (error) {
    console.error('[Auth] error code/message', error?.code, error?.message);
    throw error;
  }
}
function teacherAccountsForRooms(rooms = []) { return TEACHER_ACCOUNTS.filter((teacher) => rooms.includes(teacher.room)); }
if (!localStorage.getItem('phanuang-access-directory') && Array.isArray(window.PHANUANG_ACCESS_DIRECTORY)) localStorage.setItem('phanuang-access-directory', JSON.stringify(window.PHANUANG_ACCESS_DIRECTORY));
const seats = Array.from({ length: 10 }, (_, row) => Array.from({ length: 18 }, (_, col) => `${String.fromCharCode(65 + row)}${col + 1}`));
const seatCodes = seats.flat();
const seatCodeSet = new Set(seatCodes);
const ATTENDANCE_SESSIONS_KEY = 'phanuang-attendance-sessions';
const ATTENDANCE_RECORDS_KEY = 'phanuang-attendance-records';
const ATTENDANCE_RESET_VERSION = 'attendance-reset-unlimited-v1';
if (localStorage.getItem('phanuang-attendance-reset-version') !== ATTENDANCE_RESET_VERSION) localStorage.setItem('phanuang-attendance-reset-version', ATTENDANCE_RESET_VERSION);
let attendanceViewingSessionId = '';
let attendanceCameraStream = null;
let attendanceScanTimer = 0;
let attendanceStatusTimer = 0;
function getAttendanceSessions() { try { const sessions = JSON.parse(localStorage.getItem(ATTENDANCE_SESSIONS_KEY) || '[]'); let migrated = false; const days = [...new Set(sessions.map((session) => session.time?.slice(0,10)).filter(Boolean))]; days.forEach((day) => { const sameDay = sessions.filter((session) => session.time?.slice(0,10) === day).sort((a,b) => new Date(a.time)-new Date(b.time)); let nextRound = Math.max(0,...sameDay.map((session) => Number(session.round)||0)) + 1; sameDay.forEach((session) => { if (session.round) return; session.round = nextRound++; migrated = true; }); }); if (migrated) localStorage.setItem(ATTENDANCE_SESSIONS_KEY, JSON.stringify(sessions)); return sessions; } catch (_) { return []; } }
function getAttendanceRecords() { try { return JSON.parse(localStorage.getItem(ATTENDANCE_RECORDS_KEY) || '{}'); } catch (_) { return {}; } }
function getAttendanceConfig() { try { return JSON.parse(localStorage.getItem('phanuang-attendance-config') || '{}'); } catch (_) { return {}; } }
function getAttendance(sessionId = attendanceViewingSessionId || getAttendanceConfig().sessionId || getAttendanceConfig().id) { return getAttendanceRecords()[sessionId] || {}; }
function formatAttendanceSession(session) { if (!session?.time) return 'ยังไม่ได้กำหนดรอบ'; const round = session.round ? `รอบที่ ${session.round}` : 'รอบเดิม'; return `${round} · ${formatThaiDate(new Date(session.time))} — ${new Date(session.close).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})} น.`; }
function getAttendanceWindowStatus(config = getAttendanceConfig()) { const now = Date.now(), open = new Date(config.time).getTime(), close = new Date(config.close).getTime(), sessionId = config.sessionId || config.id; if (!sessionId || !Number.isFinite(open) || !Number.isFinite(close)) return { state:'unset', allowed:false, message:'กรุณากำหนดและบันทึกรอบเช็คชื่อก่อน' }; if (now < open) return { state:'waiting', allowed:false, message:`ระบบจะเปิดอัตโนมัติ ${formatThaiDate(open)}`, remaining:open-now }; if (now > close) return { state:'ended', allowed:false, message:`รอบนี้สิ้นสุดแล้วเมื่อ ${formatThaiDate(close)}` }; return { state:'open', allowed:true, message:`เปิดรับถึง ${new Date(close).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})} น.`, remaining:close-now }; }
function renderAdmin() {
  const host = $('#adminContent');
  const staff = JSON.parse(localStorage.getItem('phanuang-admin') || 'null');
  if (!staff) { host.innerHTML = `<div class="admin-login-shell"><div class="admin-login-visual"><small>PHUNRUEANG STAFF</small><div class="login-sigil"><i>✦</i><b>PR</b></div><h3>เบื้องหลังทุกชัยชนะ<br>คือทีมที่พร้อมเสมอ</h3><p>พื้นที่ปฏิบัติการสำหรับทีมงานคณะสีพันเรือง</p><div class="login-status"><span></span> ${STAFF_ACCOUNTS.length} STAFF ACCOUNTS READY</div></div><div class="admin-login"><div class="login-step">01 / AUTHENTICATION</div><h3>ยินดีต้อนรับกลับ</h3><p>กรอกเลขประจำตัวและรหัสผ่านเพื่อเข้าสู่ศูนย์บัญชาการ</p><form id="adminLoginForm"><div class="field"><label>Username / เลขประจำตัว</label><div class="admin-input"><span>◉</span><input id="adminStudentId" required inputmode="numeric" autocomplete="username" placeholder="เช่น 44447 หรือ 69651"></div></div><div class="field"><label>รหัสผ่าน</label><div class="admin-input"><span>◆</span><input id="adminPassword" required type="password" autocomplete="current-password" placeholder="••••"></div></div><div class="error" id="adminLoginError"></div><button class="primary">เข้าสู่ COMMAND CENTER <b>→</b></button></form><small class="admin-secure-note">บัญชีผู้ดูแลเท่านั้นที่สามารถบันทึกข้อมูลส่วนกลางได้</small></div></div>`; $('#adminLoginForm').addEventListener('submit', async (event) => { event.preventDefault(); const button=$('#adminLoginForm button'), username=$('#adminStudentId').value, password=$('#adminPassword').value, account=findStaffAccount(username); if (!account) { $('#adminLoginError').textContent = 'ไม่พบเลขประจำตัวผู้ดูแล'; return; } button.disabled=true; $('#adminLoginError').textContent='กำลังยืนยันตัวตน…'; try { await signInFirebaseAdmin(account,password); localStorage.setItem('phanuang-admin', JSON.stringify({ username:account.username, name:account.name, room:account.room, role:account.role, teams:account.teams })); renderAdmin(); } catch (error) { $('#adminLoginError').textContent = `${error?.code || 'auth/unknown'}: ${error?.message || 'Firebase Authentication failed'}`; button.disabled=false; } }); return; }
  const firebaseLive=firebaseConnectionState==='LIVE',firebaseHint=firebaseConnectionDetail||firebaseConnectionState;
  host.innerHTML = `<div class="admin-workspace"><header class="admin-top"><div class="staff-avatar">${staff.name.slice(0,1)}</div><div><small>${staff.role==='teacher'?'ADVISOR ACCESS':'STUDENT ADMIN ACCESS'} · ${escapeHTML(staff.room||'-')}</small><p><b>${staff.name}</b> <span>ออนไลน์</span></p></div><div class="admin-live" title="Database: ${escapeAttribute(firebaseHint)} · Permission: ${firebaseAdminPermission}"><i></i> ${firebaseLive ? firebaseAdminPermission : 'DATABASE OFFLINE'}</div><button class="mini" id="adminLogout">ออกจากระบบ ↗</button></header>${firebaseLive ? (firebaseAdminPermission==='ADMIN WRITE' ? '' : `<p class="note" style="margin:12px 0 0">Database: LIVE · Admin permission: READ ONLY</p>`) : `<p class="note" style="margin:12px 0 0">Database: OFFLINE · ${escapeHTML(firebaseHint)}</p>`}<nav class="admin-tabs" aria-label="เมนูผู้ดูแล"><button class="admin-tab active" data-admin-tab="attendance"><i>✓</i><span>เช็คชื่อ<small>ATTENDANCE</small></span></button><button class="admin-tab" data-admin-tab="attendance-history"><i>◴</i><span>ประวัติเช็คชื่อ<small>HISTORY</small></span></button><button class="admin-tab" data-admin-tab="sports"><i>🏆</i><span>ผลกีฬา<small>SPORTS</small></span></button><button class="admin-tab" data-admin-tab="members"><i>♙</i><span>สมาชิก<small>MEMBERS</small></span></button><button class="admin-tab" data-admin-tab="store"><i>◆</i><span>จัดการร้านค้า<small>STORE MANAGER</small></span></button><button class="admin-tab" data-admin-tab="orders"><i>▤</i><span>คำสั่งซื้อ<small>ORDERS & CSV</small></span></button><button class="admin-tab" data-admin-tab="photos"><i>◫</i><span>รูปกิจกรรม<small>GALLERY</small></span></button><button class="admin-tab" data-admin-tab="election"><i>✦</i><span>เลือกตั้ง<small>ELECTION</small></span></button></nav><div id="adminPanel"></div></div>`;
  $('#adminLogout').addEventListener('click', async () => { localStorage.removeItem('phanuang-admin'); try { await firebase.auth().signOut(); } catch (error) { console.error('[Firebase] admin sign-out error', error?.code, error); } renderAdmin(); });
  document.querySelectorAll('.admin-tab').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.admin-tab').forEach((item) => item.classList.toggle('active', item === button)); const panel = $('#adminPanel'); panel.classList.remove('panel-arrive'); void panel.offsetWidth; renderAdminPanel(button.dataset.adminTab); panel.classList.add('panel-arrive'); }));
  renderAdminPanel('attendance');
}
function renderOrdersAdmin(host){
  const products=getStoreProducts(),orders=JSON.parse(localStorage.getItem('phanuang-orders')||'[]').map(order=>{const product=products.find(item=>item.id===order.productId||item.name===order.product),price=Number(order.price??product?.price??0),quantity=Number(order.quantity)||0;return {...order,price,quantity,total:Number(order.total??price*quantity)};}).sort((a,b)=>(b.time||0)-(a.time||0));
  const roomOrders=orders.filter(order=>String(order.orderType||'').includes('ห้อง')),personalOrders=orders.filter(order=>!String(order.orderType||'').includes('ห้อง')),money=value=>`฿${Number(value||0).toLocaleString('th-TH')}`,revenue=orders.reduce((sum,order)=>sum+order.total,0);
  const sizeSummary=order=>{let entries=[];const selected=(order.studentOrders||[]).filter(student=>student.ordering);if(selected.length){const counts=selected.reduce((result,student)=>(result[student.size]=(result[student.size]||0)+1,result),{});entries=Object.entries(counts);}else{entries=String(order.size||'').split(',').map(part=>{const match=part.trim().match(/^(.+?)\s*[×xX]\s*(\d+)$/);return match?[match[1].trim(),Number(match[2])]:[part.trim()||'-',Number(order.quantity)||1];});}return `<div class="size-breakdown">${entries.map(([label,count])=>`<span><small>ไซซ์</small><b>${escapeHTML(label)}</b><i>×</i><strong>${Number(count)||0}</strong></span>`).join('')}<em>รวม <b>${order.quantity}</b> ชิ้น</em></div>`;};
  const rows=(items,type)=>items.length?items.map(order=>`<tr><td><span class="order-type-badge ${type}">${type==='room'?'♟ รายห้อง':'♙ ส่วนตัว'}</span></td><td><b>${escapeHTML(order.name||'-')}</b>${type==='room'?`<small class="order-subline">ผู้ประสานงาน · ${escapeHTML(order.coordinatorId||'ไม่ระบุรหัส')}</small>`:`<small class="order-subline">เลขที่ ${escapeHTML(order.number||'-')}</small>`}</td><td><span class="room-pill">${escapeHTML(order.room||'-')}</span></td><td>${escapeHTML(order.product||'-')}</td><td>${sizeSummary(order)}</td><td class="number-cell">${order.quantity}</td><td class="price-cell"><small>${money(order.price)} / ชิ้น</small><b>${money(order.total)}</b></td></tr>`).join(''):`<tr class="empty-row"><td colspan="7">ยังไม่มีคำสั่งซื้อ${type==='room'?'รายห้อง':'ส่วนตัว'}</td></tr>`;
  const section=(type,title,subtitle,items,total)=>`<section class="order-group ${type}"><header><div><span>${type==='room'?'♟':'♙'}</span><div><small>${type==='room'?'ROOM ORDERS':'PERSONAL ORDERS'}</small><h4>${title}</h4><p>${subtitle}</p></div></div><div><b>${items.length}</b><span>รายการ</span><strong>${money(total)}</strong></div></header><div class="table-wrap"><table><thead><tr><th>ประเภท</th><th>${type==='room'?'ผู้ประสานงาน':'ผู้สั่งซื้อ'}</th><th>ห้อง</th><th>สินค้า</th><th>รายละเอียดไซซ์</th><th>จำนวน</th><th>ราคา / ยอดรวม</th></tr></thead><tbody>${rows(items,type)}</tbody></table></div></section>`;
  host.innerHTML=`<div class="admin-panel orders-panel orders-v2"><div class="panel-heading"><div><small>COMMERCE · ORDER CENTER</small><h3>คำสั่งซื้อสินค้า</h3><p>แยกคำสั่งซื้อส่วนตัวและรายห้อง พร้อมราคาต่อชิ้นและยอดรวม</p></div><div class="order-export-actions"><button type="button" id="downloadPersonalOrders">↓ CSV ส่วนตัว</button><button type="button" id="downloadRoomOrders">↓ CSV รายห้อง</button></div></div><div class="orders-dashboard"><div><small>ALL ORDERS</small><b>${orders.length}</b><span>คำสั่งซื้อทั้งหมด</span></div><div class="personal"><small>PERSONAL</small><b>${personalOrders.length}</b><span>สั่งส่วนตัว</span></div><div class="room"><small>ROOM</small><b>${roomOrders.length}</b><span>สั่งรายห้อง</span></div><div class="revenue"><small>TOTAL VALUE</small><b>${money(revenue)}</b><span>มูลค่ารวมทุกคำสั่งซื้อ</span></div></div>${section('personal','คำสั่งซื้อส่วนตัว','ตรวจสอบข้อมูลนักเรียนและรายการรายบุคคล',personalOrders,personalOrders.reduce((sum,order)=>sum+order.total,0))}${section('room','คำสั่งซื้อรายห้อง','ยอดรวมที่ผู้ประสานงานส่งให้ทั้งห้อง',roomOrders,roomOrders.reduce((sum,order)=>sum+order.total,0))}</div>`;
  $('#downloadPersonalOrders').addEventListener('click',()=>downloadOrders('personal'));
  $('#downloadRoomOrders').addEventListener('click',()=>downloadOrders('room'));
}
function renderAdminPanel(tab) {
  const host = $('#adminPanel');
  if (tab === 'members') { renderCommitteeAdmin(host); return; }
  if (tab === 'attendance-history') { renderAttendanceHistory(host); return; }
  if (tab === 'sports') { renderSportsAdmin(host); return; }
  if (tab === 'store') { renderStoreAdmin(host); return; }
  if (tab === 'attendance') {
    const config = getAttendanceConfig();
    const sessions = getAttendanceSessions();
    attendanceViewingSessionId = attendanceViewingSessionId || config.sessionId || config.id || sessions[0]?.id || '';
    const status = getAttendanceWindowStatus(config);
    const startDate = config.time ? config.time.slice(0,10) : new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
    const startClock = config.time ? config.time.slice(11,16) : new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(11,16);
    const savedDuration = config.time && config.close ? Math.max(5, Math.round((new Date(config.close)-new Date(config.time))/60000)) : 15;
    host.innerHTML = `<div class="admin-panel attendance-panel"><div class="panel-heading"><div><small>LIVE OPERATIONS · 01</small><h3>เช็คชื่อขึ้นแสตนด์</h3><p>ตั้งเวลาเพียงครั้งเดียว ระบบจะเปิดและปิดรับเช็คชื่อให้อัตโนมัติ</p></div><button class="primary scan-button" id="scanSeat"><span>⌗</span> สแกน QR / พิมพ์รหัส</button></div><section class="attendance-scheduler"><div class="scheduler-head"><div><small>AUTO SCHEDULE</small><h4>กำหนดรอบเช็คชื่อ</h4></div><span>ระบบเปิดอัตโนมัติเมื่อถึงเวลา</span></div><div class="attendance-config"><div class="field schedule-date"><label>วันที่เช็คชื่อ</label><input id="attendanceDate" type="date" value="${startDate}"></div><div class="field"><label>เวลาเริ่ม</label><input id="attendanceStartClock" type="time" value="${startClock}"></div><div class="field"><label>เปิดรับนาน</label><select id="attendanceDuration"><option value="10" ${savedDuration===10?'selected':''}>10 นาที</option><option value="15" ${savedDuration===15?'selected':''}>15 นาที</option><option value="30" ${savedDuration===30?'selected':''}>30 นาที</option><option value="45" ${savedDuration===45?'selected':''}>45 นาที</option><option value="60" ${savedDuration===60?'selected':''}>1 ชั่วโมง</option><option value="${savedDuration}" ${![10,15,30,45,60].includes(savedDuration)?'selected':''}>${savedDuration} นาที</option></select></div><button class="primary save-attendance-session" id="saveAttendanceTime">ตั้งเวลาเปิดอัตโนมัติ <b>→</b></button></div><div class="schedule-preview" id="attendanceSchedulePreview"></div></section><div class="attendance-status state-${status.state}"><i></i><div><b id="attendanceStatusTitle"></b><span id="attendanceStatusMessage"></span></div><strong id="attendanceStatusCountdown"></strong></div><div class="attendance-history"><label for="attendanceSessionSelect">รอบที่ตั้งไว้และประวัติย้อนหลัง</label><select id="attendanceSessionSelect">${sessions.length ? sessions.map((session) => `<option value="${session.id}" ${session.id === attendanceViewingSessionId ? 'selected' : ''}>${formatAttendanceSession(session)}</option>`).join('') : '<option value="">ยังไม่มีรอบที่บันทึก</option>'}</select></div><p class="scan-note"><i></i> ผังนี้ใช้สำหรับดูสถานะเท่านั้น ไม่สามารถกดที่นั่งเพื่อเช็คชื่อได้</p><div class="stand-screen"><div class="stand-screen-head"><div><small>GRANDSTAND · READ ONLY MAP</small><b>ผังที่นั่งแสตนด์</b></div><span id="attendanceSummary"></span></div><div class="seat-map" id="seatMap"></div><div class="seat-legend"><span><i class="present"></i> มาแล้ว</span><span><i></i> ยังไม่มา</span></div></div></div><dialog class="attendance-scan-dialog" id="attendanceScanDialog"><div class="scan-dialog-head"><div><small>SECURE CHECK-IN</small><h3>สแกน QR ที่นั่ง</h3></div><button type="button" id="closeAttendanceScanner" aria-label="ปิด">×</button></div><div class="camera-stage"><video id="attendanceCamera" playsinline muted></video><div class="camera-reticle"><i></i><i></i><i></i><i></i></div><div class="camera-message" id="attendanceCameraMessage">กำลังเตรียมกล้อง…</div></div><div class="manual-checkin"><span>หรือพิมพ์รหัสที่นั่ง</span><form id="manualSeatForm"><input id="manualSeatCode" autocomplete="off" placeholder="เช่น A1" maxlength="3"><button class="primary">บันทึกเช็คชื่อ →</button></form><div class="error" id="attendanceScanError" aria-live="polite"></div></div></dialog>`;
    $('#saveAttendanceTime').addEventListener('click', saveAttendanceSession);
    $('#scanSeat').addEventListener('click', openAttendanceScanner);
    $('#closeAttendanceScanner').addEventListener('click', closeAttendanceScanner);
    $('#attendanceScanDialog').addEventListener('close', stopAttendanceCamera);
    $('#attendanceScanDialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeAttendanceScanner(); });
    $('#manualSeatForm').addEventListener('submit', (event) => { event.preventDefault(); markAttendance($('#manualSeatCode').value.trim().toUpperCase(), 'พิมพ์รหัส'); });
    $('#attendanceSessionSelect').addEventListener('change', (event) => { attendanceViewingSessionId = event.target.value; renderSeatMap(); });
    enhanceAttendanceRoundPicker(config, sessions);
    ['attendanceDate','attendanceStartClock','attendanceDuration','attendanceRound'].forEach((id) => $(`#${id}`).addEventListener('input', updateAttendanceSchedulePreview));
    enhanceAttendancePickers();
    updateAttendanceSchedulePreview();
    window.clearInterval(attendanceStatusTimer);
    updateAttendanceLiveStatus();
    attendanceStatusTimer = window.setInterval(updateAttendanceLiveStatus, 1000);
    renderSeatMap();
    return;
  }
  if (tab === 'orders') { renderOrdersAdmin(host); return; }
  if (tab === 'photos') {
    const gallery = JSON.parse(localStorage.getItem('phanuang-gallery') || '{"images":[],"driveUrl":""}');
    let selectedImages = gallery.images.slice(0, 25);
    host.innerHTML = `<div class="admin-panel gallery-admin-panel"><h3>รูปภาพกิจกรรม</h3><p>เพิ่ม ดูตัวอย่าง ลบ หรือกำหนดตำแหน่งรูปภาพสำหรับผนังรูปภาพกิจกรรมได้สูงสุด 25 รูป</p><div class="field"><label>ลิงก์ Google Drive สำหรับปุ่มดูรูปภาพกิจกรรม</label><input id="driveUrl" type="url" placeholder="https://drive.google.com/..." value="${gallery.driveUrl || ''}"></div><div class="gallery-admin-actions"><button type="button" class="upload-button" id="chooseActivityPhotos">เลือกเพิ่มรูปภาพหลายรูป</button><input id="activityPhotos" type="file" accept="image/*" multiple="multiple" hidden><button class="mini" id="saveGallery">บันทึกการตั้งค่า</button></div><p class="gallery-upload-help">เลือกหลายรูปพร้อมกันได้ — บนคอมพิวเตอร์ให้กด <b>Ctrl</b> หรือ <b>Shift</b> ค้างขณะเลือกรูป · เปลี่ยนช่อง “ตำแหน่ง” เพื่อสลับลำดับรูปบนหน้ารูปภาพกิจกรรม</p><p class="gallery-count" aria-live="polite"></p><div class="admin-gallery-preview" id="adminGalleryPreview"></div></div>`;
    const count = $('.gallery-count');
    const preview = $('#adminGalleryPreview');
    let uploadQueue = Promise.resolve();
    let imagesOptimized = false;
    const compressActivityImage = (file) => new Promise((resolve, reject) => {
      const isSavedImage = typeof file === 'string';
      const source = isSavedImage ? file : URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        if (!isSavedImage) URL.revokeObjectURL(source);
        const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
        const scale = Math.min(1, 960 / longestSide);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', .76));
      };
      image.onerror = () => { if (!isSavedImage) URL.revokeObjectURL(source); reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้')); };
      image.src = source;
    });
    $('#chooseActivityPhotos').addEventListener('click', () => $('#activityPhotos').click());
    const syncGallery = () => {
      try {
        localStorage.setItem('phanuang-gallery', JSON.stringify({ images: selectedImages, driveUrl: $('#driveUrl').value.trim() }));
        if ($('#gallery').classList.contains('active')) renderGalleryPage();
        return true;
      } catch (error) {
        window.alert('บันทึกรูปภาพไม่สำเร็จ เนื่องจากพื้นที่เก็บข้อมูลของเบราว์เซอร์เต็ม กรุณาลดจำนวนรูป หรือลบรูปเดิมก่อน');
        return false;
      }
    };
    const renderPreviews = () => {
      count.textContent = `เลือกแล้ว ${selectedImages.length} / 25 รูป`;
      preview.innerHTML = selectedImages.length ? selectedImages.map((image, index) => `<article class="admin-gallery-card"><img src="${image}" alt="ตัวอย่างรูปภาพกิจกรรม ${index + 1}"><div class="admin-gallery-card-bottom"><span>รูปที่ ${index + 1}</span><label>ตำแหน่ง <input class="gallery-position" type="number" min="1" max="${selectedImages.length}" value="${index + 1}" data-image-index="${index}" aria-label="ตำแหน่งของรูปที่ ${index + 1}"></label></div><button type="button" class="gallery-image-delete" data-image-index="${index}" aria-label="ลบรูปที่ ${index + 1}">×</button></article>`).join('') : '<div class="admin-gallery-empty">ยังไม่มีรูปภาพ<br><small>กด “เพิ่มรูปภาพ” เพื่อเริ่มสร้างผนังภาพกิจกรรม</small></div>';
      preview.querySelectorAll('.gallery-image-delete').forEach((button) => button.addEventListener('click', () => { selectedImages.splice(Number(button.dataset.imageIndex), 1); renderPreviews(); syncGallery(); }));
      preview.querySelectorAll('.gallery-position').forEach((input) => input.addEventListener('change', () => { const from = Number(input.dataset.imageIndex); const to = Number(input.value) - 1; if (!Number.isInteger(to) || to < 0 || to >= selectedImages.length) { renderPreviews(); return; } const [image] = selectedImages.splice(from, 1); selectedImages.splice(to, 0, image); renderPreviews(); syncGallery(); }));
    };
    $('#activityPhotos').addEventListener('change', (event) => {
      const files = [...event.target.files];
      event.target.value = '';
      uploadQueue = uploadQueue.then(async () => {
        try {
          if (!imagesOptimized && selectedImages.length) {
            count.textContent = 'กำลังปรับขนาดรูปภาพเดิมเพื่อให้เพิ่มรูปได้มากขึ้น...';
            selectedImages = await Promise.all(selectedImages.map(compressActivityImage));
            imagesOptimized = true;
          }
        } catch (error) { window.alert('ไม่สามารถปรับขนาดรูปภาพเดิมได้ กรุณาลองใหม่อีกครั้ง'); renderPreviews(); return; }
        const remaining = 25 - selectedImages.length;
        if (!remaining) { window.alert('เพิ่มรูปภาพครบ 25 รูปแล้ว กรุณาลบรูปเดิมก่อน'); return; }
        const chosenFiles = files.slice(0, remaining);
        count.textContent = `กำลังเตรียมรูปภาพ ${chosenFiles.length} รูป...`;
        try {
          const newImages = await Promise.all(chosenFiles.map(compressActivityImage));
          selectedImages.push(...newImages);
          renderPreviews();
          syncGallery();
          if (files.length > remaining) window.alert(`เพิ่มได้อีก ${remaining} รูป จึงเลือกเฉพาะ ${remaining} รูปแรก`);
        } catch (error) { window.alert('มีบางรูปที่อ่านไม่ได้ กรุณาลองเลือกไฟล์รูปภาพอีกครั้ง'); renderPreviews(); }
      });
    });
    $('#saveGallery').addEventListener('click', () => { syncGallery(); window.alert('บันทึกการตั้งค่ารูปภาพกิจกรรมแล้ว'); });
    renderPreviews();
    return;
  }
  renderElectionAdmin(host);
}

async function renderCommitteeAdmin(host) {
  host.innerHTML = '<div class="admin-gallery-empty">กำลังโหลดข้อมูลสมาชิก…</div>';
  let members = await getCommitteeMembers();
  host.innerHTML = `<div class="admin-panel member-admin"><div class="member-admin-head"><div><small>MEMBER DIRECTORY</small><h3>จัดการสมาชิกคณะสี</h3><p>แยกข้อมูลแกนนำนักเรียนและคณะครูเป็นหมวดชัดเจน การ์ดที่เผยแพร่จะแสดงบนหน้าสมาชิกทันที</p></div><div class="member-admin-actions"><button type="button" class="mini" data-add-member="student">＋ นักเรียน</button><button type="button" class="mini" data-add-member="teacher">＋ ครู</button></div></div><div class="member-directory-toolbar"><label><span>⌕</span><input id="memberAdminSearch" type="search" placeholder="ค้นหาชื่อ ชื่อเล่น หรือตำแหน่ง…" autocomplete="off"></label><div><span class="student-dot"></span>นักเรียน <b id="studentMemberCount">0</b><span class="teacher-dot"></span>ครู <b id="teacherMemberCount">0</b></div></div><div class="member-editor-list" id="memberEditorList"></div><div class="member-admin-save"><span id="memberSaveStatus">ทั้งหมด ${members.length} การ์ด</span><button type="button" class="primary" id="saveCommitteeMembers">บันทึกและเผยแพร่ →</button></div></div>`;
  const list = $('#memberEditorList');
  const row = (member, index) => `<article class="member-editor-row" data-index="${index}"><label class="member-photo-input">${member.image ? `<img src="${member.image}" alt="">` : '<span>เพิ่มรูป<br><small>JPG / PNG</small></span>'}<input type="file" accept="image/*"></label><div class="member-editor-fields"><div class="member-editor-meta"><span>${member.type === 'teacher' ? 'คณะครู' : 'แกนนำนักเรียน'}</span><label><input class="member-published" type="checkbox" ${member.published !== false ? 'checked' : ''}> แสดงหน้าเว็บ</label></div><div class="two"><div class="field"><label>ชื่อ–นามสกุล</label><input class="member-name" value="${escapeAttribute(member.name || '')}" placeholder="ชื่อจริงและนามสกุล"></div><div class="field"><label>ชื่อเล่น</label><input class="member-nickname" value="${escapeAttribute(member.nickname || '')}" placeholder="เช่น เอ็มเจ"></div></div><div class="two"><div class="field"><label>ตำแหน่ง</label><input class="member-role" list="memberRoleOptions" value="${escapeAttribute(member.role || '')}" placeholder="เลือกหรือพิมพ์ตำแหน่งใหม่"></div><div class="field"><label>ลำดับ</label><input class="member-order" type="number" min="1" value="${member.order || index + 1}"></div></div>${member.type === 'student' ? `<details class="member-contact-editor"><summary>ช่องทางการติดต่อ <span>ข้อมูลเพิ่มเติม</span></summary><div class="member-contact-fields">${MEMBER_CONTACTS.map((contact) => `<div class="field"><label>${contact.label}</label><input class="member-contact" data-contact="${contact.key}" value="${escapeAttribute(member.contacts?.[contact.key] || '')}" placeholder="${contact.hint}"></div>`).join('')}</div><small>กรอกเป็นชื่อผู้ใช้หรือวางลิงก์เต็มก็ได้ ช่องที่เว้นว่างจะไม่แสดงบนหน้าเว็บ</small></details>` : ''}</div><button type="button" class="member-delete" aria-label="ลบการ์ด">×</button></article>`;
  const renderRows = () => { const query = ($('#memberAdminSearch')?.value || '').trim().toLowerCase(); const group = (type, eyebrow, title, description) => { const allOfType = members.map((member, index) => ({ member, index })).filter(({ member }) => member.type === type); const visible = allOfType.filter(({ member }) => !query || [member.name, member.nickname, member.role].some((value) => String(value || '').toLowerCase().includes(query))); return `<section class="member-editor-group is-${type}"><header><div><small>${eyebrow}</small><h4>${title} <span>${allOfType.length}</span></h4><p>${description}</p></div><button type="button" class="mini" data-add-member="${type}">＋ เพิ่ม${type === 'teacher' ? 'ครู' : 'นักเรียน'}</button></header><div class="member-editor-grid">${visible.length ? visible.map(({ member, index }) => row(member, index)).join('') : `<div class="member-group-empty">${query ? 'ไม่พบสมาชิกที่ค้นหาในหมวดนี้' : 'ยังไม่มีข้อมูลในหมวดนี้'}</div>`}</div></section>`; }; list.innerHTML = `<datalist id="memberRoleOptions">${MEMBER_ROLES.map((role) => `<option value="${role}">`).join('')}</datalist>` + group('student', 'STUDENT LEADERS', 'แกนนำนักเรียน', 'สมาชิกฝ่ายนักเรียนและทีมงานคณะสี') + group('teacher', 'TEACHER ADVISORS', 'คณะครู', 'ครูที่ปรึกษาและครูผู้ดูแลคณะสี'); $('#studentMemberCount').textContent = members.filter((member) => member.type === 'student').length; $('#teacherMemberCount').textContent = members.filter((member) => member.type === 'teacher').length; bindRows(); bindAddButtons(); };
  const syncFromRows = () => { list.querySelectorAll('.member-editor-row').forEach((el) => { const item = members[Number(el.dataset.index)]; if (!item) return; item.name = el.querySelector('.member-name').value.trim(); item.nickname = el.querySelector('.member-nickname').value.trim(); item.role = el.querySelector('.member-role').value.trim(); item.order = Number(el.querySelector('.member-order').value) || 1; item.published = el.querySelector('.member-published').checked; if (item.type === 'student') { item.contacts = {}; el.querySelectorAll('.member-contact').forEach((input) => { if (input.value.trim()) item.contacts[input.dataset.contact] = input.value.trim(); }); } }); };
  const bindRows = () => { list.querySelectorAll('.member-editor-row').forEach((el) => { el.querySelector('.member-delete').addEventListener('click', () => { syncFromRows(); members.splice(Number(el.dataset.index),1); renderRows(); }); el.querySelector('input[type=file]').addEventListener('change', (event) => { const file = event.target.files[0]; if (!file) return; const memberIndex = Number(el.dataset.index); const reader = new FileReader(); reader.onload = () => { syncFromRows(); if (!members[memberIndex]) return; openMemberCropStudio(reader.result, (croppedImage) => { if (!members[memberIndex]) return; members[memberIndex].image = croppedImage; renderRows(); }); }; reader.readAsDataURL(file); }); }); };
  const add = (type) => { syncFromRows(); const memberIndex = members.length; members.push({ type, name:'', nickname:'', role:type === 'teacher' ? 'ครูที่ปรึกษาคณะสี' : '', order:members.filter((m) => m.type === type).length + 1, image:'', contacts:{}, published:true }); $('#memberAdminSearch').value = ''; renderRows(); const added = list.querySelector(`[data-index="${memberIndex}"]`); added?.scrollIntoView({behavior:'smooth',block:'center'}); added?.querySelector('.member-name')?.focus({preventScroll:true}); };
  const bindAddButtons = () => { host.querySelectorAll('[data-add-member]').forEach((button) => { button.onclick = () => add(button.dataset.addMember); }); };
  $('#memberAdminSearch').addEventListener('input', () => { syncFromRows(); renderRows(); });
  $('#saveCommitteeMembers').addEventListener('click', async () => { syncFromRows(); const button = $('#saveCommitteeMembers'); button.disabled = true; $('#memberSaveStatus').textContent = 'กำลังบันทึก…'; try { await setCommitteeMembers(members); localStorage.setItem(COMMITTEE_KEY, JSON.stringify(members)); renderCommitteeMembers(true); $('#memberSaveStatus').textContent = `บันทึกแล้ว ${members.length} การ์ด`; } catch (_) { $('#memberSaveStatus').textContent = 'บันทึกไม่สำเร็จ'; window.alert('ไม่สามารถบันทึกรูปภาพได้ กรุณาตรวจสอบพื้นที่ว่างของอุปกรณ์'); } finally { button.disabled = false; } });
  renderRows();
}
function renderElectionAdmin(host) {
  const config = getElectionConfig();
  const students = getElectionStudents();
  const votes = getVotes();
  const eligible = students.filter((student) => isStudentEligible(student, config));
  const electionTeachers = teacherAccountsForRooms(config.rooms);
  host.innerHTML = `<div class="admin-panel election-admin">
    <div class="election-admin-head"><div><small>ELECTION COMMAND CENTER</small><h3>ควบคุมการเลือกตั้ง</h3><p>การตั้งค่าทั้งหมดด้านล่างเชื่อมกับหน้าลงทะเบียน บัตรเลือกตั้ง และหน้าประกาศผลโดยตรง</p></div><label class="election-switch"><input id="electionEnabled" type="checkbox" ${config.enabled ? 'checked' : ''}><span></span><b>${config.enabled ? 'เปิดระบบ' : 'ปิดระบบ'}</b></label></div>
    <div class="admin-election-stats"><div><b>${eligible.length}</b><span>ผู้มีสิทธิ์</span></div><div><b>${votes.length}</b><span>ใช้สิทธิ์แล้ว</span></div><div><b>${config.candidates.length}</b><span>ผู้สมัคร</span></div><div><b>${config.rooms.length}</b><span>ห้องที่เปิดสิทธิ์</span></div></div>
    <section class="admin-config-section election-advisor-directory"><div class="config-index">✦</div><div class="config-body"><h4>ครูที่ปรึกษาห้องที่เปิดสิทธิ์</h4><p>ข้อมูลครูถูกเชื่อมกับห้องที่เลือกในระบบเลือกตั้งโดยอัตโนมัติ</p><div class="check-grid">${electionTeachers.length ? electionTeachers.map((teacher) => `<div class="admin-teacher-chip"><b>${escapeHTML(teacher.name)}</b><small>ม.${escapeHTML(teacher.room)} · ${escapeHTML(teacher.username)}</small></div>`).join('') : '<small>ยังไม่มีครูที่ปรึกษาของห้องที่เลือกในฐานข้อมูล</small>'}</div></div></section>
    <section class="admin-config-section"><div class="config-index">01</div><div class="config-body"><h4>กำหนดผู้มีสิทธิ์เลือกตั้ง</h4><p>เลือกช่วงชั้นและห้อง ระบบจะตรวจสอบกับฐานรายชื่อนักเรียนก่อนอนุญาตให้ลงทะเบียน</p><div class="eligibility-groups"><div><b>ระดับชั้น</b><div class="check-grid">${[1,2,3,4,5,6].map((grade) => `<label><input class="eligible-grade" type="checkbox" value="${grade}" ${config.grades.includes(grade) ? 'checked' : ''}> ม.${grade}</label>`).join('')}</div></div><div><b>ห้องเรียนที่อนุญาต</b><div class="check-grid">${Object.entries(ORDER_ROOM_DATABASE).map(([room, roomStudents]) => `<label><input class="eligible-room" type="checkbox" value="${room}" ${config.rooms.includes(room) ? 'checked' : ''}> ม.${room} <small>(${roomStudents.length} คน)</small></label>`).join('')}</div><small>ฐานข้อมูลห้องเรียนเชื่อมกับระบบสมาชิกและการเข้าสู่ระบบโดยอัตโนมัติ</small></div></div><details class="student-permission"><summary>กำหนดสิทธิ์รายบุคคล (${config.studentOverrides.length} รายการยกเว้น)</summary><div class="student-permission-list">${students.map((student) => { const override = config.studentOverrides.find((item) => item.studentId === student.studentId); return `<label><span>ม.${student.room} · ${student.number}. ${escapeHTML(student.name)} <small>${student.studentId}</small></span><select class="student-override" data-student-id="${student.studentId}"><option value="" ${!override ? 'selected' : ''}>ตามสิทธิ์ระดับชั้น/ห้อง</option><option value="allow" ${override?.allowed === true ? 'selected' : ''}>อนุญาตเป็นกรณีพิเศษ</option><option value="deny" ${override?.allowed === false ? 'selected' : ''}>ไม่อนุญาต</option></select></label>`; }).join('')}</div></details></div></section>
    <section class="admin-config-section"><div class="config-index">02</div><div class="config-body"><h4>ผู้สมัครและข้อมูลแนะนำตัว</h4><p>เพิ่มผู้สมัคร กำหนดหมายเลข ชื่อ วิสัยทัศน์ และภาพที่จะแสดงในหน้าแนะนำและหน้าผลคะแนน</p><div id="candidateEditor">${config.candidates.map((candidate, index) => adminCandidateRow(candidate, index)).join('')}</div><button type="button" class="mini" id="addCandidate">＋ เพิ่มผู้สมัคร</button></div></section>
    <section class="admin-config-section"><div class="config-index">03</div><div class="config-body"><h4>เปิดหีบ ปิดหีบ และประกาศผล</h4><div class="two"><div class="field"><label>วันและเวลาเปิดหีบ</label><input id="electionOpen" type="datetime-local" value="${config.open || ''}"></div><div class="field"><label>วันและเวลาปิดหีบ</label><input id="electionClose" type="datetime-local" value="${config.close || ''}"></div></div><div class="field"><label>ประกาศผลหลังปิดหีบ (นาที)</label><input id="electionCountMinutes" type="number" min="0" value="${config.countMinutes}"></div><div class="result-time-preview">เวลาประกาศผล: <b id="resultTimePreview">${config.close ? formatThaiDate(getResultTime(config)) : 'กรุณากำหนดเวลาปิดหีบ'}</b></div></div></section>
    <section class="admin-config-section reset-election-section"><div class="config-index">04</div><div class="config-body"><h4>เริ่มรอบเลือกตั้งใหม่</h4><p>ล้างคะแนนและสถานะใช้สิทธิ์ของรอบปัจจุบัน โดยคงรายชื่อผู้สมัคร สี สิทธิ์ และกำหนดการทั้งหมดไว้</p><div class="reset-election-box"><div class="reset-oracle"><span>↻</span><div><b>รีเซ็ตผลการเลือกตั้ง</b><small>คะแนนปัจจุบัน ${votes.length} เสียง · รอบ ${escapeHTML(String(config.electionId).slice(-12))}</small></div></div><button type="button" id="openElectionReset">รีเซ็ตคะแนนและเริ่มรอบใหม่</button></div></div></section>
    <div class="election-admin-save"><div><b>ตรวจสอบก่อนเปิดระบบ</b><span id="electionAdminMessage">การเปลี่ยนแปลงจะมีผลเมื่อกดบันทึก</span></div><button class="primary" id="saveElectionConfig">บันทึกและใช้การตั้งค่า →</button></div>
    <dialog class="election-reset-dialog" id="electionResetDialog"><div class="reset-dialog-sigil">☾</div><small>NEW ELECTION CYCLE</small><h3>ยืนยันการเริ่มรอบใหม่</h3><p>คะแนนทั้ง <b>${votes.length} เสียง</b> จะถูกล้าง สถานะใช้สิทธิ์ที่ค้างจากรอบเก่าจะไม่ถูกนำมาใช้ในรอบใหม่</p><label>พิมพ์คำว่า <b>รีเซ็ต</b> เพื่อยืนยัน<input id="resetConfirmText" autocomplete="off" placeholder="รีเซ็ต"></label><div><button type="button" class="mini" id="cancelElectionReset">ยกเลิก</button><button type="button" class="confirm-election-reset" id="confirmElectionReset" disabled>เริ่มรอบใหม่</button></div></dialog>
  </div>`;
  const refreshPreview = () => { const close = $('#electionClose').value; const minutes = Number($('#electionCountMinutes').value) || 0; $('#resultTimePreview').textContent = close ? formatThaiDate(new Date(close).getTime() + minutes * 60000) : 'กรุณากำหนดเวลาปิดหีบ'; };
  $('#electionClose').addEventListener('input', refreshPreview);
  $('#electionCountMinutes').addEventListener('input', refreshPreview);
  $('#electionEnabled').addEventListener('change', (event) => { event.target.closest('label').querySelector('b').textContent = event.target.checked ? 'เปิดระบบ' : 'ปิดระบบ'; });
  $('#addCandidate').addEventListener('click', () => { const editor = $('#candidateEditor'); const index = editor.children.length; editor.insertAdjacentHTML('beforeend', adminCandidateRow({ number: index + 1, name: '', vision: '', image: '' }, index)); bindCandidateEditorRow(editor.lastElementChild); });
  document.querySelectorAll('.candidate-editor-row').forEach(bindCandidateEditorRow);
  $('#saveElectionConfig').addEventListener('click', saveElectionAdmin);
  const resetDialog = $('#electionResetDialog');
  $('#openElectionReset').addEventListener('click', () => resetDialog.showModal());
  $('#cancelElectionReset').addEventListener('click', () => resetDialog.close());
  $('#resetConfirmText').addEventListener('input', (event) => { $('#confirmElectionReset').disabled = event.target.value.trim() !== 'รีเซ็ต'; });
  $('#confirmElectionReset').addEventListener('click', resetElectionCycle);
}
function adminCandidateRow(candidate, index) {
  const introX = candidate.introImageX ?? candidate.imageX ?? 50, introY = candidate.introImageY ?? candidate.imageY ?? 50, introZoom = candidate.introImageZoom ?? candidate.imageZoom ?? 1;
  const resultX = candidate.resultImageX ?? candidate.imageX ?? 50, resultY = candidate.resultImageY ?? candidate.imageY ?? 50, resultZoom = candidate.resultImageZoom ?? candidate.imageZoom ?? 1;
  return `<div class="candidate-editor-row" data-index="${index}"><div class="candidate-editor-photo">${candidate.image ? `<img src="${candidate.image}" style="${candidateImageStyle(candidate, 'intro')}" alt="">` : '<span>เพิ่มรูป</span>'}<input class="candidate-image" type="file" accept="image/*" aria-label="รูปผู้สมัคร"></div><div class="candidate-editor-fields"><div class="candidate-editor-main"><div class="field"><label>หมายเลข</label><input class="candidate-number-input" type="number" min="1" value="${escapeHTML(candidate.number)}"></div><div class="field"><label>ชื่อ–นามสกุล</label><input class="candidate-name-input" value="${escapeHTML(candidate.name)}" placeholder="ชื่อผู้สมัคร"></div><div class="field candidate-color-field"><label>สีประจำผู้สมัคร</label><div><input class="candidate-color-input" type="color" value="${candidate.color || '#d6a84f'}"><span>${candidate.color || '#d6a84f'}</span></div></div></div><div class="field"><label>วิสัยทัศน์ / คำแนะนำตัว</label><textarea class="candidate-vision-input" rows="2" placeholder="แนวคิดที่อยากสื่อกับผู้มีสิทธิ์">${escapeHTML(candidate.vision)}</textarea></div><div class="candidate-crop-launch"><div><b>จัดภาพให้ตรงกับหน้าจริง</b><small>จัดกรอบหน้าแนะนำและไพ่ประกาศผลแยกกัน</small></div><button class="open-crop-studio" type="button">✦ เปิด Crop Studio</button></div><input class="intro-image-x" type="hidden" value="${introX}"><input class="intro-image-y" type="hidden" value="${introY}"><input class="intro-image-zoom" type="hidden" value="${introZoom}"><input class="result-image-x" type="hidden" value="${resultX}"><input class="result-image-y" type="hidden" value="${resultY}"><input class="result-image-zoom" type="hidden" value="${resultZoom}"><input class="candidate-image-data" type="hidden" value="${candidate.image || ''}"></div><button class="candidate-remove" type="button" aria-label="ลบผู้สมัคร">×</button></div>`;
}
function bindCandidateEditorRow(row) {
  row.querySelector('.candidate-remove').addEventListener('click', () => row.remove());
  row.querySelector('.candidate-color-input').addEventListener('input', (event) => { event.target.nextElementSibling.textContent = event.target.value; });
  row.querySelector('.open-crop-studio').addEventListener('click', () => openCandidateCropStudio(row));
  row.querySelector('.candidate-editor-photo').addEventListener('click', () => row.querySelector('.candidate-image').click());
  row.querySelector('.candidate-image').addEventListener('change', (event) => {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { row.querySelector('.candidate-image-data').value = reader.result; const x = row.querySelector('.intro-image-x').value, y = row.querySelector('.intro-image-y').value, zoom = row.querySelector('.intro-image-zoom').value; row.querySelector('.candidate-editor-photo').innerHTML = `<img src="${reader.result}" style="object-position:${x}% ${y}%;transform:scale(${zoom})" alt=""><input class="candidate-image" type="file" accept="image/*" aria-label="รูปผู้สมัคร"><input class="candidate-image-data" type="hidden" value="${reader.result}">`; bindCandidateEditorRowImage(row); };
    reader.readAsDataURL(file);
  });
}
function openCandidateCropStudio(row) {
  const imageSource = row.querySelector('.candidate-image-data').value;
  if (!imageSource) { window.alert('กรุณาเพิ่มรูปผู้สมัครก่อนเปิด Crop Studio'); row.querySelector('.candidate-image').click(); return; }
  const name = row.querySelector('.candidate-name-input').value.trim() || 'ผู้สมัคร';
  const number = row.querySelector('.candidate-number-input').value || '-';
  const readState = (prefix) => ({ x: Number(row.querySelector(`.${prefix}-image-x`).value), y: Number(row.querySelector(`.${prefix}-image-y`).value), zoom: Number(row.querySelector(`.${prefix}-image-zoom`).value) });
  const state = { intro: readState('intro'), result: readState('result') };
  const dialog = document.createElement('dialog');
  dialog.className = 'candidate-crop-studio';
  dialog.innerHTML = `<header><div><small>LIVE FRAME EDITOR</small><h3>จัดภาพผู้สมัครให้ตรงกับหน้าจริง</h3><p>ลากภาพในแต่ละกรอบโดยตรง และซูมแยกกันได้</p></div><button type="button" data-crop-close aria-label="ปิด">×</button></header><div class="crop-studio-grid"><section><div class="crop-preview-label"><b>หน้าแนะนำผู้สมัคร</b><span>กรอบทรงโค้งที่ผู้ใช้จะเห็นจริง</span></div><div class="crop-intro-mock"><div class="crop-intro-frame crop-drag-frame" data-crop-context="intro"><img src="${imageSource}" alt=""></div><small>ผู้สมัครหมายเลข ${escapeHTML(number)}</small><h4>${escapeHTML(name)}</h4></div><label class="crop-zoom-control">ซูมภาพ <output data-crop-output="intro"></output><input type="range" min="1" max="2.5" step="0.05" value="${state.intro.zoom}" data-crop-zoom="intro"></label><button class="crop-reset" type="button" data-crop-reset="intro">คืนค่ากึ่งกลาง</button></section><section><div class="crop-preview-label"><b>ไพ่ประกาศผล</b><span>กรอบแนวตั้งบนไพ่ผลคะแนนจริง</span></div><div class="crop-result-card"><div class="crop-card-rank">THE CHOSEN ONE</div><div class="crop-result-frame crop-drag-frame" data-crop-context="result"><img src="${imageSource}" alt=""><b>หมายเลข ${escapeHTML(number)}</b></div><h4>${escapeHTML(name)}</h4><strong>99 <small>คะแนน</small></strong></div><label class="crop-zoom-control">ซูมภาพ <output data-crop-output="result"></output><input type="range" min="1" max="2.5" step="0.05" value="${state.result.zoom}" data-crop-zoom="result"></label><button class="crop-reset" type="button" data-crop-reset="result">คืนค่ากึ่งกลาง</button></section></div><footer><span>☝ ลากรูปภายในกรอบเพื่อจัดตำแหน่ง</span><div><button class="mini" type="button" data-crop-cancel>ยกเลิก</button><button class="save-crop-studio" type="button">บันทึกตำแหน่งภาพ</button></div></footer>`;
  document.body.appendChild(dialog);
  const renderPreview = (context) => { const image = dialog.querySelector(`[data-crop-context="${context}"] img`); const output = dialog.querySelector(`[data-crop-output="${context}"]`); image.style.objectPosition = `${state[context].x}% ${state[context].y}%`; image.style.transform = `scale(${state[context].zoom})`; output.textContent = `${state[context].zoom.toFixed(2)}×`; };
  ['intro', 'result'].forEach((context) => {
    renderPreview(context);
    dialog.querySelector(`[data-crop-zoom="${context}"]`).addEventListener('input', (event) => { state[context].zoom = Number(event.target.value); renderPreview(context); });
    dialog.querySelector(`[data-crop-reset="${context}"]`).addEventListener('click', () => { state[context] = { x: 50, y: 50, zoom: 1 }; dialog.querySelector(`[data-crop-zoom="${context}"]`).value = 1; renderPreview(context); });
    const frame = dialog.querySelector(`[data-crop-context="${context}"]`); let drag = null;
    frame.addEventListener('pointerdown', (event) => { drag = { x: event.clientX, y: event.clientY, startX: state[context].x, startY: state[context].y }; frame.setPointerCapture(event.pointerId); frame.classList.add('dragging'); });
    frame.addEventListener('pointermove', (event) => { if (!drag) return; const box = frame.getBoundingClientRect(); state[context].x = Math.min(100, Math.max(0, drag.startX - (event.clientX - drag.x) / box.width * 100)); state[context].y = Math.min(100, Math.max(0, drag.startY - (event.clientY - drag.y) / box.height * 100)); renderPreview(context); });
    const stopDrag = () => { drag = null; frame.classList.remove('dragging'); };
    frame.addEventListener('pointerup', stopDrag); frame.addEventListener('pointercancel', stopDrag);
  });
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector('[data-crop-close]').addEventListener('click', close); dialog.querySelector('[data-crop-cancel]').addEventListener('click', close);
  dialog.querySelector('.save-crop-studio').addEventListener('click', () => { ['intro','result'].forEach((context) => { row.querySelector(`.${context}-image-x`).value = state[context].x.toFixed(2); row.querySelector(`.${context}-image-y`).value = state[context].y.toFixed(2); row.querySelector(`.${context}-image-zoom`).value = state[context].zoom.toFixed(2); }); const preview = row.querySelector('.candidate-editor-photo img'); if (preview) { preview.style.objectPosition = `${state.intro.x}% ${state.intro.y}%`; preview.style.transform = `scale(${state.intro.zoom})`; } const message = $('#electionAdminMessage'); if (message) message.textContent = 'รับตำแหน่งภาพแล้ว · กด “บันทึกและใช้การตั้งค่า” ด้านล่างเพื่อเผยแพร่'; close(); });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();
}
function bindCandidateEditorRowImage(row) {
  const photo = row.querySelector('.candidate-editor-photo');
  photo.onclick = () => row.querySelector('.candidate-image').click();
  row.querySelector('.candidate-image').addEventListener('change', (event) => {
    const file = event.target.files[0]; if (!file) return; const reader = new FileReader();
    reader.onload = () => { row.querySelector('img').src = reader.result; row.querySelector('.candidate-image-data').value = reader.result; }; reader.readAsDataURL(file);
  });
}
function saveElectionAdmin() {
  const candidates = [...document.querySelectorAll('.candidate-editor-row')].map((row) => ({ number: row.querySelector('.candidate-number-input').value.trim(), name: row.querySelector('.candidate-name-input').value.trim(), vision: row.querySelector('.candidate-vision-input').value.trim(), image: row.querySelector('.candidate-image-data').value, introImageX: Number(row.querySelector('.intro-image-x').value), introImageY: Number(row.querySelector('.intro-image-y').value), introImageZoom: Number(row.querySelector('.intro-image-zoom').value), resultImageX: Number(row.querySelector('.result-image-x').value), resultImageY: Number(row.querySelector('.result-image-y').value), resultImageZoom: Number(row.querySelector('.result-image-zoom').value), color: row.querySelector('.candidate-color-input').value })).filter((candidate) => candidate.number || candidate.name);
  const config = { electionId: getElectionConfig().electionId, enabled: $('#electionEnabled').checked, open: $('#electionOpen').value, close: $('#electionClose').value, countMinutes: Math.max(0, Number($('#electionCountMinutes').value) || 0), grades: [...document.querySelectorAll('.eligible-grade:checked')].map((input) => Number(input.value)), rooms: [...document.querySelectorAll('.eligible-room:checked')].map((input) => input.value), studentOverrides: [...document.querySelectorAll('.student-override')].filter((select) => select.value).map((select) => ({ studentId: select.dataset.studentId, allowed: select.value === 'allow' })), candidates };
  const message = $('#electionAdminMessage');
  if (config.enabled && (!config.open || !config.close || new Date(config.close) <= new Date(config.open) || !candidates.length || candidates.some((candidate) => !candidate.number || !candidate.name) || new Set(candidates.map((candidate) => candidate.number)).size !== candidates.length)) { message.textContent = 'เปิดระบบไม่ได้: ตรวจเวลา ผู้สมัคร และหมายเลขไม่ให้ซ้ำกัน'; message.classList.add('error'); return; }
  try { localStorage.setItem('phanuang-election-config', JSON.stringify(config)); message.textContent = 'บันทึกแล้ว การตั้งค่าถูกเชื่อมไปยังหน้าผู้ใช้ทันที'; message.classList.remove('error'); } catch (error) { message.textContent = 'บันทึกไม่สำเร็จ รูปภาพอาจมีขนาดใหญ่เกินพื้นที่จัดเก็บ'; message.classList.add('error'); }
}
function resetElectionCycle() {
  const config = getElectionConfig();
  config.electionId = `election-${Date.now()}`;
  localStorage.setItem('phanuang-election-config', JSON.stringify(config));
  localStorage.removeItem('phanuang-election-votes');
  localStorage.removeItem('phanuang-vote');
  sessionStorage.removeItem('phanuang-election-student');
  selectedCandidate = null;
  $('#electionResetDialog').close();
  renderElectionAdmin($('#adminPanel'));
  window.setTimeout(() => { const message = $('#electionAdminMessage'); if (message) message.textContent = 'เริ่มรอบเลือกตั้งใหม่แล้ว สถานะและคะแนนจากรอบเก่าถูกยกเลิกเรียบร้อย'; }, 0);
}
function saveAttendanceSession() {
  const date = $('#attendanceDate').value;
  const clock = $('#attendanceStartClock').value;
  const duration = Math.max(5, Number($('#attendanceDuration').value) || 15);
  const round = Number($('#attendanceRound').value);
  const time = date && clock ? `${date}T${clock}` : '';
  const closeDate = new Date(time);
  closeDate.setMinutes(closeDate.getMinutes() + duration);
  const close = Number.isNaN(closeDate.getTime()) ? '' : new Date(closeDate.getTime() - closeDate.getTimezoneOffset()*60000).toISOString().slice(0,16);
  const openMs = new Date(time).getTime(), closeMs = new Date(close).getTime();
  if (!Number.isInteger(round) || round < 1) { window.alert('กรุณาระบุหมายเลขรอบเป็นจำนวนเต็ม ตั้งแต่ 1 ขึ้นไป'); return; }
  if (!time || !close || !Number.isFinite(openMs) || !Number.isFinite(closeMs) || closeMs <= openMs) { window.alert('กรุณากำหนดเวลาเริ่มและสิ้นสุดให้ถูกต้อง โดยเวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม'); return; }
  const sessions = getAttendanceSessions();
  if (sessions.some((item) => item.round === round && item.time?.slice(0,10) === date)) { window.alert(`วันที่เลือกมีรอบที่ ${round} อยู่แล้ว กรุณาเลือกรอบอื่น`); return; }
  const session = { id:`attendance-${Date.now()}`, sessionId:'', round, time, close, duration, createdAt:new Date().toISOString() };
  session.sessionId = session.id;
  sessions.unshift(session);
  localStorage.setItem(ATTENDANCE_SESSIONS_KEY, JSON.stringify(sessions));
  localStorage.setItem('phanuang-attendance-config', JSON.stringify(session));
  attendanceViewingSessionId = session.id;
  renderAdminPanel('attendance');
  showAdminToast(`ตั้งเวลารอบที่ ${round} สำเร็จ`, `ระบบจะเปิดรับเช็คชื่ออัตโนมัติ ${formatThaiDate(openMs)}`);
}
function renderAttendanceHistory(host) {
  const sessions = getAttendanceSessions();
  if (!sessions.length) { host.innerHTML = `<div class="admin-panel attendance-history-empty"><span>◴</span><h3>ยังไม่มีประวัติเช็คชื่อ</h3><p>เมื่อสร้างรอบเช็คชื่อแล้ว รายงานสรุปจะปรากฏที่แท็บนี้อัตโนมัติ</p><button class="primary" id="backToAttendance">ไปตั้งรอบเช็คชื่อ →</button></div>`; $('#backToAttendance').addEventListener('click', () => document.querySelector('[data-admin-tab="attendance"]').click()); return; }
  const selectedId = attendanceViewingSessionId && sessions.some((session) => session.id === attendanceViewingSessionId) ? attendanceViewingSessionId : sessions[0].id;
  attendanceViewingSessionId = selectedId;
  const session = sessions.find((item) => item.id === selectedId);
  const attendance = getAttendance(selectedId);
  const presentSeats = seatCodes.filter((seat) => attendance[seat]);
  const absentSeats = seatCodes.filter((seat) => !attendance[seat]);
  const percentage = Math.round(presentSeats.length / seatCodes.length * 100);
  host.innerHTML = `<div class="admin-panel attendance-history-panel"><div class="history-panel-head"><div><small>ATTENDANCE ARCHIVE · 02</small><h3>ประวัติการเช็คชื่อ</h3><p>ตรวจสอบผลแต่ละรอบและพิมพ์รายงานแผนผังฉบับสมบูรณ์</p></div><button class="primary print-attendance" id="printAttendanceReport">▣ พิมพ์รายงาน</button></div><div class="history-session-bar"><label>เลือกรอบที่ต้องการดู</label><select id="historySessionSelect">${sessions.map((item) => `<option value="${item.id}" ${item.id === selectedId ? 'selected' : ''}>${formatAttendanceSession(item)}</option>`).join('')}</select></div><article class="attendance-print-report" id="attendancePrintReport"><header class="print-report-header"><div><small>PHUNRUEANG · ATTENDANCE REPORT</small><h2>รายงานสรุปการเช็คชื่อขึ้นแสตนด์</h2><p>${formatAttendanceSession(session)}</p></div><div class="print-report-mark">PR<small>STAFF CONTROL</small></div></header><div class="history-stats"><div class="history-stat total"><span>ที่นั่งทั้งหมด</span><b>${seatCodes.length}</b><small>ที่นั่ง</small></div><div class="history-stat present"><span>มาแล้ว</span><b>${presentSeats.length}</b><small>${percentage}% ของทั้งหมด</small></div><div class="history-stat absent"><span>ยังไม่มา</span><b>${absentSeats.length}</b><small>${100-percentage}% ของทั้งหมด</small></div><div class="history-stat time"><span>ช่วงเวลา</span><b>${new Date(session.time).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})}</b><small>ถึง ${new Date(session.close).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})} น.</small></div></div><section class="history-map-section"><div class="history-section-title"><div><small>GRANDSTAND MAP</small><h4>แผนผังสรุปการมา</h4></div><div class="history-legend"><span><i class="present"></i> มาแล้ว</span><span><i></i> ไม่มา</span></div></div><div class="history-seat-map">${seatCodes.map((seat) => `<div class="history-seat ${attendance[seat] ? 'present' : 'absent'}"><b>${seat}</b>${attendance[seat] ? `<small>${new Date(attendance[seat].time).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})}</small>` : '<small>—</small>'}</div>`).join('')}</div></section><div class="history-lists"><section class="history-seat-list present-list"><div><i></i><h4>ที่นั่งที่มาแล้ว</h4><b>${presentSeats.length} คน</b></div><p>${presentSeats.length ? presentSeats.map((seat) => `<span>${seat}</span>`).join('') : '<em>ยังไม่มีผู้เช็คชื่อ</em>'}</p></section><section class="history-seat-list absent-list"><div><i></i><h4>ที่นั่งที่ยังไม่มา</h4><b>${absentSeats.length} คน</b></div><p>${absentSeats.map((seat) => `<span>${seat}</span>`).join('')}</p></section></div><footer class="print-report-footer"><span>พิมพ์จากระบบ PHUNRUEANG STAFF CONTROL</span><span>วันที่พิมพ์ ${new Date().toLocaleString('th-TH',{dateStyle:'long',timeStyle:'short'})}</span></footer></article></div>`;
  const historyActions = document.createElement('div'); historyActions.className = 'history-danger-actions'; historyActions.innerHTML = `<button type="button" id="deleteAttendanceSession">ลบรอบนี้</button><button type="button" id="resetAttendanceHistory">รีเซ็ตประวัติทั้งหมด</button>`; $('.history-session-bar').appendChild(historyActions);
  $('#historySessionSelect').addEventListener('change', (event) => { attendanceViewingSessionId = event.target.value; renderAttendanceHistory(host); });
  $('#printAttendanceReport').addEventListener('click', printAttendanceReport);
  $('#deleteAttendanceSession').addEventListener('click', () => deleteAttendanceSession(selectedId, host));
  $('#resetAttendanceHistory').addEventListener('click', () => resetAllAttendanceHistory(host));
}
function printAttendanceReport() {
  const report = $('#attendancePrintReport'); if (!report) return;
  const printWindow = window.open('', '_blank', 'width=1280,height=820');
  if (!printWindow) { window.alert('เบราว์เซอร์บล็อกหน้าต่างพิมพ์ กรุณาอนุญาต Pop-up สำหรับเว็บไซต์นี้'); return; }
  printWindow.document.open();
  printWindow.document.write(`<!doctype html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>รายงานประวัติการเช็คชื่อ</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Kanit:wght@400;500;600;700;800&display=swap" rel="stylesheet"><link rel="stylesheet" href="${new URL('admin.css', window.location.href).href}"><style>html,body{margin:0!important;background:#fff!important;font-family:Kanit,sans-serif}.print-sheet-shell{padding:0}.attendance-print-report{display:block!important}</style></head><body class="attendance-print-window"><main class="print-sheet-shell">${report.outerHTML}</main></body></html>`);
  printWindow.document.close();
  printWindow.addEventListener('load', () => window.setTimeout(() => { printWindow.focus(); printWindow.print(); }, 450), { once:true });
}
function deleteAttendanceSession(sessionId, host) {
  const session = getAttendanceSessions().find((item) => item.id === sessionId); if (!session) return;
  if (!window.confirm(`ยืนยันลบ ${formatAttendanceSession(session)} พร้อมผลเช็คชื่อทั้งหมดของรอบนี้หรือไม่?`)) return;
  const sessions = getAttendanceSessions().filter((item) => item.id !== sessionId);
  const records = getAttendanceRecords(); delete records[sessionId];
  localStorage.setItem(ATTENDANCE_SESSIONS_KEY, JSON.stringify(sessions)); localStorage.setItem(ATTENDANCE_RECORDS_KEY, JSON.stringify(records));
  const config = getAttendanceConfig(); if ((config.sessionId || config.id) === sessionId) localStorage.removeItem('phanuang-attendance-config');
  attendanceViewingSessionId = sessions[0]?.id || '';
  renderAttendanceHistory(host); showAdminToast('ลบรอบเช็คชื่อแล้ว', 'ข้อมูลและผลเช็คชื่อของรอบที่เลือกถูกลบเรียบร้อย');
}
function resetAllAttendanceHistory(host) {
  if (!window.confirm('ยืนยันรีเซ็ตรอบและประวัติการเช็คชื่อทั้งหมดหรือไม่? การดำเนินการนี้ไม่สามารถย้อนกลับได้')) return;
  ['phanuang-attendance','phanuang-attendance-config',ATTENDANCE_SESSIONS_KEY,ATTENDANCE_RECORDS_KEY].forEach((key) => localStorage.removeItem(key));
  attendanceViewingSessionId = ''; window.clearInterval(attendanceStatusTimer); renderAttendanceHistory(host); showAdminToast('รีเซ็ตระบบเช็คชื่อแล้ว', 'รอบ เวลา ผลเช็คชื่อ และประวัติทั้งหมดถูกล้างแล้ว');
}
function updateAttendanceSchedulePreview() {
  const preview = $('#attendanceSchedulePreview'); if (!preview) return;
  const date = $('#attendanceDate').value, clock = $('#attendanceStartClock').value, duration = Number($('#attendanceDuration').value) || 15, round = Number($('#attendanceRound')?.value) || 1;
  const start = new Date(`${date}T${clock}`);
  if (!date || !clock || Number.isNaN(start.getTime())) { preview.textContent = 'เลือกวันที่และเวลาเริ่ม เพื่อดูตัวอย่างรอบ'; return; }
  const close = new Date(start.getTime() + duration*60000);
  preview.innerHTML = `<span>✦ รอบที่ ${round} จะเปิด</span><b>${formatThaiDate(start)}</b><i>→</i><b>ปิด ${close.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})} น.</b>`;
}
function enhanceAttendanceRoundPicker(config, sessions) {
  const durationField = $('#attendanceDuration')?.closest('.field'); if (!durationField || $('#attendanceRound')) return;
  const selectedDate = $('#attendanceDate').value;
  const usedRounds = sessions.filter((session) => session.time?.slice(0,10) === selectedDate).map((session) => session.round);
  const suggestedRound = Math.max(0,...usedRounds.map(Number).filter(Number.isFinite)) + 1;
  const field = document.createElement('div'); field.className = 'field schedule-round';
  field.innerHTML = `<label>รอบเช็คชื่อ</label><div class="unlimited-round-input"><span>รอบที่</span><input id="attendanceRound" type="number" min="1" step="1" value="${suggestedRound}" aria-label="หมายเลขรอบเช็คชื่อ"></div><small id="attendanceRoundHint">กำหนดได้ไม่จำกัดจำนวนรอบ</small>`;
  durationField.parentNode.insertBefore(field, durationField);
  const refreshRounds = () => {
    const date = $('#attendanceDate').value;
    const unavailable = sessions.filter((session) => session.time?.slice(0,10) === date).map((session) => session.round);
    const input = $('#attendanceRound');
    const nextRound = Math.max(0,...unavailable.map(Number).filter(Number.isFinite)) + 1;
    input.value = nextRound;
    $('#attendanceRoundHint').textContent = unavailable.length ? `วันที่นี้มี ${unavailable.length} รอบแล้ว · แนะนำรอบที่ ${nextRound}` : 'วันนี้ยังไม่มีรอบ · เริ่มที่รอบ 1';
    updateAttendanceSchedulePreview();
  };
  $('#attendanceDate').addEventListener('change', refreshRounds);
  refreshRounds();
}
function enhanceAttendancePickers() {
  [{ id:'attendanceDate', icon:'▦', label:'เลือกจากปฏิทิน' }, { id:'attendanceStartClock', icon:'◷', label:'เลือกจากนาฬิกา' }].forEach(({ id, icon, label }) => {
    const input = $(`#${id}`); if (!input || input.parentElement.classList.contains('date-time-picker')) return;
    if (id === 'attendanceStartClock') input.step = 300;
    const wrap = document.createElement('div'); wrap.className = 'date-time-picker';
    input.parentNode.insertBefore(wrap, input); wrap.appendChild(input);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'picker-trigger'; button.setAttribute('aria-label', label); button.innerHTML = `<span>${icon}</span><small>${label}</small>`; wrap.appendChild(button);
    const openPicker = () => { try { input.showPicker(); } catch (_) { input.focus(); input.click(); } };
    button.addEventListener('click', openPicker);
    wrap.addEventListener('click', (event) => { if (event.target === wrap) openPicker(); });
  });
}
function updateAttendanceLiveStatus() {
  const box = document.querySelector('.attendance-status'); if (!box) { window.clearInterval(attendanceStatusTimer); return; }
  const status = getAttendanceWindowStatus();
  box.className = `attendance-status state-${status.state}`;
  const titles = { open:'เปิดรับเช็คชื่ออยู่', waiting:'ตั้งเวลาแล้ว · รอเปิดอัตโนมัติ', ended:'รอบเช็คชื่อสิ้นสุดแล้ว', unset:'ยังไม่ได้ตั้งรอบเช็คชื่อ' };
  $('#attendanceStatusTitle').textContent = titles[status.state];
  $('#attendanceStatusMessage').textContent = status.message;
  const countdown = $('#attendanceStatusCountdown');
  if (status.remaining > 0) { const total = Math.ceil(status.remaining/1000), hours = Math.floor(total/3600), minutes = Math.floor(total%3600/60), seconds = total%60; countdown.textContent = `${hours ? `${hours}:` : ''}${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`; } else countdown.textContent = '';
}
function showAdminToast(title, message) {
  document.querySelector('.admin-toast')?.remove();
  const toast = document.createElement('div'); toast.className = 'admin-toast'; toast.innerHTML = `<i>✓</i><div><b>${title}</b><span>${message}</span></div>`; document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  window.setTimeout(() => { toast.classList.remove('show'); window.setTimeout(() => toast.remove(),350); }, 4200);
}
function extractSeatCode(value) { const match = String(value || '').toUpperCase().match(/(?:^|[^A-Z])(A(?:1[0-8]|[1-9])|B(?:1[0-8]|[1-9])|C(?:1[0-8]|[1-9])|D(?:1[0-8]|[1-9])|E(?:1[0-8]|[1-9])|F(?:1[0-8]|[1-9])|G(?:1[0-8]|[1-9])|H(?:1[0-8]|[1-9])|I(?:1[0-8]|[1-9])|J(?:1[0-8]|[1-9]))(?:$|[^0-9])/); return match?.[1] || ''; }
function markAttendance(rawCode, method = 'QR Code') {
  const error = $('#attendanceScanError');
  const code = extractSeatCode(rawCode);
  const config = getAttendanceConfig();
  const activeSessionId = config.sessionId || config.id;
  const status = getAttendanceWindowStatus(config);
  const fail = (message) => { if (error) error.textContent = message; else window.alert(message); };
  if (!status.allowed) { fail(status.message); return false; }
  if (!code || !seatCodeSet.has(code)) { fail('ไม่พบรหัสที่นั่ง กรุณาใช้รหัส A1–J18'); return false; }
  const records = getAttendanceRecords();
  const attendance = records[activeSessionId] || {};
  if (attendance[code]) { fail(`ที่นั่ง ${code} เช็คชื่อแล้วเมื่อ ${new Date(attendance[code].time).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})} น.`); return false; }
  attendance[code] = { status:'มา', time:new Date().toISOString(), method };
  records[activeSessionId] = attendance;
  localStorage.setItem(ATTENDANCE_RECORDS_KEY, JSON.stringify(records));
  attendanceViewingSessionId = activeSessionId;
  renderSeatMap();
  if (error) { error.classList.add('success-message'); error.textContent = `บันทึกที่นั่ง ${code} เรียบร้อยแล้ว`; }
  $('#manualSeatForm')?.reset();
  return true;
}
function renderSeatMap() {
  const attendance = getAttendance();
  const map = $('#seatMap');
  if (!map) return;
  map.innerHTML = seatCodes.map((seat) => `<span class="seat ${attendance[seat] ? 'present' : 'absent'}" title="${attendance[seat] ? `เช็คชื่อ ${new Date(attendance[seat].time).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})} น. · ${attendance[seat].method || 'ระบบเดิม'}` : 'ยังไม่มา'}">${seat}</span>`).join('');
  const present = Object.keys(attendance).length;
  $('#attendanceSummary').textContent = `มา ${present} / ${seatCodes.length}`;
}
async function openAttendanceScanner() {
  const status = getAttendanceWindowStatus();
  const dialog = $('#attendanceScanDialog');
  const error = $('#attendanceScanError');
  error.classList.remove('success-message'); error.textContent = '';
  dialog.showModal();
  $('#manualSeatCode').focus();
  if (!status.allowed) { error.textContent = status.message; $('#attendanceCameraMessage').textContent = 'กล้องจะเปิดได้เมื่อถึงเวลาเช็คชื่อ'; return; }
  await startAttendanceCamera();
}
async function startAttendanceCamera() {
  const video = $('#attendanceCamera');
  const message = $('#attendanceCameraMessage');
  if (!navigator.mediaDevices?.getUserMedia) { message.textContent = 'อุปกรณ์นี้ไม่รองรับกล้อง กรุณาพิมพ์รหัสด้านล่าง'; return; }
  if (!('BarcodeDetector' in window)) { message.textContent = 'เบราว์เซอร์นี้ไม่รองรับการอ่าน QR กรุณาใช้ Chrome/Edge หรือพิมพ์รหัส'; return; }
  try {
    attendanceCameraStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 } }, audio:false });
    video.srcObject = attendanceCameraStream;
    await video.play();
    message.textContent = 'วาง QR Code ให้อยู่กลางกรอบ';
    const detector = new BarcodeDetector({ formats:['qr_code'] });
    const detect = async () => {
      if (!attendanceCameraStream || !$('#attendanceScanDialog')?.open) return;
      try { const codes = await detector.detect(video); if (codes[0] && markAttendance(codes[0].rawValue, 'QR Code')) { message.textContent = 'สแกนสำเร็จ'; window.setTimeout(closeAttendanceScanner, 650); return; } } catch (_) {}
      attendanceScanTimer = window.setTimeout(detect, 280);
    };
    detect();
  } catch (error) { message.textContent = error.name === 'NotAllowedError' ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง กรุณาอนุญาตกล้องหรือพิมพ์รหัส' : 'เปิดกล้องไม่สำเร็จ กรุณาพิมพ์รหัสที่นั่งแทน'; }
}
function stopAttendanceCamera() { window.clearTimeout(attendanceScanTimer); attendanceScanTimer = 0; attendanceCameraStream?.getTracks().forEach((track) => track.stop()); attendanceCameraStream = null; const video = $('#attendanceCamera'); if (video) video.srcObject = null; }
function closeAttendanceScanner() { stopAttendanceCamera(); $('#attendanceScanDialog')?.close(); }

const adminPage = $('#admin');
if (adminPage) {
  let adminPointerFrame = 0;
  let adminPointerX = 0;
  let adminPointerY = 0;
  let adminBounds = null;
  const cacheAdminBounds = () => { adminBounds = adminPage.getBoundingClientRect(); };
  const updateAdminPointer = () => {
    adminPointerFrame = 0;
    if (!adminBounds) cacheAdminBounds();
    adminPage.style.setProperty('--pointer-x', `${adminPointerX - adminBounds.left}px`);
    adminPage.style.setProperty('--pointer-y', `${adminPointerY - adminBounds.top}px`);
    adminPage.style.setProperty('--tilt-x', `${((adminPointerX / window.innerWidth) - .5) * 10}deg`);
    adminPage.style.setProperty('--tilt-y', `${((adminPointerY / window.innerHeight) - .5) * -8}deg`);
  };
  adminPage.addEventListener('pointerenter', cacheAdminBounds, { passive: true });
  adminPage.addEventListener('pointermove', (event) => {
    adminPointerX = event.clientX;
    adminPointerY = event.clientY;
    if (!adminPointerFrame) adminPointerFrame = requestAnimationFrame(updateAdminPointer);
  }, { passive: true });
  window.addEventListener('resize', () => { adminBounds = null; }, { passive: true });
  window.addEventListener('scroll', () => { adminBounds = null; }, { passive: true });
  const adminMotionObserver = new IntersectionObserver(([entry]) => {
    adminPage.classList.toggle('admin-offscreen', !entry.isIntersecting);
  }, { rootMargin: '180px 0px' });
  adminMotionObserver.observe(adminPage);
}
const syncDocumentActivity = () => document.documentElement.classList.toggle('page-inactive', document.hidden);
document.addEventListener('visibilitychange', syncDocumentActivity, { passive: true });
syncDocumentActivity();

const optimizeImages = (root = document) => {
  const images = root.matches?.('img') ? [root] : root.querySelectorAll?.('img') || [];
  images.forEach((image) => {
    image.decoding = 'async';
    if (!image.hasAttribute('loading')) image.loading = 'lazy';
  });
};
optimizeImages();
new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
  if (node.nodeType === Node.ELEMENT_NODE) optimizeImages(node);
}))).observe(document.body, { childList: true, subtree: true });

const animationVisibilityObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => entry.target.classList.toggle('perf-offscreen', !entry.isIntersecting));
}, { rootMargin: '240px 0px' });
const registerAnimatedRegions = (root = document) => {
  const selector = '.page section,.page header,.page footer,.page > .hero,.page > .title,.page > [id]';
  const regions = root.matches?.(selector) ? [root] : root.querySelectorAll?.(selector) || [];
  regions.forEach((region) => {
    if (region.dataset.perfObserved) return;
    region.dataset.perfObserved = 'true';
    animationVisibilityObserver.observe(region);
  });
};
registerAnimatedRegions();
new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => {
  if (node.nodeType === Node.ELEMENT_NODE) registerAnimatedRegions(node);
}))).observe(document.querySelector('main'), { childList: true, subtree: true });
function renderGalleryPage() { const host = $('#galleryPageContent'); const gallery = JSON.parse(localStorage.getItem('phanuang-gallery') || '{"images":[],"driveUrl":""}'); if (!gallery.images.length) { host.innerHTML = '<div class="gallery-empty page-empty">ยังไม่มีรูปภาพกิจกรรม<br><small>พี่สตาฟสามารถเพิ่มรูปภาพได้ที่ ADMIN → รูปภาพกิจกรรม</small></div>'; return; } const sourceImages = gallery.images.slice(0, 25); const images = Array.from({ length: 25 }, (_, index) => sourceImages[index % sourceImages.length]); host.innerHTML = `<div class="moment-wall" aria-label="ผนังรูปภาพกิจกรรม">${images.map((image, index) => `<figure class="moment-tile" style="--delay:${(index % 7) * -.7}s;--duration:${8 + (index % 5) * .8}s"><img src="${image}" alt="ภาพกิจกรรม ${index + 1}"></figure>`).join('')}<div class="gallery-center"><strong>PHUNRUEANG<br>MOMENTS</strong>${gallery.driveUrl ? `<a href="${gallery.driveUrl}" target="_blank" rel="noopener">ดูรูปภาพกิจกรรม <b>→</b></a>` : '<span class="gallery-link-disabled">ดูรูปภาพกิจกรรม <b>→</b></span>'}</div></div>`; const button = host.querySelector('.gallery-center a'); if (button) { const playButtonEffect = () => { const center = button.closest('.gallery-center'); center.classList.remove('is-pressed'); void center.offsetWidth; center.classList.add('is-pressed'); window.setTimeout(() => center.classList.remove('is-pressed'), 750); }; button.addEventListener('pointerdown', playButtonEffect); button.addEventListener('click', playButtonEffect); button.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') playButtonEffect(); }); } }

// Sports results — the public page and admin panel share this single local data source.
const SPORTS_KEY = 'phanuang-sports-results-v1';
const SPORT_COLORS = ['สีเหลือง','สีแดง','สีเขียว','สีฟ้า','สีม่วง','สีชมพู'];
const defaultSportsData = [
  {id:'football',date:'2026-08-01',name:'ฟุตบอล',icon:'⚽',venue:'สนามฟุตบอล',status:'live',yellowRank:0,matches:[{round:'รอบรองชนะเลิศ',a:'สีเหลือง',b:'สีแดง',scoreA:'2',scoreB:'1',winner:'สีเหลือง'},{round:'รอบรองชนะเลิศ',a:'สีฟ้า',b:'สีเขียว',scoreA:'0',scoreB:'1',winner:'สีเขียว'},{round:'รอบชิงชนะเลิศ',a:'สีเหลือง',b:'สีเขียว',scoreA:'-',scoreB:'-',winner:''}]},
  {id:'badminton',date:'2026-08-01',name:'แบดมินตัน',icon:'🏸',venue:'โรงยิม',status:'finished',yellowRank:1,matches:[{round:'รอบรองชนะเลิศ',a:'สีเหลือง',b:'สีม่วง',scoreA:'2',scoreB:'0',winner:'สีเหลือง'},{round:'รอบชิงชนะเลิศ',a:'สีเหลือง',b:'สีแดง',scoreA:'2',scoreB:'1',winner:'สีเหลือง'}]},
  {id:'basketball',date:'2026-08-02',name:'บาสเกตบอล',icon:'🏀',venue:'สนาม 2',status:'upcoming',yellowRank:0,matches:[{round:'รอบแรก',a:'สีเหลือง',b:'สีฟ้า',scoreA:'-',scoreB:'-',winner:''}]},
  {id:'volleyball',date:'2026-08-03',name:'วอลเลย์บอล',icon:'🏐',venue:'อาคารกีฬา',status:'finished',yellowRank:3,matches:[{round:'ชิงอันดับ 3',a:'สีเหลือง',b:'สีชมพู',scoreA:'2',scoreB:'0',winner:'สีเหลือง'}]}
];
function getSportsData(){ try { const raw=localStorage.getItem(SPORTS_KEY); if(raw===null)return defaultSportsData; const value=JSON.parse(raw); return Array.isArray(value)?value:defaultSportsData; } catch(_){ return defaultSportsData; } }
function saveSportsData(data){ data.forEach(s=>s.matches.forEach(m=>{ if(m.winner.startsWith('ชนะ: ')) m.winner=m.winner.replace('ชนะ: ',''); })); localStorage.setItem(SPORTS_KEY,JSON.stringify(data)); }
function thaiSportDate(value){ return new Date(`${value}T12:00:00`).toLocaleDateString('th-TH',{weekday:'short',day:'numeric',month:'short',year:'numeric'}); }
function medalFor(rank){ return rank===1?['🥇','เหรียญทอง','CHAMPION']:rank===2?['🥈','เหรียญเงิน','RUNNER-UP']:rank===3?['🥉','เหรียญทองแดง','THIRD PLACE']:['🏅',`อันดับที่ ${rank}`,'FINAL RESULT']; }
function legacyRenderSportsPage(selectedDate){
  const host=$('#sportsContent'), data=getSportsData();
  const dates=[...new Set(data.map(s=>s.date))].sort(); const active=dates.includes(selectedDate)?selectedDate:dates[0]; const sports=data.filter(s=>s.date===active);
  const finished=sports.filter(s=>s.status==='finished'&&s.yellowRank); const live=sports.filter(s=>s.status==='live').length;
  const medals=data.filter(s=>s.status==='finished'&&s.yellowRank); const gold=medals.filter(s=>s.yellowRank===1).length, silver=medals.filter(s=>s.yellowRank===2).length, bronze=medals.filter(s=>s.yellowRank===3).length;
  host.innerHTML=`<header class="olympus-hero"><div class="hero-energy" aria-hidden="true"><i></i><i></i><i></i></div><button class="sports-back" data-page="home">← กลับสู่พันเรือง</button><div class="ceremony-copy"><div class="greek-overline"><span></span> ΑΘΗΝΑ MMXXVI <span></span></div><div class="olympic-flame"><i></i><b>✦</b></div><h1><small>PHUNRUEANG</small><strong>มหกรรม<br><em>แห่งชัยชนะ</em></strong></h1><p>ทุกสนามคือประวัติศาสตร์ · ทุกชัยชนะคือพลังของเรา</p><div class="live-command"><i></i><b>${live?'LIVE NOW':'OFFICIAL RESULTS'}</b><span>${thaiSportDate(active)}</span></div></div><div class="hero-scroll"><i></i><span>เลื่อนเพื่อเข้าสู่สนาม</span></div></header>
  <section class="medal-command"><div class="medal-command-title"><small>TEAM YELLOW · MEDAL COMMAND</small><h2>เกียรติยศของพันเรือง</h2><p>ตารางเหรียญสะสมจากผลการแข่งขันที่ประกาศอย่างเป็นทางการ</p></div><div class="medal-podium"><div class="podium-medal silver"><span>🥈</span><b>${silver}</b><small>เงิน</small></div><div class="podium-medal gold"><div class="crown-rays"></div><span>🥇</span><b>${gold}</b><small>ทอง</small></div><div class="podium-medal bronze"><span>🥉</span><b>${bronze}</b><small>ทองแดง</small></div></div><div class="medal-total"><b>${medals.length}</b><span>ผลงาน<br>ที่จบแล้ว</span></div></section>
  ${finished.length?`<section class="hall-of-glory"><div class="glory-heading"><small>HALL OF GLORY</small><h2>ประกาศเกียรติยศ</h2><span>ผลการแข่งขันของสีเหลืองประจำวันนี้</span></div><div class="glory-track">${finished.map((s,i)=>{const m=medalFor(s.yellowRank);return `<article class="glory-card rank-${s.yellowRank}" style="--order:${i}"><div class="glory-shine"></div><div class="glory-sport"><span>${s.icon}</span>${escapeHTML(s.name)}</div><div class="glory-medal">${m[0]}</div><small>${m[2]}</small><h3>${m[1]}</h3><p>สีเหลือง · ผลอย่างเป็นทางการ</p><div class="glory-laurel">❧　❧</div></article>`}).join('')}</div></section>`:''}
  <section class="arena-control"><div class="arena-header"><div><small>OLYMPIC ARENA · DAILY PROGRAM</small><h2>ตารางศึกประจำวัน</h2></div><div class="arena-live"><i></i><span>ผลการแข่งขัน<br><b>ซิงค์จากสนาม</b></span></div></div><div class="date-rail">${dates.map((d,i)=>`<button class="sport-date ${d===active?'active':''}" data-date="${d}" style="--i:${i}"><small>${new Date(`${d}T12:00`).toLocaleDateString('th-TH',{weekday:'short'})}</small><b>${new Date(`${d}T12:00`).getDate()}</b><span>${new Date(`${d}T12:00`).toLocaleDateString('th-TH',{month:'short'})}</span><i></i></button>`).join('')}</div><div class="active-date"><span></span><b>${thaiSportDate(active)}</b><em>${sports.length} สนามแข่งขัน</em></div><div class="sport-list">${sports.map((s,i)=>renderSportCard(s,i)).join('')}</div></section>
  <footer class="sports-closing"><div class="closing-mark">PR</div><div><small>ONE HEART · ONE GLORY</small><b>พันเรืองไม่เคยหยุดเปล่งประกาย</b></div><span>ΑΘΗΝΑ · 2026</span></footer>`;
  host.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));
  host.querySelectorAll('.sport-date').forEach(b=>b.addEventListener('click',()=>renderSportsPage(b.dataset.date)));
  initializeOlympicMotion();
}
function initializeOlympicMotion(){
  const page=$('#sports'), world=$('#olympicLivingWorld'); if(!page||!world)return;
  const hero=page.querySelector('.olympus-hero');
  if(hero&&!hero.querySelector('.wow-stage-effects')){const effects=document.createElement('div');effects.className='wow-stage-effects';effects.setAttribute('aria-hidden','true');effects.innerHTML=`<div class="victory-wings"><i></i><i></i></div><div class="energy-gate"><i></i><i></i><i></i><b>✦</b></div><div class="hero-gold-dust">${'<i></i>'.repeat(28)}</div><div class="ceremony-wave wave-one"></div><div class="ceremony-wave wave-two"></div>`;hero.appendChild(effects);}
  if(!world.dataset.motionBound){
    world.dataset.motionBound='true';
    let motionFrame=0,motionX=0,motionY=0;
    page.addEventListener('pointermove',(event)=>{motionX=event.clientX;motionY=event.clientY;if(motionFrame)return;motionFrame=requestAnimationFrame(()=>{motionFrame=0;if(!page.classList.contains('active'))return;const x=(motionX/window.innerWidth-.5),y=(motionY/window.innerHeight-.5);world.style.setProperty('--motion-x',`${x*28}px`);world.style.setProperty('--motion-y',`${y*20}px`);});},{passive:true});
    page.addEventListener('pointerleave',()=>{world.style.setProperty('--motion-x','0px');world.style.setProperty('--motion-y','0px');});
  }
  if(!world.dataset.scrollBound){world.dataset.scrollBound='true';let ticking=false;const update=()=>{const y=window.scrollY;page.style.setProperty('--sport-scroll',`${y}px`);page.style.setProperty('--hero-parallax',`${y*.09}px`);page.style.setProperty('--copy-parallax',`${y*.055}px`);page.style.setProperty('--sport-progress',Math.min(1,y/900));ticking=false;};window.addEventListener('scroll',()=>{if(!page.classList.contains('active')||ticking)return;ticking=true;requestAnimationFrame(update);},{passive:true});update();}
  const reveal=new IntersectionObserver((entries)=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('olympic-revealed');reveal.unobserve(entry.target);}}),{threshold:.13});
  page.querySelectorAll('.medal-command,.hall-of-glory,.sport-result-card,.sports-closing').forEach(element=>reveal.observe(element));
}
function renderSportCard(s,index=0){ const status=s.status==='finished'?'จบการแข่งขัน':s.status==='live'?'กำลังแข่งขัน':'ยังไม่เริ่ม'; const yellowWins=s.matches.filter(m=>m.winner==='สีเหลือง').length; return `<article class="sport-result-card state-${s.status}" style="--card:${index}"><div class="sport-card-index">${String(index+1).padStart(2,'0')}</div><header><div class="sport-emblem"><i></i>${s.icon}</div><div><small>${escapeHTML(s.venue)} · ARENA ${String(index+1).padStart(2,'0')}</small><h3>${escapeHTML(s.name)}</h3></div><span class="sport-status ${s.status}"><i></i>${status}</span></header><div class="sport-scoreline"><div><small>TEAM YELLOW</small><b>${yellowWins?`${yellowWins} WIN`:'READY'}</b></div><span>${s.status==='finished'&&s.yellowRank?medalFor(s.yellowRank)[0]:'✦'}</span><p>${s.status==='finished'&&s.yellowRank?`อันดับ ${s.yellowRank} · ${medalFor(s.yellowRank)[1]}`:s.status==='live'?'กำลังลุ้นชัยชนะไปพร้อมกัน':'เตรียมพลังให้พร้อมก่อนลงสนาม'}</p></div><div class="bracket-title"><span>TOURNAMENT PATH</span><i></i><small>${s.matches.length} คู่การแข่งขัน</small></div><div class="bracket">${s.matches.length?s.matches.map((m,i)=>`<div class="bracket-match"><div class="round-label"><span>${String(i+1).padStart(2,'0')}</span>${escapeHTML(m.round)}</div><div class="versus"><div class="team ${m.winner===m.a?'winner':''} ${m.a==='สีเหลือง'?'our-team':''}"><i></i><span>${escapeHTML(m.a)}</span><b>${escapeHTML(m.scoreA)}</b>${m.winner===m.a?'<em>ชนะ</em>':''}</div><div class="vs-mark">VS</div><div class="team ${m.winner===m.b?'winner':''} ${m.b==='สีเหลือง'?'our-team':''}"><i></i><span>${escapeHTML(m.b)}</span><b>${escapeHTML(m.scoreB)}</b>${m.winner===m.b?'<em>ชนะ</em>':''}</div></div>${i<s.matches.length-1?'<div class="path-arrow">→</div>':''}</div>`).join(''):'<div class="empty-bracket">ยังไม่มีการประกบคู่แข่งขัน</div>'}</div></article>`; }
function legacyRenderSportsAdmin(host){
  let data=getSportsData().map(s=>({...s,matches:s.matches.map(m=>({...m}))}));
  host.innerHTML=`<div class="admin-panel sports-admin"><div class="panel-heading"><div><small>ARENA CONTROL · LIVE SYNC</small><h3>อัปเดตผลกีฬา</h3><p>เลือกกีฬา กรอกคะแนน และผู้ชนะ — หน้าสรุปผลจะใช้ข้อมูลชุดนี้ทันที</p></div><button class="primary" id="addSport">＋ เพิ่มกีฬา</button></div><div class="sports-admin-guide"><span><b>1</b> เลือกสถานะ</span><i>→</i><span><b>2</b> ใส่คะแนน/ผู้ชนะ</span><i>→</i><span><b>3</b> ระบุอันดับสีเหลือง</span><i>→</i><span><b>4</b> บันทึกและซิงค์</span></div><div id="sportAdminRows"></div><div class="sports-admin-savebar"><span id="sportSaveState">การแก้ไขยังไม่ถูกบันทึก</span><button class="primary" id="saveSports">บันทึกและเผยแพร่ผล <b>→</b></button></div></div>`;
  const draw=()=>{ $('#sportAdminRows').innerHTML=data.map((s,si)=>`<section class="sport-editor" data-si="${si}"><div class="sport-editor-head"><span class="sport-emblem">${s.icon}</span><input data-field="name" value="${escapeAttribute(s.name)}" aria-label="ชื่อกีฬา"><input type="date" data-field="date" value="${s.date}"><select data-field="status"><option value="upcoming" ${s.status==='upcoming'?'selected':''}>ยังไม่เริ่ม</option><option value="live" ${s.status==='live'?'selected':''}>กำลังแข่ง</option><option value="finished" ${s.status==='finished'?'selected':''}>จบแล้ว</option></select><label>อันดับสีเหลือง <input type="number" min="0" max="9" data-field="yellowRank" value="${s.yellowRank||0}"></label><button class="sport-delete" data-delete="${si}">×</button></div><div class="match-editor-list">${s.matches.map((m,mi)=>`<div class="match-editor"><input data-match="${mi}" data-mf="round" value="${escapeAttribute(m.round)}" aria-label="รอบ"><select data-match="${mi}" data-mf="a">${SPORT_COLORS.map(c=>`<option ${c===m.a?'selected':''}>${c}</option>`).join('')}</select><input data-match="${mi}" data-mf="scoreA" value="${escapeAttribute(m.scoreA)}" aria-label="คะแนนทีมแรก"><b>VS</b><select data-match="${mi}" data-mf="b">${SPORT_COLORS.map(c=>`<option ${c===m.b?'selected':''}>${c}</option>`).join('')}</select><input data-match="${mi}" data-mf="scoreB" value="${escapeAttribute(m.scoreB)}" aria-label="คะแนนทีมสอง"><select data-match="${mi}" data-mf="winner"><option value="">ยังไม่มีผู้ชนะ</option>${SPORT_COLORS.map(c=>`<option ${c===m.winner?'selected':''}>ชนะ: ${c}</option>`).join('')}</select><button data-remove-match="${mi}">×</button></div>`).join('')}</div><button class="mini add-match">＋ เพิ่มคู่แข่งขัน</button></section>`).join(''); bind(); };
  const bind=()=>{ document.querySelectorAll('.sport-editor').forEach(section=>{const si=+section.dataset.si; section.querySelectorAll('[data-field]').forEach(el=>el.addEventListener('input',()=>{data[si][el.dataset.field]=el.type==='number'?+el.value:el.value;$('#sportSaveState').textContent='มีการแก้ไขที่ยังไม่บันทึก';}));section.querySelectorAll('[data-match]').forEach(el=>el.addEventListener('input',()=>{data[si].matches[+el.dataset.match][el.dataset.mf]=el.value;}));section.querySelector('.add-match').addEventListener('click',()=>{data[si].matches.push({round:'รอบแรก',a:'สีเหลือง',b:'สีแดง',scoreA:'-',scoreB:'-',winner:''});draw();});section.querySelectorAll('[data-remove-match]').forEach(b=>b.addEventListener('click',()=>{data[si].matches.splice(+b.dataset.removeMatch,1);draw();}));section.querySelector('[data-delete]').addEventListener('click',()=>{if(confirm(`ลบกีฬา ${data[si].name} ใช่หรือไม่?`)){data.splice(si,1);draw();}});});};
  $('#addSport').addEventListener('click',()=>{data.push({id:`sport-${Date.now()}`,date:new Date().toISOString().slice(0,10),name:'กีฬาใหม่',icon:'🏆',venue:'สนามกีฬา',status:'upcoming',yellowRank:0,matches:[]});draw();});
  $('#saveSports').addEventListener('click',()=>{saveSportsData(data);$('#sportSaveState').textContent='✓ บันทึกและซิงค์ไปหน้าสรุปผลแล้ว';$('#sportSaveState').classList.add('saved');}); draw();
}

/* Sports v3 — sport-centric brackets, multi-day matches and configurable awards. */
function normalizeSportsData(){
  return getSportsData().map((sport,index)=>({
    ...sport,
    id:sport.id||`sport-${index}`,
    rewardType:sport.rewardType||'medal',
    competitionFormat:sport.competitionFormat||'',
    gender:sport.gender||'',
    schoolLevel:sport.schoolLevel||'',
    eventType:sport.eventType||'',
    customEvent:sport.customEvent||'',
    matches:(sport.matches||[]).map(match=>({...match,date:match.date||sport.date||''}))
  }));
}
function sportDateRange(sport){ const dates=[...new Set(sport.matches.map(m=>m.date).filter(Boolean))].sort(); if(!dates.length)return 'ยังไม่กำหนดวันแข่งขัน'; if(dates.length===1)return thaiSportDate(dates[0]); return `${thaiSportDate(dates[0])} — ${thaiSportDate(dates.at(-1))}`; }
function awardForSport(sport){ if(!sport.yellowRank)return ['✦','รอผล','PENDING']; if(sport.rewardType==='trophy'&&sport.yellowRank===1)return ['🏆','ถ้วยชนะเลิศ','CHAMPIONS CUP']; return medalFor(sport.yellowRank); }
function renderSportsPage(selectedSportId){
  const host=$('#sportsContent'),data=normalizeSportsData(); if(!data.length){host.innerHTML=`<section class="sports-empty olympic-empty"><div class="empty-rays"></div><div class="empty-columns"><i></i><i></i><i></i><i></i></div><div class="empty-seal"><span>✦</span><i></i></div><small>THE ARENA AWAITS · ΑΘΗΝΑ MMXXVI</small><h2>สนามแห่งชัยชนะ<br><em>กำลังรอการเปิดฉาก</em></h2><p>ยังไม่มีรายการแข่งขันในขณะนี้<br>เมื่อผู้ดูแลเพิ่มกีฬา ผลการแข่งขันจะปรากฏที่นี่ทันที</p><div class="empty-status"><i></i> WAITING FOR TOURNAMENT DATA</div><button type="button" data-empty-home>← กลับสู่หน้าหลัก</button></section>`;host.querySelector('[data-empty-home]').addEventListener('click',()=>showPage('home'));return;}
  const selected=data.find(s=>s.id===selectedSportId)||data.find(s=>s.status==='live')||data[0];
  const completed=data.filter(s=>s.status==='finished'&&s.yellowRank), cups=completed.filter(s=>s.rewardType==='trophy'&&s.yellowRank===1).length;
  const gold=completed.filter(s=>s.rewardType!=='trophy'&&s.yellowRank===1).length, silver=completed.filter(s=>s.yellowRank===2).length, bronze=completed.filter(s=>s.yellowRank===3).length;
  host.innerHTML=`<header class="olympus-hero sportcentric-hero"><div class="hero-energy" aria-hidden="true"><i></i><i></i><i></i></div><button class="sports-back" data-page="home">← กลับสู่พันเรือง</button><div class="ceremony-copy"><div class="greek-overline"><span></span> ΑΘΗΝΑ MMXXVI <span></span></div><div class="olympic-flame"><i></i><b>✦</b></div><h1><small>PHUNRUEANG</small><strong>เส้นทาง<br><em>แห่งชัยชนะ</em></strong></h1><p>เลือกชนิดกีฬา แล้วติดตามทุกคู่ ทุกวัน และทุกรอบการแข่งขันในผังเดียว</p></div><div class="hero-scroll"><i></i><span>เลือกสนามของคุณ</span></div></header>
  <section class="medal-command award-command"><div class="medal-command-title"><small>TEAM YELLOW · HONOUR BOARD</small><h2>เกียรติยศของพันเรือง</h2><p>สรุปรางวัลอย่างเป็นทางการจากทุกชนิดกีฬา</p></div><div class="award-totals"><div class="award-chip cup"><span>🏆</span><b>${cups}</b><small>ถ้วย</small></div><div class="award-chip gold"><span>🥇</span><b>${gold}</b><small>ทอง</small></div><div class="award-chip silver"><span>🥈</span><b>${silver}</b><small>เงิน</small></div><div class="award-chip bronze"><span>🥉</span><b>${bronze}</b><small>ทองแดง</small></div></div><div class="medal-total"><b>${completed.length}</b><span>กีฬาที่<br>สรุปผลแล้ว</span></div></section>
  <section class="sport-explorer"><header class="explorer-heading"><div><small>CHOOSE YOUR ARENA</small><h2>เลือกดูกีฬา</h2><p>ผลทุกวันของกีฬาเดียวกันเชื่อมต่ออยู่ในสายการแข่งขันนี้</p></div><span>${data.length} ชนิดกีฬา</span></header><nav class="sport-selector" aria-label="เลือกชนิดกีฬา">${data.map((s,i)=>`<button class="sport-choice ${s.id===selected.id?'active':''}" data-sport-id="${escapeAttribute(s.id)}" style="--i:${i}"><span>${s.icon}</span><div><b>${escapeHTML(s.name)}</b><small>${s.status==='finished'?'จบการแข่งขัน':s.status==='live'?'กำลังแข่งขัน':'ยังไม่เริ่ม'}</small></div>${s.status==='live'?'<i>LIVE</i>':''}</button>`).join('')}</nav>
  <article class="selected-arena state-${selected.status}"><div class="arena-sport-head"><div class="arena-big-icon">${selected.icon}</div><div><small>${escapeHTML(selected.venue)} · COMPLETE TOURNAMENT</small><h2>${escapeHTML(selected.name)}</h2><p>${sportDateRange(selected)}</p></div><div class="arena-award ${selected.rewardType}"><small>รางวัลชนะเลิศ</small><b>${selected.rewardType==='trophy'?'🏆 ถ้วยรางวัล':'🥇 เหรียญรางวัล'}</b></div></div><div class="selected-result"><span>ผลงานสีเหลือง</span>${selected.yellowRank?`<b>${awardForSport(selected)[0]} ${awardForSport(selected)[1]}</b>`:'<b>อยู่ระหว่างการแข่งขัน</b>'}</div>${renderFullSportBracket(selected)}</article></section>
  ${completed.length?`<section class="hall-of-glory compact-glory"><div class="glory-heading"><small>OFFICIAL HONOURS</small><h2>ผลรางวัลทุกชนิดกีฬา</h2><span>ประกาศผลแล้ว ${completed.length} กีฬา</span></div><div class="glory-track">${completed.map((s,i)=>{const a=awardForSport(s);return `<article class="glory-card rank-${s.yellowRank}" style="--order:${i}"><div class="glory-sport"><span>${s.icon}</span>${escapeHTML(s.name)}</div><div class="glory-medal">${a[0]}</div><small>${a[2]}</small><h3>${a[1]}</h3><p>${s.rewardType==='trophy'&&s.yellowRank===1?'ถ้วยรางวัล':'เหรียญรางวัล'} · ผลอย่างเป็นทางการ</p><div class="glory-laurel">❧　❧</div></article>`}).join('')}</div></section>`:''}<footer class="sports-closing"><div class="closing-mark">PR</div><div><small>ONE HEART · ONE GLORY</small><b>พันเรืองไม่เคยหยุดเปล่งประกาย</b></div><span>ΑΘΗΝΑ · 2026</span></footer>`;
  const groups=[...data.reduce((map,sport)=>{if(!map.has(sport.name))map.set(sport.name,[]);map.get(sport.name).push(sport);return map;},new Map()).entries()];
  const selector=host.querySelector('.sport-selector');selector.innerHTML=groups.map(([name,items],i)=>{const groupStatus=items.some(s=>s.status==='live')?'live':items.every(s=>s.status==='finished')?'finished':'upcoming',active=items.some(s=>s.id===selected.id);return `<button class="sport-choice sport-group-choice ${active?'active':''}" data-sport-group="${escapeAttribute(name)}" style="--i:${i}"><span>${items[0].icon}</span><div><b>${escapeHTML(name)}</b><em>${items.length} ${items.length===1?'ประเภท':'ประเภทการแข่งขัน'}</em><small>${groupStatus==='live'?'กำลังแข่งขัน':groupStatus==='finished'?'จบการแข่งขัน':'ยังไม่เริ่ม'}</small></div>${groupStatus==='live'?'<i>LIVE</i>':''}</button>`}).join('');
  host.querySelector('.explorer-heading>span').textContent=`${groups.length} ชนิดกีฬา`;
  const selectedGroup=groups.find(([,items])=>items.some(s=>s.id===selected.id))?.[1]||[selected];
  const variantNav=document.createElement('div');variantNav.className='sport-variant-panel';variantNav.innerHTML=`<div class="variant-panel-label"><small>ประเภทของ ${escapeHTML(selected.name)}</small><b>เลือกประเภทการแข่งขัน</b></div><div class="sport-variant-tabs">${selectedGroup.map(s=>`<button class="sport-variant ${s.id===selected.id?'active':''}" data-sport-id="${escapeAttribute(s.id)}"><span>${sportCategoryTitle(s)||'รายการทั่วไป'}</span><small>${s.status==='live'?'● กำลังแข่ง':s.status==='finished'?'✓ จบแล้ว':'○ ยังไม่เริ่ม'}</small></button>`).join('')}</div>`;host.querySelector('.selected-arena').insertAdjacentElement('beforebegin',variantNav);
  host.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));
  host.querySelectorAll('[data-sport-group]').forEach(b=>b.addEventListener('click',()=>{const group=groups.find(([name])=>name===b.dataset.sportGroup)?.[1];if(group?.length)renderSportsPage(group[0].id);}));
  host.querySelectorAll('[data-sport-id]').forEach(b=>b.addEventListener('click',()=>renderSportsPage(b.dataset.sportId)));
  const selectedTitle=host.querySelector('.arena-sport-head h2');if(selectedTitle){selectedTitle.textContent=selected.name;const category=sportCategoryTitle(selected);if(category){const detail=document.createElement('div');detail.className='arena-category-title';detail.textContent=category;selectedTitle.insertAdjacentElement('afterend',detail);}}
  initializeOlympicMotion();
}
function renderFullSportBracket(sport){ const matches=[...sport.matches].sort((a,b)=>String(a.date).localeCompare(String(b.date))); return `<div class="full-bracket"><div class="full-bracket-title"><div><small>FULL TOURNAMENT BRACKET</small><h3>ผังการแข่งขันทั้งหมด</h3></div><span>${matches.length} คู่ · ${new Set(matches.map(m=>m.date).filter(Boolean)).size} วันแข่งขัน</span></div><div class="bracket-flow">${matches.length?matches.map((m,i)=>`<div class="bracket-node ${m.winner?'decided':''}"><div class="node-meta"><b>${escapeHTML(m.round)}</b><span>${m.date?thaiSportDate(m.date):'ยังไม่กำหนดวัน'}</span></div><div class="node-team ${m.a==='สีเหลือง'?'our-team':''} ${m.winner===m.a?'winner':''}"><span>${escapeHTML(m.a)}</span><b>${escapeHTML(m.scoreA)}</b>${m.winner===m.a?'<i>WIN</i>':''}</div><div class="node-vs">VS</div><div class="node-team ${m.b==='สีเหลือง'?'our-team':''} ${m.winner===m.b?'winner':''}"><span>${escapeHTML(m.b)}</span><b>${escapeHTML(m.scoreB)}</b>${m.winner===m.b?'<i>WIN</i>':''}</div>${i<matches.length-1?'<div class="flow-arrow">→</div>':''}</div>`).join(''):'<div class="empty-bracket">ยังไม่มีคู่แข่งขันในกีฬานี้</div>'}</div></div>`; }
function legacyV3RenderSportsAdmin(host){
  let data=normalizeSportsData().map(s=>({...s,matches:s.matches.map(m=>({...m}))}));
  host.innerHTML=`<div class="admin-panel sports-admin sport-admin-v3"><div class="panel-heading"><div><small>TOURNAMENT CONTROL · MULTI-DAY SYNC</small><h3>จัดการสายการแข่งขัน</h3><p>หนึ่งกีฬาเก็บได้หลายวัน แต่ทุกคู่จะเชื่อมอยู่ในผังเดียวกัน</p></div><button class="primary" id="addSport">＋ เพิ่มชนิดกีฬา</button></div><div class="sports-admin-guide"><span><b>1</b> ตั้งค่ากีฬา/รางวัล</span><i>→</i><span><b>2</b> เพิ่มคู่แข่งขัน</span><i>→</i><span><b>3</b> กำหนดวันแต่ละคู่</span><i>→</i><span><b>4</b> บันทึกและเผยแพร่</span></div><div id="sportAdminRows"></div><div class="sports-admin-savebar"><span id="sportSaveState">การแก้ไขยังไม่ถูกบันทึก</span><button class="primary" id="saveSports">บันทึกและเผยแพร่ผล <b>→</b></button></div></div>`;
  const draw=()=>{ $('#sportAdminRows').innerHTML=data.map((s,si)=>`<section class="sport-editor sport-editor-v3" data-si="${si}"><div class="sport-editor-title"><span class="sport-emblem">${s.icon}</span><div><small>SPORT ${String(si+1).padStart(2,'0')}</small><b>${escapeHTML(s.name)}</b></div><button class="sport-delete" data-delete="${si}">ลบกีฬา</button></div><div class="sport-config-grid"><label>ชื่อกีฬา<input data-field="name" value="${escapeAttribute(s.name)}"></label><label>สนามแข่งขัน<input data-field="venue" value="${escapeAttribute(s.venue||'')}"></label><label>สถานะ<select data-field="status"><option value="upcoming" ${s.status==='upcoming'?'selected':''}>ยังไม่เริ่ม</option><option value="live" ${s.status==='live'?'selected':''}>กำลังแข่ง</option><option value="finished" ${s.status==='finished'?'selected':''}>จบแล้ว</option></select></label><label>รางวัลอันดับ 1<select data-field="rewardType"><option value="medal" ${s.rewardType==='medal'?'selected':''}>เหรียญรางวัล</option><option value="trophy" ${s.rewardType==='trophy'?'selected':''}>ถ้วยรางวัล</option></select></label><label>อันดับสีเหลือง<input type="number" min="0" max="9" data-field="yellowRank" value="${s.yellowRank||0}"><small>0 = ยังไม่มีผล</small></label></div><div class="match-editor-heading"><div><b>คู่แข่งขันทั้งหมด</b><small>แต่ละคู่กำหนดวันแข่งแยกกันได้</small></div><button class="mini add-match">＋ เพิ่มคู่แข่งขัน</button></div><div class="match-editor-list">${s.matches.map((m,mi)=>`<div class="match-editor match-editor-v3"><label>รอบ<input data-match="${mi}" data-mf="round" value="${escapeAttribute(m.round)}"></label><label>วันที่แข่ง<input type="date" data-match="${mi}" data-mf="date" value="${m.date||''}"></label><label>ทีม A<select data-match="${mi}" data-mf="a">${SPORT_COLORS.map(c=>`<option value="${c}" ${c===m.a?'selected':''}>${c}</option>`).join('')}</select></label><label>คะแนน<input data-match="${mi}" data-mf="scoreA" value="${escapeAttribute(m.scoreA)}"></label><b>VS</b><label>ทีม B<select data-match="${mi}" data-mf="b">${SPORT_COLORS.map(c=>`<option value="${c}" ${c===m.b?'selected':''}>${c}</option>`).join('')}</select></label><label>คะแนน<input data-match="${mi}" data-mf="scoreB" value="${escapeAttribute(m.scoreB)}"></label><label>ผู้ชนะ<select data-match="${mi}" data-mf="winner"><option value="">ยังไม่มีผู้ชนะ</option>${SPORT_COLORS.map(c=>`<option value="${c}" ${c===m.winner?'selected':''}>${c}</option>`).join('')}</select></label><button data-remove-match="${mi}" aria-label="ลบคู่">×</button></div>`).join('')||'<div class="admin-empty-matches">ยังไม่มีคู่แข่งขัน · กดเพิ่มคู่แข่งขันเพื่อเริ่มสร้างผัง</div>'}</div></section>`).join('');bind();};
  const dirty=()=>{$('#sportSaveState').textContent='มีการแก้ไขที่ยังไม่บันทึก';$('#sportSaveState').classList.remove('saved');};
  const bind=()=>document.querySelectorAll('.sport-editor-v3').forEach(section=>{const si=+section.dataset.si;section.querySelectorAll('[data-field]').forEach(el=>el.addEventListener('input',()=>{data[si][el.dataset.field]=el.type==='number'?+el.value:el.value;dirty();}));section.querySelectorAll('[data-match]').forEach(el=>el.addEventListener('input',()=>{data[si].matches[+el.dataset.match][el.dataset.mf]=el.value;dirty();}));section.querySelector('.add-match').addEventListener('click',()=>{data[si].matches.push({round:'รอบแรก',date:'',a:'สีเหลือง',b:'สีแดง',scoreA:'-',scoreB:'-',winner:''});draw();dirty();});section.querySelectorAll('[data-remove-match]').forEach(b=>b.addEventListener('click',()=>{data[si].matches.splice(+b.dataset.removeMatch,1);draw();dirty();}));section.querySelector('[data-delete]').addEventListener('click',()=>{if(confirm(`ลบกีฬา ${data[si].name} ใช่หรือไม่?`)){data.splice(si,1);draw();dirty();}});});
  $('#addSport').addEventListener('click',()=>{data.push({id:`sport-${Date.now()}`,name:'กีฬาใหม่',icon:'🏆',venue:'สนามกีฬา',status:'upcoming',rewardType:'medal',yellowRank:0,matches:[]});draw();dirty();});
  $('#saveSports').addEventListener('click',()=>{saveSportsData(data);$('#sportSaveState').textContent='✓ บันทึกและเชื่อมทุกวันเข้าสู่ผังกีฬาแล้ว';$('#sportSaveState').classList.add('saved');});draw();
}

const SPORT_CATALOG=[['football','⚽','ฟุตบอล'],['futsal','🥅','ฟุตซอล'],['basketball','🏀','บาสเกตบอล'],['volleyball','🏐','วอลเลย์บอล'],['badminton','🏸','แบดมินตัน'],['table-tennis','🏓','เทเบิลเทนนิส'],['petanque','🎯','เปตอง'],['athletics','🏃','กรีฑา'],['long-jump','🦘','กระโดดไกล'],['discus','🥏','ขว้างจักร'],['swimming','🏊','ว่ายน้ำ'],['takraw','🤾','เซปักตะกร้อ'],['esports','🎮','อีสปอร์ต']];
const SPORT_ROUNDS=['รอบแบ่งกลุ่ม','รอบแรก','รอบ 16 ทีม','รอบ 8 ทีม','รอบก่อนรองชนะเลิศ','รอบรองชนะเลิศ','ชิงอันดับ 3','รอบชิงชนะเลิศ'];
const SPORT_FORMATS=['เดี่ยว','คู่','ทีม'];
const SPORT_GENDERS=['ชาย','หญิง','ผสม'];
const SPORT_LEVELS=['ม.ต้น','ม.ปลาย'];
const SPORT_EVENTS=['ทั่วไป','วิ่ง 50 เมตร','วิ่ง 100 เมตร','วิ่ง 200 เมตร','วิ่ง 400 เมตร','วิ่ง 800 เมตร','วิ่ง 1,500 เมตร','วิ่ง 3,000 เมตร','วิ่งผลัด 4×100 เมตร','วิ่งผลัด 4×400 เมตร','กระโดดไกล','กระโดดสูง','ทุ่มน้ำหนัก','ขว้างจักร','พุ่งแหลน','เดี่ยวมือหนึ่ง','เดี่ยวมือสอง','คู่มือหนึ่ง','คู่มือสอง','ประเภททีม','อื่นๆ'];
function sportCompetitionTitle(sport){ return [sport.name,sport.eventType==='อื่นๆ'?(sport.customEvent||'รายการอื่นๆ'):sport.eventType,sport.competitionFormat,sport.gender,sport.schoolLevel].filter(Boolean).join(' · '); }
function sportCategoryTitle(sport){ return [sport.eventType==='อื่นๆ'?(sport.customEvent||'รายการอื่นๆ'):sport.eventType,sport.competitionFormat,sport.gender,sport.schoolLevel].filter(Boolean).join(' · '); }
function enhanceSportCategoryControls(data,dirty){
  document.querySelectorAll('.sport-builder-card').forEach(card=>{if(card.querySelector('.competition-category-panel'))return;const si=Number(card.dataset.si),sport=data[si],grid=card.querySelector('.quick-config-grid');if(!sport||!grid)return;const panel=document.createElement('div');panel.className='competition-category-panel';panel.innerHTML=`<div class="category-panel-title"><span>ประเภทการแข่งขัน</span><b id="competitionPreview${si}">${escapeHTML(sportCompetitionTitle(sport)||sport.name)}</b></div><div class="category-control-grid"><label><span>รูปแบบ</span><select data-category="competitionFormat"><option value="">ไม่ระบุ</option>${SPORT_FORMATS.map(value=>`<option value="${value}" ${sport.competitionFormat===value?'selected':''}>${value}</option>`).join('')}</select></label><label><span>รุ่น / เพศ</span><select data-category="gender"><option value="">ไม่ระบุ</option>${SPORT_GENDERS.map(value=>`<option value="${value}" ${sport.gender===value?'selected':''}>${value}</option>`).join('')}</select></label><label><span>รายการย่อย</span><select data-category="eventType">${SPORT_EVENTS.map(value=>`<option value="${value}" ${sport.eventType===value?'selected':''}>${value}</option>`).join('')}</select></label><label class="custom-event-field" ${sport.eventType==='อื่นๆ'?'':'hidden'}><span>ชื่อรายการอื่นๆ</span><input data-category="customEvent" value="${escapeAttribute(sport.customEvent||'')}" placeholder="เช่น วิ่งวิบาก 2,000 เมตร"></label></div>`;grid.insertAdjacentElement('afterend',panel);panel.querySelectorAll('[data-category]').forEach(input=>input.addEventListener('input',()=>{sport[input.dataset.category]=input.value;const custom=panel.querySelector('.custom-event-field');custom.hidden=sport.eventType!=='อื่นๆ';panel.querySelector(`#competitionPreview${si}`).textContent=sportCompetitionTitle(sport)||sport.name;dirty();}));});
}
function enhanceSportLevelControls(data,dirty){document.querySelectorAll('.sport-builder-card').forEach(card=>{const panel=card.querySelector('.competition-category-panel');if(!panel||panel.querySelector('[data-category="schoolLevel"]'))return;const si=Number(card.dataset.si),sport=data[si],label=document.createElement('label');label.className='school-level-field';label.innerHTML=`<span>ระดับชั้น</span><select data-category="schoolLevel"><option value="">ไม่ระบุ</option>${SPORT_LEVELS.map(value=>`<option value="${value}" ${sport.schoolLevel===value?'selected':''}>${value}</option>`).join('')}</select>`;panel.querySelector('.category-control-grid').appendChild(label);label.querySelector('select').addEventListener('input',event=>{sport.schoolLevel=event.target.value;panel.querySelector(`#competitionPreview${si}`).textContent=sportCompetitionTitle(sport)||sport.name;dirty();});});}
function updateTournamentSummary(data){const values=[data.length,data.reduce((total,sport)=>total+sport.matches.length,0),data.filter(sport=>sport.status==='live').length,data.filter(sport=>sport.status==='finished').length];document.querySelectorAll('.builder-summary span b').forEach((node,index)=>{node.textContent=values[index]??0;});}
function renderSportsAdmin(host){
  let data=normalizeSportsData().map(s=>({...s,matches:s.matches.map(m=>({...m}))}));
  host.innerHTML=`<div class="admin-panel sports-admin tournament-builder"><div class="panel-heading tournament-heading"><div><small>TOURNAMENT BUILDER · EASY MODE</small><h3>จัดการผลกีฬา</h3><p>เลือกกีฬา → สร้างคู่แข่งขัน → ใส่ผล → เผยแพร่ ทุกอย่างอยู่ในหน้าจอเดียว</p></div><button class="primary catalog-launch" id="addSport"><span>＋</span> เพิ่มชนิดกีฬา</button></div><div class="builder-steps"><div class="done"><b>1</b><span>เลือกกีฬา<small>พร้อมไอคอน</small></span></div><i></i><div><b>2</b><span>สร้างสาย<small>เลือกชื่อรอบ</small></span></div><i></i><div><b>3</b><span>บันทึกผล<small>คะแนนและผู้ชนะ</small></span></div><i></i><div><b>4</b><span>เผยแพร่<small>ซิงค์หน้าหลัก</small></span></div></div><div class="builder-summary"><span><b>${data.length}</b> ชนิดกีฬา</span><span><b>${data.reduce((n,s)=>n+s.matches.length,0)}</b> คู่แข่งขัน</span><span><b>${data.filter(s=>s.status==='live').length}</b> กำลังแข่งขัน</span><span><b>${data.filter(s=>s.status==='finished').length}</b> จบแล้ว</span></div><div id="sportAdminRows" class="tournament-sport-list"></div><div class="sports-admin-savebar builder-savebar"><div><i></i><span id="sportSaveState">พร้อมแก้ไขข้อมูล</span></div><button class="primary" id="saveSports">เผยแพร่ผลการแข่งขัน <b>→</b></button></div></div><dialog class="sport-catalog-dialog" id="sportCatalogDialog"><header><div><small>SPORT CATALOG</small><h3>เลือกชนิดกีฬา</h3><p>ระบบจะใส่ชื่อและไอคอนให้ทันที แก้ไขภายหลังได้</p></div><button type="button" data-close-catalog>×</button></header><div class="sport-catalog-grid">${SPORT_CATALOG.map(([id,icon,name])=>`<button type="button" data-sport-template="${id}" data-icon="${icon}" data-name="${name}"><span>${icon}</span><b>${name}</b><small>เพิ่มเข้าสู่รายการ →</small></button>`).join('')}</div></dialog>`;
  const dirty=()=>{const state=$('#sportSaveState');state.textContent='มีการแก้ไขที่ยังไม่เผยแพร่';state.closest('div').classList.add('dirty');};
  const categoryObserver=new MutationObserver(()=>{enhanceSportCategoryControls(data,dirty);enhanceSportLevelControls(data,dirty);updateTournamentSummary(data);});
  categoryObserver.observe($('#sportAdminRows'),{childList:true});
  const roundOptions=value=>SPORT_ROUNDS.map(r=>`<option value="${r}" ${r===value?'selected':''}>${r}</option>`).join('')+(!SPORT_ROUNDS.includes(value)&&value?`<option value="${escapeAttribute(value)}" selected>${escapeHTML(value)}</option>`:'');
  const iconOptions=value=>SPORT_CATALOG.map(([,icon,name])=>`<option value="${icon}" data-sport-name="${name}" ${icon===value?'selected':''}>${icon} ${name}</option>`).join('');
  const draw=()=>{const list=$('#sportAdminRows');list.innerHTML=data.length?data.map((s,si)=>`<details class="sport-builder-card" data-si="${si}" ${si===0?'open':''}><summary><div class="builder-sport-icon">${s.icon}</div><div class="builder-sport-name"><small>SPORT ${String(si+1).padStart(2,'0')}</small><b>${escapeHTML(s.name)}</b><span>${s.matches.length} คู่ · ${sportDateRange(s)}</span></div><span class="builder-status ${s.status}"><i></i>${s.status==='live'?'กำลังแข่ง':s.status==='finished'?'จบแล้ว':'ยังไม่เริ่ม'}</span><div class="builder-progress"><b>${s.matches.filter(m=>m.winner).length}/${s.matches.length}</b><small>ลงผลแล้ว</small></div><i class="builder-chevron">⌄</i></summary><div class="sport-builder-body"><section class="quick-sport-config"><div class="builder-section-title"><span>01</span><div><b>ข้อมูลกีฬา</b><small>ตั้งค่าภาพรวมและประเภทของรางวัล</small></div></div><div class="quick-config-grid"><label class="icon-select-label"><span>ไอคอนกีฬา</span><div><strong>${s.icon}</strong><select data-field="icon">${iconOptions(s.icon)}</select></div></label><label><span>ชื่อกีฬา</span><input data-field="name" value="${escapeAttribute(s.name)}"></label><label><span>สนามแข่งขัน</span><input data-field="venue" value="${escapeAttribute(s.venue||'')}" placeholder="เช่น สนามฟุตบอล"></label><label><span>สถานะ</span><select data-field="status"><option value="upcoming" ${s.status==='upcoming'?'selected':''}>○ ยังไม่เริ่ม</option><option value="live" ${s.status==='live'?'selected':''}>● กำลังแข่งขัน</option><option value="finished" ${s.status==='finished'?'selected':''}>✓ จบการแข่งขัน</option></select></label><label><span>รางวัลอันดับ 1</span><select data-field="rewardType"><option value="medal" ${s.rewardType==='medal'?'selected':''}>🥇 เหรียญรางวัล</option><option value="trophy" ${s.rewardType==='trophy'?'selected':''}>🏆 ถ้วยรางวัล</option></select></label><label><span>อันดับของสีเหลือง</span><select data-field="yellowRank"><option value="0" ${!s.yellowRank?'selected':''}>— ยังไม่มีผล</option><option value="1" ${s.yellowRank===1?'selected':''}>อันดับ 1</option><option value="2" ${s.yellowRank===2?'selected':''}>อันดับ 2</option><option value="3" ${s.yellowRank===3?'selected':''}>อันดับ 3</option><option value="4" ${s.yellowRank===4?'selected':''}>อันดับ 4</option></select></label></div></section><section class="bracket-builder-section"><div class="builder-section-title"><span>02</span><div><b>สายการแข่งขัน</b><small>เพิ่มแต่ละคู่แล้วเลือกชื่อรอบได้ทันที</small></div><button class="mini add-match" type="button">＋ เพิ่มคู่แข่งขัน</button></div><div class="match-builder-list">${s.matches.length?s.matches.map((m,mi)=>`<article class="match-builder-row"><div class="match-number">${String(mi+1).padStart(2,'0')}</div><label class="round-picker"><span>รอบการแข่งขัน</span><select data-match="${mi}" data-mf="round">${roundOptions(m.round)}</select></label><label><span>วันที่แข่ง</span><input type="date" data-match="${mi}" data-mf="date" value="${m.date||''}"></label><div class="match-team-picker"><label><span>ทีม A</span><select data-match="${mi}" data-mf="a">${SPORT_COLORS.map(c=>`<option value="${c}" ${c===m.a?'selected':''}>${c}</option>`).join('')}</select></label><input aria-label="คะแนนทีม A" data-match="${mi}" data-mf="scoreA" value="${escapeAttribute(m.scoreA)}" placeholder="–"></div><div class="match-vs">VS</div><div class="match-team-picker"><label><span>ทีม B</span><select data-match="${mi}" data-mf="b">${SPORT_COLORS.map(c=>`<option value="${c}" ${c===m.b?'selected':''}>${c}</option>`).join('')}</select></label><input aria-label="คะแนนทีม B" data-match="${mi}" data-mf="scoreB" value="${escapeAttribute(m.scoreB)}" placeholder="–"></div><label class="winner-picker"><span>ผลการแข่งขัน</span><select data-match="${mi}" data-mf="winner"><option value="">ยังไม่จบ</option>${SPORT_COLORS.map(c=>`<option value="${c}" ${c===m.winner?'selected':''}>✓ ${c} ชนะ</option>`).join('')}</select></label><button type="button" data-remove-match="${mi}" aria-label="ลบคู่แข่งขัน">×</button></article>`).join(''):`<div class="match-builder-empty"><span>⌁</span><b>ยังไม่มีคู่แข่งขัน</b><p>กด “เพิ่มคู่แข่งขัน” เพื่อเริ่มสร้างสายของกีฬานี้</p><button class="mini add-first-match" type="button">＋ สร้างคู่แรก</button></div>`}</div></section><footer class="sport-card-actions"><button type="button" class="delete-entire-sport" data-delete="${si}">ลบชนิดกีฬานี้</button><span>การลบจะมีหน้าต่างให้ยืนยันทุกครั้ง</span></footer></div></details>`).join(''):'<div class="tournament-empty"><span>🏟️</span><h3>เริ่มสร้างมหกรรมกีฬา</h3><p>ยังไม่มีกีฬาในรายการ เลือกจากแคตตาล็อกเพื่อเริ่มต้น</p><button class="primary empty-add-sport">＋ เพิ่มชนิดกีฬา</button></div>';bind();};
  const addMatch=si=>{data[si].matches.push({round:data[si].matches.length?'รอบถัดไป':'รอบแรก',date:'',a:'สีเหลือง',b:'สีแดง',scoreA:'-',scoreB:'-',winner:''});draw();dirty();window.setTimeout(()=>{const card=document.querySelector(`[data-si="${si}"]`);card.open=true;card.querySelector('.match-builder-row:last-child')?.scrollIntoView({behavior:'smooth',block:'center'});},0);};
  const bind=()=>document.querySelectorAll('.sport-builder-card').forEach(card=>{const si=+card.dataset.si;card.querySelectorAll('[data-field]').forEach(el=>el.addEventListener('input',()=>{data[si][el.dataset.field]=el.dataset.field==='yellowRank'?+el.value:el.value;if(el.dataset.field==='icon'){card.querySelector('.builder-sport-icon').textContent=el.value;el.previousElementSibling.textContent=el.value;}dirty();}));card.querySelectorAll('[data-match]').forEach(el=>el.addEventListener('input',()=>{data[si].matches[+el.dataset.match][el.dataset.mf]=el.value;dirty();}));card.querySelector('.add-match')?.addEventListener('click',()=>addMatch(si));card.querySelector('.add-first-match')?.addEventListener('click',()=>addMatch(si));card.querySelectorAll('[data-remove-match]').forEach(b=>b.addEventListener('click',()=>{data[si].matches.splice(+b.dataset.removeMatch,1);draw();dirty();}));card.querySelector('[data-delete]').addEventListener('click',()=>{if(confirm(`ลบกีฬา ${data[si].name} ใช่หรือไม่?`)){data.splice(si,1);draw();dirty();}});});
  host.addEventListener('change',(event)=>{const select=event.target.closest('[data-field="icon"]');if(!select)return;const card=select.closest('.sport-builder-card'),si=Number(card.dataset.si),chosen=SPORT_CATALOG.find(([,icon])=>icon===select.value);if(!chosen)return;data[si].icon=chosen[1];data[si].name=chosen[2];const nameInput=card.querySelector('[data-field="name"]');if(nameInput)nameInput.value=chosen[2];card.querySelector('.builder-sport-name b').textContent=chosen[2];card.querySelector('.builder-sport-icon').textContent=chosen[1];select.closest('label').querySelector('span').textContent='ชนิดกีฬาและไอคอน';dirty();});
  const catalog=$('#sportCatalogDialog'),openCatalog=()=>catalog.showModal();$('#addSport').addEventListener('click',openCatalog);catalog.querySelector('[data-close-catalog]').addEventListener('click',()=>catalog.close());catalog.addEventListener('click',e=>{if(e.target===catalog)catalog.close();});catalog.querySelectorAll('[data-sport-template]').forEach(button=>button.addEventListener('click',()=>{const id=button.dataset.sportTemplate;data.push({id:`${id}-${Date.now()}`,name:button.dataset.name,icon:button.dataset.icon,venue:'',status:'upcoming',rewardType:'medal',yellowRank:0,matches:[]});catalog.close();draw();dirty();window.setTimeout(()=>document.querySelector('.sport-builder-card:last-of-type')?.scrollIntoView({behavior:'smooth',block:'start'}),0);}));
  host.addEventListener('click',e=>{if(e.target.closest('.empty-add-sport'))openCatalog();});$('#saveSports').addEventListener('click',()=>{saveSportsData(data);const state=$('#sportSaveState');state.textContent='✓ เผยแพร่ผลการแข่งขันเรียบร้อย';state.closest('div').classList.remove('dirty');});draw();
}
